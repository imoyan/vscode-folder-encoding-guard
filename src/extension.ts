import { verifyGitInspectionHeads } from "./gitIntegration.js";
import { configureMixedPolicy, readMixedPolicy, writeMixedPolicy } from "./mixedPolicy.js";
import { scopeContains, selectScanScope, type ScanScope } from "./scanScope.js";
import * as path from "node:path";
import * as vscode from "vscode";
import { minimatch } from "minimatch";
import { DEFAULT_SCAN_EXCLUDE } from "./fileLimits.js";
import { CoalescingTask, SerialTaskQueue } from "./coalescingTask.js";
import { ConversionManager } from "./conversion.js";
import { encodingInfo } from "./rules.js";
import { appendScanSnapshot } from "./scanSession.js";
import { WorkspaceEncodingScanner, type EncodingScanSnapshot } from "./scanner.js";
import {
  CONFIGURATION_SECTION,
  configurationFor,
  getRules,
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
  isDocumentEncodingMatch,
  diagnosticFor,
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
  let scanScope: ScanScope | undefined;
  let choosingScope = false;
  let retainedSnapshot: EncodingScanSnapshot | undefined;
  let additionScope: ScanScope | "workspace" | undefined;

  const invalidateScan = (changed = false): void => {
    scanRevision += 1;
    scanHasResult = false;
    retainedSnapshot = undefined;
    void vscode.commands.executeCommand("setContext", "folderEncodingGuard.hasMore", false);
    additionScope = undefined;
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
        const retainedGit = retainedSnapshot?.headVerifications;
        const previousHeadsCurrent = async (): Promise<boolean> => {
          try {
            return !retainedGit?.length || await verifyGitInspectionHeads({ availability: "available", files: new Map(), headVerifications: retainedGit }, cancellation.token);
          } catch { return cancellation.token.isCancellationRequested; }
        };
        if (!(await previousHeadsCurrent())) {
          invalidateScan(true);
          void vscode.window.showInformationMessage("Gitの比較基準が変わりました。更新ボタンで追加済みの範囲を確認し直してください。");
          return;
        }
        const snapshot = await scanner.scan(
          () => revision === scanRevision,
          cancellation.token,
          () => { scanCancelledByUser = true; },
          additionScope === "workspace" ? undefined : additionScope ?? scanScope,
          new Set(retainedSnapshot?.checkedUris),
          additionScope ? undefined : retainedSnapshot,
        );
        if (snapshot && revision === scanRevision && !(await previousHeadsCurrent())) {
          invalidateScan(true);
          void vscode.window.showInformationMessage("Gitの比較基準が変わりました。更新ボタンで追加済みの範囲を確認し直してください。");
          return;
        }
        if (snapshot && revision === scanRevision) {
          scanHasResult = true;
          retainedSnapshot = { ...(retainedSnapshot ? appendScanSnapshot(retainedSnapshot, snapshot) : snapshot), scopeLabel: scanScope?.label };
          void vscode.commands.executeCommand("setContext", "folderEncodingGuard.hasMore", !!retainedSnapshot.hasMore);
          rulesProvider.setSnapshot(retainedSnapshot);
          decorationProvider.setSnapshot(retainedSnapshot);
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
    const selected = scanScope && scopeContains(scanScope, uri);
    if (scanScope && !selected && !attributesChanged) return;
    const explicitFile = scanScope?.targets.some((target) => !target.directory && target.uri.toString() === uri.toString());
    if (!explicitFile && !attributesChanged && minimatch(relativePath, exclude, { dot: true })) return;
    if (selected || structural || attributesChanged || getRules(folder).length === 0 || resolveRule(uri)) {
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
    if (document.uri.scheme === "git") { updateDocumentState(document); return; }
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
        `文字コード設定は ${encodingInfo(match.rule.encoding).label} です。`,
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
    vscode.commands.registerCommand("folderEncodingGuard.configureMixedPolicy", (uri?: vscode.Uri) => configureMixedPolicy(uri, settingsQueue)),
    vscode.commands.registerCommand("folderEncodingGuard.configureFile", (uri?: vscode.Uri) => configureFolder(uri, rulesProvider, decorationProvider, settingsQueue, true)),
    vscode.commands.registerCommand("folderEncodingGuard.scanSelection", async (uri?: vscode.Uri, selected?: readonly vscode.Uri[]) => {
      if (choosingScope || scanCancellation) return;
      choosingScope = true;
      try {
        const scope = await selectScanScope(uri, selected);
        if (!scope) return;
        scanScope = scope === "workspace" ? undefined : scope;
        rulesProvider.setScope(scanScope?.label);
        await vscode.commands.executeCommand("setContext", "folderEncodingGuard.hasScanScope", true);
        invalidateScan();
        await runScan();
      } finally { choosingScope = false; }
    }),
    vscode.commands.registerCommand("folderEncodingGuard.addScanSelection", async (uri?: vscode.Uri, selected?: readonly vscode.Uri[]) => {
      if (choosingScope || scanCancellation) return;
      choosingScope = true;
      try {
        const scope = await selectScanScope(uri, selected);
        if (!scope) return;
        const canAppend = scanHasResult && retainedSnapshot !== undefined;
        const oldScope = scanScope;
        if (!canAppend) {
          scanScope = scope === "workspace" ? undefined : scope;
          invalidateScan();
        } else {
          const workspaceTargets = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ uri: folder.uri, directory: true, rulesOnly: true }));
          const targets = [...new Map([...(oldScope?.targets ?? workspaceTargets), ...(scope === "workspace" ? workspaceTargets : scope.targets)]
            .map((target) => [`${target.uri.toString()}:${!!target.rulesOnly}`, target])).values()];
          scanScope = { targets, label: targets.map((target) => `${vscode.workspace.asRelativePath(target.uri) || vscode.workspace.getWorkspaceFolder(target.uri)?.name}${target.directory ? target.rulesOnly ? " / ルール対象" : " / 以下" : ""}`).join("、") };
        }
        rulesProvider.setScope(scanScope?.label);
        await vscode.commands.executeCommand("setContext", "folderEncodingGuard.hasScanScope", true);
        additionScope = canAppend ? scope : undefined;
        const before = retainedSnapshot;
        await runScan();
        if (canAppend && retainedSnapshot === before) {
          scanScope = oldScope;
          rulesProvider.setScope(scanScope?.label);
        }
      } finally { additionScope = undefined; choosingScope = false; }
    }),
    vscode.commands.registerCommand("folderEncodingGuard.continueScan", async () => {
      if (choosingScope || scanCancellation || !retainedSnapshot?.hasMore) return;
      await runScan();
    }),
    vscode.commands.registerCommand("folderEncodingGuard.showFilesPage", (direction: number) => rulesProvider.showFilesPage(direction)),
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
          let previous: boolean | undefined;
          const added = await settingsQueue.run(async () => {
            previous = readMixedPolicy(folder, relativePath);
            if (previous === true) return false;
            await writeMixedPolicy(folder, relativePath, true);
            return true;
          });
          if (!added) return;
          invalidateScan();
          const selected = await vscode.window.showInformationMessage(
            `${relativePath} の意図的な改行混在を許容しました。`,
            "元に戻す",
          );
          if (selected === "元に戻す") {
            await settingsQueue.run(async () => {
              if (readMixedPolicy(folder, relativePath) === true) await writeMixedPolicy(folder, relativePath, previous);
            });
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
    vscode.commands.registerCommand("folderEncodingGuard.refresh", refreshScan),
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
      diagnostics.delete(document.uri);
    }),
    vscode.workspace.onWillSaveTextDocument((event) => {
      const match = resolveRule(event.document.uri);
      if (
        match &&
        !isDocumentEncodingMatch(event.document, match)
      ) {
        const config = configurationFor(match.folder);
        if (config.get("warnOnSave", true) || config.get("enforceOnSave", false)) {
          void vscode.window.showErrorMessage(
            `保存注意: ${path.basename(event.document.fileName)} は ${encodingInfo(event.document.encoding).label}、` +
              `文字コード設定は ${encodingInfo(match.rule.encoding).label} です。`,
          );
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      markFilesChanged(document.uri);
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
  void vscode.commands.executeCommand("setContext", "folderEncodingGuard.hasScanScope", false);
  void conversionManager.notifyProtectedConversion().then(undefined, () => undefined);

  vscode.workspace.textDocuments.forEach((document) => void ensureExpectedEncoding(document));
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument) {
    updateStatus(status, activeDocument);
  }
}

export function deactivate(): void {}
