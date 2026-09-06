import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { validStoredConversionSizes } from "./conversionCore.js";
import { isConversionBackupSessionPath } from "./localPathSafety.js";
import { readStableResource } from "./stableResourceRead.js";

export const LAST_BACKUP_KEY = "folderEncodingGuard.lastConversionBackup";

export const PROTECTED_BACKUP_KEY = "folderEncodingGuard.protectedConversionBackup";

const BACKUP_RECORD_LIMIT = 64 * 1024;

export interface BackupRecord {
  readonly version: 1;
  readonly originalUri: string;
  readonly resolvedUri?: string;
  readonly conversionRootUri?: string;
  readonly workspaceRootUri?: string;
  readonly relativePath: string;
  readonly backupFile: string;
  readonly originalHash: string;
  readonly convertedHash: string;
  readonly originalSize?: number;
  readonly convertedSize?: number;
  readonly recoveryRequired?: boolean;
  readonly sourceEncoding: string;
  readonly targetEncoding: string;
}

export async function isConversionBackupSession(root: vscode.Uri, candidate: vscode.Uri): Promise<boolean> {
  if (root.scheme !== candidate.scheme || root.authority !== candidate.authority) {
    return false;
  }
  if (root.scheme !== "file" && (root.scheme !== "vscode-userdata" || root.authority || vscode.env.remoteName)) return false;
  return isConversionBackupSessionPath(root.fsPath, candidate.fsPath);
}

export async function readBackupRecord(uri: vscode.Uri): Promise<BackupRecord | undefined> {
  const raw = await readBackupResource(uri, BACKUP_RECORD_LIMIT);
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes)); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.originalUri !== "string" ||
    (candidate.resolvedUri !== undefined && typeof candidate.resolvedUri !== "string") ||
    (candidate.conversionRootUri !== undefined &&
      typeof candidate.conversionRootUri !== "string") ||
    (candidate.workspaceRootUri !== undefined &&
      typeof candidate.workspaceRootUri !== "string") ||
    typeof candidate.relativePath !== "string" ||
    typeof candidate.backupFile !== "string" ||
    typeof candidate.originalHash !== "string" ||
    typeof candidate.convertedHash !== "string" ||
    (candidate.recoveryRequired !== undefined &&
      typeof candidate.recoveryRequired !== "boolean") ||
    typeof candidate.sourceEncoding !== "string" ||
    typeof candidate.targetEncoding !== "string"
  ) {
    return undefined;
  }
  if (!validStoredConversionSizes(candidate.originalSize, candidate.convertedSize)) {
    return undefined;
  }
  return candidate as unknown as BackupRecord;
}

/** Native VS Code can expose its local profile storage as vscode-userdata. */
export async function readBackupResource(
  uri: vscode.Uri,
  maxSize: number,
): ReturnType<typeof readStableResource> {
  const localUri = uri.scheme === "vscode-userdata" && !uri.authority && !vscode.env.remoteName
    ? uri.with({ scheme: "file" })
    : uri;
  // Keep bounded, no-follow reads; never map remote/provider paths to local disk.
  return readStableResource(localUri, maxSize, () => false);
}

export async function writeJsonAtomic(uri: vscode.Uri, value: unknown): Promise<void> {
  const temporaryUri = uri.with({ path: `${uri.path}.${randomUUID()}.tmp` });
  try {
    await vscode.workspace.fs.writeFile(
      temporaryUri,
      new TextEncoder().encode(JSON.stringify(value, undefined, 2)),
    );
    await vscode.workspace.fs.rename(temporaryUri, uri, { overwrite: true });
  } finally {
    await deleteIfPresent(temporaryUri);
  }
}

export async function deleteStoredBackupSession(
  storageRoot: vscode.Uri,
  stored: string | undefined,
): Promise<void> {
  if (!stored) {
    return;
  }
  const uri = vscode.Uri.parse(stored);
  if (await isConversionBackupSession(storageRoot, uri)) {
    await deleteIfPresent(uri, true);
  }
}

export async function deleteIfPresent(uri: vscode.Uri, recursive = false): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive });
  } catch {
    // A missing or already-cleaned temporary backup needs no further action.
  }
}
