import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

const READ_CHUNK_SIZE = 1024 * 1024;

export interface StableLocalFileRead {
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly mtimeMs: number;
  readonly device: number;
  readonly inode: number;
}

export async function readStableLocalFile(
  filePath: string,
  maxBytes: number,
  isCancellationRequested: () => boolean = () => false,
): Promise<StableLocalFileRead | undefined> {
  if (isCancellationRequested()) {
    return undefined;
  }
  const limit = Math.max(0, Math.floor(maxBytes));
  let pathBefore: Awaited<ReturnType<typeof lstat>>;
  try {
    pathBefore = await lstat(filePath);
  } catch {
    return undefined;
  }
  if (isCancellationRequested() || !pathBefore.isFile() || pathBefore.size > limit) {
    return undefined;
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return undefined;
  }
  try {
    const before = await handle.stat();
    if (
      isCancellationRequested() ||
      !before.isFile() ||
      before.size > limit ||
      !sameFileVersion(pathBefore, before)
    ) {
      return undefined;
    }
    const capacity = Math.min(limit + 1, before.size + 1);
    const buffer = Buffer.allocUnsafe(capacity);
    let length = 0;
    while (length < capacity) {
      if (isCancellationRequested()) {
        return undefined;
      }
      const requested = Math.min(READ_CHUNK_SIZE, capacity - length);
      const { bytesRead } = await handle.read(buffer, length, requested, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      isCancellationRequested() ||
      !after.isFile() ||
      length > limit ||
      length !== before.size ||
      !sameFileVersion(before, after)
    ) {
      return undefined;
    }
    const pathState = await lstat(filePath);
    if (
      isCancellationRequested() ||
      !pathState.isFile() ||
      !sameFileVersion(after, pathState)
    ) {
      return undefined;
    }
    return {
      bytes: buffer.subarray(0, length),
      size: after.size,
      mtimeMs: after.mtimeMs,
      device: after.dev,
      inode: after.ino,
    };
  } finally {
    await handle.close();
  }
}

export async function localFileStillMatches(
  filePath: string,
  expected: Pick<StableLocalFileRead, "size" | "mtimeMs" | "device" | "inode">,
  maxBytes: number,
): Promise<boolean> {
  try {
    const current = await lstat(filePath);
    return current.isFile() && current.size <= maxBytes && sameFileVersion(current, {
      size: expected.size,
      mtimeMs: expected.mtimeMs,
      dev: expected.device,
      ino: expected.inode,
    });
  } catch {
    return false;
  }
}

function sameFileVersion(
  left: Pick<Awaited<ReturnType<typeof lstat>>, "size" | "mtimeMs" | "dev" | "ino">,
  right: Pick<Awaited<ReturnType<typeof lstat>>, "size" | "mtimeMs" | "dev" | "ino">,
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}
