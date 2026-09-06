import * as path from "node:path";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";

export async function resolveRealDirectory(
  directoryPath: string,
): Promise<string | undefined> {
  try {
    const resolved = await realpath(directoryPath);
    return (await stat(resolved)).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveRealPathWithin(
  realRootPath: string,
  candidatePath: string,
): Promise<string | undefined> {
  try {
    const resolved = await realpath(candidatePath);
    return isPathWithin(realRootPath, resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveMissingRecoveryPath(
  realRootPath: string,
  originalPath: string,
  expectedResolvedPath: string,
): Promise<string | undefined> {
  if (!path.isAbsolute(expectedResolvedPath)) {
    return undefined;
  }
  let originalParent: string;
  let expectedParent: string;
  try {
    [originalParent, expectedParent] = await Promise.all([
      realpath(path.dirname(originalPath)),
      realpath(path.dirname(expectedResolvedPath)),
    ]);
  } catch {
    return undefined;
  }
  const originalDestination = path.resolve(originalParent, path.basename(originalPath));
  const expectedDestination = path.resolve(
    expectedParent,
    path.basename(expectedResolvedPath),
  );
  if (
    originalDestination !== expectedDestination ||
    !isPathWithin(realRootPath, expectedDestination)
  ) {
    return undefined;
  }
  try {
    await lstat(expectedDestination);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? path.resolve(expectedResolvedPath)
      : undefined;
  }
}

export async function writeNewFileNoFollow(
  filePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags, 0o666);
  let complete = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) {
      await unlink(filePath).catch(() => undefined);
    }
  }
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function isConversionBackupSessionPath(
  storageRootPath: string,
  candidatePath: string,
): boolean {
  const backupRoot = path.resolve(storageRootPath, "conversion-backups");
  const candidate = path.resolve(candidatePath);
  return (
    path.dirname(candidate) === backupRoot &&
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path.basename(candidate),
    )
  );
}
