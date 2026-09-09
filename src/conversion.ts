import { recordEncodingOperation } from "./encodingOperations.js";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  ConversionOperationGate,
  ConversionTargetWriteError,
  conversionBackupDisposition,
  protectedConversionSession,
  writeConversionIfCurrent,
} from "./conversionCore.js";
import {
  LAST_BACKUP_KEY,
  PROTECTED_BACKUP_KEY,
  type BackupRecord,
  isConversionBackupSession,
  writeJsonAtomic,
  deleteIfPresent,
  deleteStoredBackupSession,
} from "./conversionBackup.js";
import { selectConversion, type ConversionCandidate } from "./conversionSelection.js";
import { restoreLastConversion } from "./conversionRecovery.js";
import { prepareConversion, isDirty, hashBytes, reopenCleanDocument } from "./conversionResources.js";
import { encodingInfo } from "./rules.js";
import { readStableResource, resourceStillMatchesRead } from "./stableResourceRead.js";
import { resolveRealPathWithin } from "./localPathSafety.js";

interface ConversionCounts {
  converted: number;
  skippedChanged: number;
  skippedDirty: number;
  failed: number;
}

interface ConversionCompletion {
  readonly message: string;
  readonly backupSession: string;
  readonly converted: boolean;
  readonly recoveryRequiredPaths: readonly string[];
}

interface ConversionRunResult {
  readonly counts: ConversionCounts;
  readonly backupSession: string;
  readonly recoveryRequiredPaths: readonly string[];
}

