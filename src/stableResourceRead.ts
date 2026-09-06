import type * as vscode from "vscode";
import {
  StableLocalFileRead,
  localFileStillMatches,
  readStableLocalFile,
} from "./boundedFileRead.js";

export interface StableResourceRead {
  readonly bytes: Uint8Array;
  readonly mtime: number;
  readonly size: number;
  readonly localFile?: StableLocalFileRead;
}

export async function readStableResource(
  uri: vscode.Uri,
  maxSize: number,
  isDirty: () => boolean,
  isCancellationRequested: () => boolean = () => false,
): Promise<StableResourceRead | undefined> {
  if (isDirty() || isCancellationRequested()) {
    return undefined;
  }
  if (uri.scheme !== "file") {
    return undefined;
  }
  const localFile = await readStableLocalFile(
    uri.fsPath,
    maxSize,
    isCancellationRequested,
  );
  return !localFile || isDirty()
    ? undefined
    : {
      bytes: localFile.bytes,
      mtime: localFile.mtimeMs,
      size: localFile.size,
      localFile,
    };
}

export async function resourceStillMatchesRead(
  uri: vscode.Uri,
  maxSize: number,
  read: StableResourceRead,
  isDirty: () => boolean,
): Promise<boolean> {
  if (isDirty()) {
    return false;
  }
  if (uri.scheme !== "file" || !read.localFile) {
    return false;
  }
  return (
    await localFileStillMatches(uri.fsPath, read.localFile, maxSize)
  ) && !isDirty();
}
