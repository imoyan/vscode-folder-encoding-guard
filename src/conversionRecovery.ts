import * as vscode from "vscode";
import { conversionBackupReadLimit } from "./conversionCore.js";
import {
  LAST_BACKUP_KEY,
  PROTECTED_BACKUP_KEY,
  type BackupRecord,
  isConversionBackupSession,
  readBackupRecord,
  readBackupResource,
  deleteStoredBackupSession,
  writeJsonAtomic,
} from "./conversionBackup.js";
import { isDirty, hashBytes, reopenCleanDocument } from "./conversionResources.js";
import { readStableResource, resourceStillMatchesRead } from "./stableResourceRead.js";
import {
  resolveRealDirectory,
  resolveRealPathWithin,
} from "./localPathSafety.js";

const LEGACY_BACKUP_LIMIT = 100 * 1024 * 1024;

const LEGACY_CONVERTED_LIMIT = 320 * 1024 * 1024;

/** ConversionManagerの変換・復元共通の排他制御内で呼び出します。 */
export async function restoreLastConversion(
  context: vscode.ExtensionContext,
  onFilesChanged: () => void,
): Promise<boolean> {
  const stored = context.workspaceState.get<string>(LAST_BACKUP_KEY);
  if (!stored) {
    void vscode.window.showInformationMessage("このワークスペースで元に戻せる一括変換はありません。");
    return false;
  }
  const sessionUri = vscode.Uri.parse(stored);
  if (!(await isConversionBackupSession(context.globalStorageUri, sessionUri))) {
    void vscode.window.showErrorMessage("変換バックアップの保存場所が不正です。");
    return false;
  }
  const confirm = await vscode.window.showWarningMessage(
    "直前の一括変換を元に戻します。変換後に編集されたファイルは上書きせずスキップします。",
    { modal: true },
    "元に戻す",
  );
  if (confirm !== "元に戻す") {
    return false;
  }

  let restored = 0;
  let alreadyRestored = 0;
  let skipped = 0;
  let failed = 0;
  let manualRecoveryRequired = false;
  let recordCount = 0;
  try {
    const entries = await vscode.workspace.fs.readDirectory(sessionUri);
    const recordNames = entries
      .filter(([name, type]) => type === vscode.FileType.File && /^\d+\.json$/.test(name))
      .map(([name]) => name)
      .sort();
    recordCount = recordNames.length;
    for (const recordName of recordNames) {
      try {
        const record = await readBackupRecord(vscode.Uri.joinPath(sessionUri, recordName));
        if (!record || !/^\d+\.bin$/.test(record.backupFile)) {
          failed += 1;
          continue;
        }
        const originalUri = vscode.Uri.parse(record.originalUri);
        if (originalUri.scheme !== "file") {
          skipped += 1;
          continue;
        }
        const workspaceRootRealPath = await resolveOpenWorkspaceRoot(record, originalUri);
        const storedConversionRoot = record.conversionRootUri
          ? vscode.Uri.parse(record.conversionRootUri)
          : undefined;
        const conversionRootRealPath = workspaceRootRealPath && storedConversionRoot
          ? storedConversionRoot.scheme === "file"
            ? await resolveRealPathWithin(
              workspaceRootRealPath,
              storedConversionRoot.fsPath,
            )
            : undefined
          : workspaceRootRealPath;
        const resolvedPath = conversionRootRealPath
          ? await resolveRealPathWithin(conversionRootRealPath, originalUri.fsPath)
          : undefined;
        const resolvedUri = resolvedPath ? vscode.Uri.file(resolvedPath) : undefined;
        if (workspaceRootRealPath && conversionRootRealPath && !resolvedUri) {
          failed += 1;
          manualRecoveryRequired = true;
          continue;
        }
        if (
          !workspaceRootRealPath ||
          !conversionRootRealPath ||
          !resolvedUri ||
          (record.resolvedUri !== undefined && record.resolvedUri !== resolvedUri.toString()) ||
          isDirty(originalUri, resolvedUri)
        ) {
          skipped += 1;
          continue;
        }
        const maxSize = conversionBackupReadLimit(
          record.originalSize,
          record.convertedSize,
          LEGACY_CONVERTED_LIMIT,
        );
        const current = await readStableResource(
          resolvedUri,
          maxSize,
          () => isDirty(originalUri, resolvedUri),
        );
        if (!current) {
          skipped += 1;
          continue;
        }
        const currentHash = hashBytes(current.bytes);
        if (currentHash === record.originalHash) {
          alreadyRestored += 1;
          continue;
        }
        if (currentHash !== record.convertedHash && !record.recoveryRequired) {
          skipped += 1;
          continue;
        }
        if (currentHash !== record.convertedHash && record.recoveryRequired) {
          const recovery = await vscode.window.showWarningMessage(
            `${record.relativePath} は前回の変換または復元の書き込みが完了していない可能性があります。` +
              "現在の内容を置き換えて、退避済みの元データを復元しますか？",
            { modal: true },
            "バックアップから復元",
          );
          if (recovery !== "バックアップから復元") {
            skipped += 1;
            continue;
          }
        }
        const backup = await readVerifiedBackup(sessionUri, record);
        if (!backup) {
          failed += 1;
          continue;
        }
        await context.workspaceState.update(PROTECTED_BACKUP_KEY, stored);
        await writeJsonAtomic(vscode.Uri.joinPath(sessionUri, recordName), { ...record, recoveryRequired: true });
        if (!(await undoTargetIsCurrent(
          originalUri,
          resolvedUri,
          conversionRootRealPath,
          maxSize,
          current,
        ))) {
          skipped += 1;
          continue;
        }
        await vscode.workspace.fs.writeFile(resolvedUri, backup);
        await reopenCleanDocument(originalUri, record.sourceEncoding);
        restored += 1;
      } catch {
        failed += 1;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`変換バックアップを読み込めませんでした: ${message}`);
    return false;
  }

  if (recordCount > 0 && restored + alreadyRestored === recordCount) {
    await context.workspaceState.update(LAST_BACKUP_KEY, undefined);
    if (context.workspaceState.get<string>(PROTECTED_BACKUP_KEY) === stored) {
      await context.workspaceState.update(PROTECTED_BACKUP_KEY, undefined);
    }
    await deleteStoredBackupSession(context.globalStorageUri, sessionUri.toString());
  } else if (recordCount > 0) {
    await context.workspaceState.update(PROTECTED_BACKUP_KEY, stored);
  }
  if (manualRecoveryRequired) {
    void vscode.window.showErrorMessage(
      `安全に自動復元できないファイルがあります。退避データは ${sessionUri.fsPath} に保持しています。`,
    );
  }
  void vscode.window.showInformationMessage(
    `${restored} 件を元に戻しました。` +
      (alreadyRestored > 0 ? `復元済み ${alreadyRestored} 件。` : "") +
      (skipped > 0 ? `変更または未保存のためスキップ ${skipped} 件。` : "") +
      (failed > 0 ? `失敗 ${failed} 件。` : ""),
  );
  if (restored > 0) {
    onFilesChanged();
  }
  return restored > 0;
}

async function undoTargetIsCurrent(
  originalUri: vscode.Uri,
  resolvedUri: vscode.Uri,
  workspaceRootRealPath: string,
  maxSize: number,
  current: Awaited<ReturnType<typeof readStableResource>> & object,
): Promise<boolean> {
  return (
    (await resolveRealPathWithin(workspaceRootRealPath, originalUri.fsPath)) ===
      resolvedUri.fsPath &&
    (await resourceStillMatchesRead(
      resolvedUri,
      maxSize,
      current,
      () => isDirty(originalUri, resolvedUri),
    ))
  );
}

async function resolveOpenWorkspaceRoot(
  record: BackupRecord,
  originalUri: vscode.Uri,
): Promise<string | undefined> {
  if (!record.workspaceRootUri) {
    const currentOwner = vscode.workspace.getWorkspaceFolder(originalUri);
    return currentOwner?.uri.scheme === "file"
      ? resolveRealDirectory(currentOwner.uri.fsPath)
      : undefined;
  }
  const storedRoot = vscode.Uri.parse(record.workspaceRootUri);
  if (storedRoot.scheme !== "file") {
    return undefined;
  }
  const storedRealPath = await resolveRealDirectory(storedRoot.fsPath);
  if (!storedRealPath) {
    return undefined;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (
      folder.uri.scheme === "file" &&
      (await resolveRealDirectory(folder.uri.fsPath)) === storedRealPath
    ) {
      return storedRealPath;
    }
  }
  return undefined;
}

async function readVerifiedBackup(
  sessionUri: vscode.Uri,
  record: BackupRecord,
): Promise<Uint8Array | undefined> {
  const backup = await readBackupResource(
    vscode.Uri.joinPath(sessionUri, record.backupFile),
    record.originalSize ?? LEGACY_BACKUP_LIMIT,
  );
  return backup && hashBytes(backup.bytes) === record.originalHash
    ? backup.bytes
    : undefined;
}