export class ConversionManager {
  private readonly operationGate = new ConversionOperationGate();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly expectedEncodingFor: (uri: vscode.Uri) => string | undefined,
    private readonly configurationFor: (
      scope: vscode.ConfigurationScope,
    ) => vscode.WorkspaceConfiguration,
    private readonly onFilesChanged: () => void = () => undefined,
    private readonly onOperationStateChanged: (active: boolean) => void = () => undefined,
  ) {}

  public async notifyProtectedConversion(): Promise<void> {
    const stored = protectedConversionSession(
      this.context.workspaceState.get<unknown>(LAST_BACKUP_KEY),
      this.context.workspaceState.get<unknown>(PROTECTED_BACKUP_KEY),
    );
    if (!stored) {
      return;
    }
    let sessionUri: vscode.Uri;
    try {
      sessionUri = vscode.Uri.parse(stored);
    } catch {
      void vscode.window.showWarningMessage(
        "前回の変換が完了していない可能性がありますが、退避データの保存場所を確認できません。",
      );
      return;
    }
    if (!(await isConversionBackupSession(this.context.globalStorageUri, sessionUri))) {
      void vscode.window.showWarningMessage(
        "前回の変換が完了していない可能性がありますが、退避データの保存場所が不正です。",
      );
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(sessionUri);
      if (stat.type !== vscode.FileType.Directory) {
        throw new Error("not a directory");
      }
    } catch {
      void vscode.window.showWarningMessage(
        `前回の変換が完了していない可能性がありますが、退避データ ${sessionUri.fsPath} を確認できません。`,
      );
      return;
    }
    const action = "復元を確認";
    const selected = await vscode.window.showWarningMessage(
      `前回の変換が完了していない可能性があります。退避データ: ${sessionUri.fsPath}`,
      action,
    );
    if (selected === action) {
      await this.undoBackupSession(stored);
    }
  }

  public async convertFolder(
    suppliedUri?: vscode.Uri,
    suppliedTargetEncoding?: string,
  ): Promise<boolean> {
    return this.convert(suppliedUri, suppliedTargetEncoding, "folder");
  }

  public async convertFile(uri?: vscode.Uri): Promise<boolean> {
    return this.convert(uri, undefined, "file");
  }

  private async convert(suppliedUri: vscode.Uri | undefined, suppliedTargetEncoding: string | undefined, scope: "folder" | "file"): Promise<boolean> {
    const completion = await this.runExclusive(
      () => this.convertExclusive(suppliedUri, suppliedTargetEncoding, scope),
    );
    if (!completion) {
      return false;
    }
    const action = completion.recoveryRequiredPaths.length > 0
      ? "バックアップから復元を試す"
      : "元に戻す";
    const notification = completion.recoveryRequiredPaths.length > 0
      ? vscode.window.showWarningMessage(
        `${completion.message}\n\n` +
          `${completion.recoveryRequiredPaths.join("、")} は書き込みと即時復元の両方に失敗しました。` +
          `退避データは ${vscode.Uri.parse(completion.backupSession).fsPath} に保持しています。`,
        { modal: true },
        action,
      )
      : vscode.window.showInformationMessage(completion.message, action);
    void notification.then(
      (result) => {
        if (result === action) {
          void this.undoBackupSession(completion.backupSession);
        }
      },
      () => undefined,
    );
    return completion.converted;
  }

  private async convertExclusive(
    suppliedUri: vscode.Uri | undefined,
    suppliedTargetEncoding: string | undefined,
    scope: "folder" | "file",
  ): Promise<ConversionCompletion | undefined> {
    const selection = await selectConversion(
      this.context,
      (uri) => this.expectedEncodingFor(uri),
      (scope) => this.configurationFor(scope),
      suppliedUri,
      suppliedTargetEncoding,
      scope,
    );
    if (!selection) return undefined;
    const { selected, sourceEncoding, targetEncoding, targetLineEnding } = selection;
    const conversion = await this.performConversion(
      selected,
      sourceEncoding,
      targetEncoding,
      targetLineEnding,
    );
    const counts = conversion.counts;
    if (counts.converted === 0 && conversion.recoveryRequiredPaths.length === 0) {
      void vscode.window.showWarningMessage(
        `変換できませんでした。変更済み ${counts.skippedChanged}、未保存 ${counts.skippedDirty}、失敗 ${counts.failed}。`,
      );
      return undefined;
    }
    this.onFilesChanged();
    return {
      message:
        `${counts.converted} 件を ${encodingInfo(targetEncoding).label} へ変換して保存しました。` +
        skippedSummary(counts),
      backupSession: conversion.backupSession,
      converted: counts.converted > 0,
      recoveryRequiredPaths: conversion.recoveryRequiredPaths,
    };
  }

  public async undoLastConversion(): Promise<boolean> {
    return (await this.runExclusive(() =>
      restoreLastConversion(this.context, () => this.onFilesChanged()),
    )) ?? false;
  }

  private async undoBackupSession(expectedSession: string): Promise<boolean> {
    return (
      (await this.runExclusive(async () => {
        if (this.context.workspaceState.get<string>(LAST_BACKUP_KEY) !== expectedSession) {
          void vscode.window.showInformationMessage(
            "この通知の後に別の変換が行われたため、古い変換は元に戻しませんでした。",
          );
          return false;
        }
        return restoreLastConversion(this.context, () => this.onFilesChanged());
      })) ?? false
    );
  }

  private async performConversion(
    candidates: readonly ConversionCandidate[],
    sourceEncoding: string,
    targetEncoding: string,
    targetLineEnding?: "lf" | "crlf",
  ): Promise<ConversionRunResult> {
    const previousSession = this.context.workspaceState.get<string>(LAST_BACKUP_KEY);
    const protectedPreviousSession = this.context.workspaceState.get<string>(
      PROTECTED_BACKUP_KEY,
    );
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const sessionUri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      "conversion-backups",
      `${timestamp}-${randomUUID()}`,
    );
    await vscode.workspace.fs.createDirectory(sessionUri);
    if (!(await isConversionBackupSession(this.context.globalStorageUri, sessionUri))) {
      throw new Error("バックアップ保存先の実体を安全に確認できません。変換は開始していません。");
    }
    let backupRegistered = false;
    let recoveryRequired = false;
    const recoveryRequiredPaths: string[] = [];

    const counts = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `${encodingInfo(targetEncoding).label} へ変換中`,
        cancellable: false,
      },
      async (progress) => {
        const counts: ConversionCounts = {
          converted: 0,
          skippedChanged: 0,
          skippedDirty: 0,
          failed: 0,
        };
        for (const [index, candidate] of candidates.entries()) {
          progress.report({
            increment: candidates.length === 0 ? 100 : 100 / candidates.length,
            message: `${index + 1}/${candidates.length} ${candidate.relativePath}`,
          });
          if (isDirty(candidate.uri, candidate.writeUri)) {
            counts.skippedDirty += 1;
            continue;
          }
          try {
            if (!(await candidatePathIsCurrent(candidate))) {
              counts.skippedChanged += 1;
              continue;
            }
            const read = await readStableResource(
              candidate.writeUri,
              candidate.maxSize,
              () => isDirty(candidate.uri, candidate.writeUri),
            );
            if (!read || hashBytes(read.bytes) !== candidate.originalHash) {
              counts.skippedChanged += 1;
              continue;
            }
            const original = read.bytes;
            const prepared = await prepareConversion(original, sourceEncoding, targetEncoding, undefined, targetLineEnding);
            if (!prepared) {
              counts.skippedChanged += 1;
              continue;
            }
            if (!(await resourceStillMatchesRead(
              candidate.writeUri,
              candidate.maxSize,
              read,
              () => isDirty(candidate.uri, candidate.writeUri),
            ))) {
              counts.skippedChanged += 1;
              continue;
            }
            const serial = String(index + 1).padStart(6, "0");
            const backupFile = `${serial}.bin`;
            const backupUri = vscode.Uri.joinPath(sessionUri, backupFile);
            const recordUri = vscode.Uri.joinPath(sessionUri, `${serial}.json`);
            const record: BackupRecord = {
              version: 1,
              originalUri: candidate.uri.toString(),
              resolvedUri: candidate.writeUri.toString(),
              conversionRootUri: vscode.Uri.file(
                candidate.conversionRootRealPath,
              ).toString(),
              workspaceRootUri: vscode.Uri.file(
                candidate.workspaceRootRealPath,
              ).toString(),
              relativePath: candidate.relativePath,
              backupFile,
              originalHash: candidate.originalHash,
              convertedHash: hashBytes(prepared.converted),
              originalSize: original.byteLength,
              convertedSize: prepared.converted.byteLength,
              recoveryRequired: false,
              sourceEncoding,
              targetEncoding,
            };
            const written = await writeConversionIfCurrent({
              writeBackup: async () => vscode.workspace.fs.writeFile(backupUri, original),
              writeRecord: async () => writeJsonAtomic(
                recordUri,
                record,
              ),
              isCurrent: async () =>
                (await candidatePathIsCurrent(candidate)) &&
                (await resourceStillMatchesRead(
                  candidate.writeUri,
                  candidate.maxSize,
                  read,
                  () => isDirty(candidate.uri, candidate.writeUri),
                )),
              registerBackup: async () => {
                if (!backupRegistered) {
                  await this.context.workspaceState.update(
                    LAST_BACKUP_KEY,
                    sessionUri.toString(),
                  );
                  backupRegistered = true;
                }
              },
              markTargetStarted: async () => {
                await this.context.workspaceState.update(
                  PROTECTED_BACKUP_KEY,
                  sessionUri.toString(),
                );
                await writeJsonAtomic(
                  recordUri,
                  { ...record, recoveryRequired: true },
                );
              },
              writeTarget: async () => vscode.workspace.fs.writeFile(
                candidate.writeUri,
                prepared.converted,
              ),
              recoverTarget: async () => {
                // A failed write cannot prove that a concurrent edit did not occur.
                // Keep the backup and require the explicit restore flow instead.
                throw new Error("安全な即時復元を保証できないためバックアップを保持します。");
              },
              markTargetCompleted: async () => {
                await writeJsonAtomic(
                  recordUri,
                  record,
                );
                if (
                  this.context.workspaceState.get<string>(PROTECTED_BACKUP_KEY) ===
                  sessionUri.toString()
                ) {
                  await this.context.workspaceState.update(PROTECTED_BACKUP_KEY, undefined);
                }
              },
              cleanupBackup: async () => {
                await deleteIfPresent(recordUri);
                await deleteIfPresent(backupUri);
              },
            });
            if (!written) {
              counts.skippedChanged += 1;
              continue;
            }
            recordEncodingOperation(candidate.uri, "convert", sourceEncoding, targetEncoding, targetLineEnding);
            await reopenCleanDocument(candidate.uri, targetEncoding);
            counts.converted += 1;
          } catch (error) {
            if (error instanceof ConversionTargetWriteError && error.recoveryFailed) {
              recoveryRequired = true;
              recoveryRequiredPaths.push(candidate.relativePath);
              counts.failed += 1;
              break;
            }
            counts.failed += 1;
          }
        }
        return counts;
      },
    );
    const disposition = conversionBackupDisposition(
      counts.converted,
      recoveryRequired,
      backupRegistered,
    );
    if (disposition === "keepNewAndDeletePrevious") {
      if (previousSession !== protectedPreviousSession) {
        await deleteStoredBackupSession(
          this.context.globalStorageUri,
          previousSession,
        );
      }
    } else if (disposition === "restorePreviousAndDeleteNew") {
      await this.context.workspaceState.update(LAST_BACKUP_KEY, previousSession);
      await this.context.workspaceState.update(
        PROTECTED_BACKUP_KEY,
        protectedPreviousSession,
      );
      await deleteStoredBackupSession(this.context.globalStorageUri, sessionUri.toString());
    } else if (disposition === "deleteUnusedNew") {
      await deleteStoredBackupSession(this.context.globalStorageUri, sessionUri.toString());
    }
    if (recoveryRequired) {
      await this.context.workspaceState.update(
        PROTECTED_BACKUP_KEY,
        sessionUri.toString(),
      );
    } else if (
      counts.converted > 0 &&
      protectedPreviousSession === previousSession
    ) {
      await this.context.workspaceState.update(PROTECTED_BACKUP_KEY, undefined);
    }
    return {
      counts,
      backupSession: sessionUri.toString(),
      recoveryRequiredPaths,
    };
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const release = this.operationGate.enter();
    if (!release) {
      void vscode.window.showInformationMessage(
        "文字コードの変換または復元が進行中です。完了してからもう一度実行してください。",
      );
      return undefined;
    }
    try {
      this.onOperationStateChanged(true);
      return await operation();
    } finally {
      release();
      this.onOperationStateChanged(false);
    }
  }
}

async function candidatePathIsCurrent(candidate: ConversionCandidate): Promise<boolean> {
  return (
    await resolveRealPathWithin(candidate.conversionRootRealPath, candidate.uri.fsPath)
  ) === candidate.writeUri.fsPath;
}

function skippedSummary(counts: ConversionCounts): string {
  const messages: string[] = [];
  if (counts.skippedChanged > 0) {
    messages.push(`変更済み ${counts.skippedChanged}`);
  }
  if (counts.skippedDirty > 0) {
    messages.push(`未保存 ${counts.skippedDirty}`);
  }
  if (counts.failed > 0) {
    messages.push(`失敗 ${counts.failed}`);
  }
  return messages.length > 0 ? ` スキップ: ${messages.join("、")}。` : "";
}
