import * as path from "node:path";
import * as vscode from "vscode";
import { minimatch } from "minimatch";
import { DEFAULT_SCAN_EXCLUDE } from "./fileLimits.js";
import { CoalescingTask, SerialTaskQueue } from "./coalescingTask.js";
import { ConversionManager } from "./conversion.js";
import { encodingInfo } from "./rules.js";
import { WorkspaceEncodingScanner } from "./scanner.js";
import {
  CONFIGURATION_SECTION,
  ALLOWED_MIXED_LINE_ENDINGS_SETTING,
  configurationFor,
  getRules,
  getAllowedMixedLineEndings,
  relativePathFor,
  isMixedLineEndingAllowed,
  resolveRule,
} from "./workspaceRules.js";
import {
  RuleItem,
  FindingItem,
  MixedAllowanceItem,
  RulesProvider,
  EncodingDecorationProvider,
  notifyGitIssues,
} from "./encodingView.js";
import {
  PendingEncodingSave,
  isDocumentEncodingMatch,
  diagnosticFor,
  repairMismatchedSave,
  inspectActiveFile,
  reopenWithExpectedEncoding,
  updateStatus,
} from "./editorEncoding.js";
import { configureFolder, removeRule, editRule, moveRule } from "./ruleCommands.js";
import { acknowledgeEncodingChange, removeMixedAllowance } from "./encodingCommands.js";

export function activate(context: vscode.ExtensionContext): void {
  const rulesProvider = new RulesProvider();
  const decorationProvider = new EncodingDecorationProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection("folderEncodingGuard");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = "folderEncodingGuard.inspectActiveFile";
  const reopening = new Set<string>();
  const repairing = new Set<string>();
  const pendingSaves = new Map<string, PendingEncodingSave>();
  const warned = new Map<string, string>();
  const conversionManager = new ConversionManager(
    context,
    (uri) => resolveRule(uri)?.rule.encoding,
    (scope) => configurationFor(scope),
    () => invalidateScan(),
  );
  const scanner = new WorkspaceEncodingScanner(
    context.workspaceState,
    (uri) => resolveRule(uri)?.rule.encoding,
    (scope) => configurationFor(scope),
    (folder) => getRules(folder).map((rule) => rule.pattern),
    () => [
      ...new Set(
        (vscode.workspace.workspaceFolders ?? []).flatMap((folder) =>
          getRules(folder).map((rule) => rule.encoding),
        ),
      ),
    ],
    isMixedLineEndingAllowed,
  );
  const scanScheduler = new CoalescingTask();
  const settingsQueue = new SerialTaskQueue();
  const baselineQueue = new SerialTaskQueue();
  let acknowledging = false;
  let allowingMixed = false;
  let scanCancellation: vscode.CancellationTokenSource | undefined;
  let scanRevision = 0;
  let scanHasResult = false;
  let fileChangeRevision = 0;
  let scanCancelledByUser = false;

  const invalidateScan = (changed = false): void => {
    scanRevision += 1;
    scanHasResult = false;
    scanCancellation?.cancel();
    rulesProvider.invalidateSnapshot(changed);
    decorationProvider.setSnapshot(undefined);
  };

  const executeScan = async (): Promise<void> => {
    const revision = scanRevision;
    scanCancelledByUser = false;
    const cancellation = new vscode.CancellationTokenSource();
    scanCancellation = cancellation;
    try {
      await vscode.commands.executeCommand(
        "setContext",
        "folderEncodingGuard.scanning",
        true,
      ).then(undefined, () => undefined);
      try {
        const snapshot = await scanner.scan(
          () => revision === scanRevision,
          cancellation.token,
          () => { scanCancelledByUser = true; },
        );
        if (snapshot && revision === scanRevision) {
          scanHasResult = true;
          rulesProvider.setSnapshot(snapshot);
          decorationProvider.setSnapshot(snapshot);
          void notifyGitIssues(context, snapshot.gitStatuses);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`文字コードのスキャンに失敗しました: ${message}`);
      }
    } finally {
      if (scanCancellation === cancellation) {
        scanCancellation = undefined;
      }
      cancellation.dispose();
      await vscode.commands.executeCommand(
        "setContext",
        "folderEncodingGuard.scanning",
        false,
      ).then(undefined, () => undefined);
    }
  };

  const runScan = (): Promise<void> => scanScheduler.run(async () => {
    const initialFileRevision = fileChangeRevision;
    await baselineQueue.run(executeScan);
    // A delayed file event can invalidate the scan immediately after a save.
    // Retry once within this manual request; never keep scanning continuously.
    if (!scanHasResult && !scanCancelledByUser && fileChangeRevision !== initialFileRevision) {
      await baselineQueue.run(executeScan);
    }
  });
  const refreshScan = (): Promise<void> => {
    invalidateScan();
    return runScan();
  };
  const files = vscode.workspace.createFileSystemWatcher("**/*");
  const markFilesChanged = (uri: vscode.Uri, structural = false): void => {
    if ((!scanHasResult && !scanCancellation) || uri.scheme !== "file") return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    const relativePath = relativePathFor(uri, folder);
    const exclude = configurationFor(folder.uri).get<string>("conversionExclude",
      DEFAULT_SCAN_EXCLUDE);
    // Git attributes affect comparisons even when the file itself has no encoding rule.
    const attributesChanged = path.basename(uri.fsPath) === ".gitattributes";
    if (!attributesChanged && minimatch(relativePath, exclude, { dot: true })) return;
    if (structural || attributesChanged || getRules(folder).length === 0 || resolveRule(uri)) {
      fileChangeRevision += 1;
      invalidateScan(true);
    }
  };
  context.subscriptions.push(
    files,
    files.onDidChange(markFilesChanged),
    files.onDidCreate((uri) => markFilesChanged(uri, true)),
    files.onDidDelete((uri) => markFilesChanged(uri, true)),
  );

  const updateDocumentState = (document: vscode.TextDocument): void => {
    const diagnostic = diagnosticFor(document);
    diagnostics.set(document.uri, diagnostic ? [diagnostic] : []);
    if (vscode.window.activeTextEditor?.document === document) {
      updateStatus(status, document);
    }
  };

  const ensureExpectedEncoding = async (document: vscode.TextDocument): Promise<void> => {
    const match = resolveRule(document.uri);
    if (!match || isDocumentEncodingMatch(document, match)) {
      updateDocumentState(document);
      return;
    }

    updateDocumentState(document);
    const key = document.uri.toString();
    if (reopening.has(key)) {
      return;
    }

    const config = configurationFor(match.folder);
    if (config.get("autoReopen", false) && !document.isDirty) {
      reopening.add(key);
      try {
        const reopened = await vscode.workspace.openTextDocument(document.uri, {
          encoding: match.rule.encoding,
        });
        updateDocumentState(reopened);
        return;
      } catch (error) {
        console.error("文字コード・改行チェック: 文書を開き直せませんでした", error);
      } finally {
        reopening.delete(key);
      }
    }

    if (!config.get("warnOnOpen", true)) {
      return;
    }
    const warningKey = `${document.encoding}:${match.rule.encoding}`;
    if (warned.get(key) === warningKey) {
      return;
    }
    warned.set(key, warningKey);
    const action = "期待値で開き直す";
    const selected = await vscode.window.showWarningMessage(
      `${path.basename(document.fileName)} は ${encodingInfo(document.encoding).label} で開かれています。` +
        `フォルダールールは ${encodingInfo(match.rule.encoding).label} です。`,
      action,
    );
    if (selected === action) {
      await reopenWithExpectedEncoding(document, match);
    }
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("folderEncodingGuard.rulesView", rulesProvider),
    vscode.window.registerFileDecorationProvider(decorationProvider),
    diagnostics,
    status,
    vscode.commands.registerCommand(
      "folderEncodingGuard.configureFolder",
      async (uri?: vscode.Uri) => configureFolder(
        uri,
        rulesProvider,
        decorationProvider,
        settingsQueue,
      ),
    ),
    vscode.commands.registerCommand("folderEncodingGuard.inspectActiveFile", inspectActiveFile),
    vscode.commands.registerCommand(
      "folderEncodingGuard.convertFolder",
      async (uri?: vscode.Uri) => conversionManager.convertFolder(uri),
    ),
    vscode.commands.registerCommand(
      "folderEncodingGuard.undoLastConversion",
      async () => conversionManager.undoLastConversion(),
    ),
    vscode.commands.registerCommand(
      "folderEncodingGuard.convertFindingFolder",
      async (item?: FindingItem) => {
        if (!item) {
          return;
        }
        const folderUri = vscode.Uri.file(path.dirname(item.finding.uri.fsPath));
        await conversionManager.convertFolder(
          folderUri,
          item.finding.encodingIssue?.expectedEncoding,
        );
      },
    ),
    vscode.commands.registerCommand(
      "folderEncodingGuard.allowMixedLineEndings",
      async (item?: FindingItem) => {
        if (!item?.finding.mixedLineEndings || allowingMixed) {
          return;
        }
        allowingMixed = true;
        try {
          const folder = vscode.workspace.getWorkspaceFolder(item.finding.uri);
          if (!folder) {
            return;
          }
          const scope = await vscode.window.showQuickPick([
            { label: "このファイルだけ", folder: false },
            { label: "このフォルダー以下", folder: true },
          ], { title: "意図的な改行混在を許容（変更の注意は継続）" });
          if (!scope) return;
          const filePath = relativePathFor(item.finding.uri, folder);
          const parent = path.posix.dirname(filePath);
          const relativePath = scope.folder ? `${parent}/` : filePath;
          const added = await settingsQueue.run(async () => {
            const allowed = getAllowedMixedLineEndings(folder);
            if (!allowed.includes(relativePath)) {
              await configurationFor(folder.uri).update(
                ALLOWED_MIXED_LINE_ENDINGS_SETTING,
                [...allowed, relativePath].sort(),
                vscode.ConfigurationTarget.WorkspaceFolder,
              );
              return true;
            }
            return false;
          });
          if (!added) return;
          invalidateScan();
          const selected = await vscode.window.showInformationMessage(
            `${relativePath} の意図的な改行混在を許容しました。`,
            "元に戻す",
          );
          if (selected === "元に戻す") {
            await settingsQueue.run(async () => configurationFor(folder.uri).update(
              ALLOWED_MIXED_LINE_ENDINGS_SETTING,
              getAllowedMixedLineEndings(folder).filter((entry) => entry !== relativePath),
              vscode.ConfigurationTarget.WorkspaceFolder,
            ));
            invalidateScan();
          }
        } finally {
          allowingMixed = false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "folderEncodingGuard.removeRule",
      async (item?: RuleItem) => removeRule(
        item,
        rulesProvider,
        decorationProvider,
        settingsQueue,
      ),
    ),
    vscode.commands.registerCommand("folderEncodingGuard.editRule", (item?: RuleItem) => editRule(item, settingsQueue)),
    vscode.commands.registerCommand("folderEncodingGuard.moveRuleUp", (item?: RuleItem) => moveRule(item, -1, settingsQueue)),
    vscode.commands.registerCommand("folderEncodingGuard.moveRuleDown", (item?: RuleItem) => moveRule(item, 1, settingsQueue)),
    vscode.commands.registerCommand("folderEncodingGuard.refresh", runScan),
    vscode.commands.registerCommand("folderEncodingGuard.acknowledgeLineEndingChange", async (item?: FindingItem) => {
      if (acknowledging) return;
      acknowledging = true;
      try { await acknowledgeEncodingChange(item, context.workspaceState, baselineQueue, refreshScan, "lineEnding"); }
      finally { acknowledging = false; }
    }),
    vscode.commands.registerCommand("folderEncodingGuard.acknowledgeEncodingChange", async (item?: FindingItem) => {
      if (acknowledging) return;
      acknowledging = true;
      try {
        await acknowledgeEncodingChange(item, context.workspaceState, baselineQueue, refreshScan);
      } finally {
        acknowledging = false;
      }
    }),
    vscode.commands.registerCommand("folderEncodingGuard.removeMixedAllowance", async (item?: MixedAllowanceItem) =>
      removeMixedAllowance(item, settingsQueue, refreshScan),
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void ensureExpectedEncoding(editor.document);
      } else {
        status.hide();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => void ensureExpectedEncoding(document)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0) markFilesChanged(event.document.uri);
      void ensureExpectedEncoding(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      warned.delete(key);
      pendingSaves.delete(key);
      diagnostics.delete(document.uri);
    }),
    vscode.workspace.onWillSaveTextDocument((event) => {
      const key = event.document.uri.toString();
      pendingSaves.delete(key);
      const match = resolveRule(event.document.uri);
      if (
        match &&
        !isDocumentEncodingMatch(event.document, match) &&
        !repairing.has(key)
      ) {
        const config = configurationFor(match.folder);
        if (config.get("enforceOnSave", false)) {
          pendingSaves.set(key, {
            text: event.document.getText(),
            expectedEncoding: match.rule.encoding,
            actualEncoding: event.document.encoding,
          });
        }
        if (config.get("warnOnSave", true)) {
          void vscode.window.showErrorMessage(
            `保存注意: ${path.basename(event.document.fileName)} は ${encodingInfo(event.document.encoding).label}、` +
              `フォルダールールは ${encodingInfo(match.rule.encoding).label} です。`,
          );
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      markFilesChanged(document.uri);
      const key = document.uri.toString();
      const pending = pendingSaves.get(key);
      pendingSaves.delete(key);
      if (pending) {
        void repairMismatchedSave(document, pending, repairing);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
        invalidateScan();
        vscode.workspace.textDocuments.forEach((document) => void ensureExpectedEncoding(document));
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateScan();
    }),
  );

  void vscode.commands.executeCommand("setContext", "folderEncodingGuard.scanning", false);
  void conversionManager.notifyProtectedConversion().then(undefined, () => undefined);

  vscode.workspace.textDocuments.forEach((document) => void ensureExpectedEncoding(document));
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument) {
    updateStatus(status, activeDocument);
  }
}

export function deactivate(): void {}
