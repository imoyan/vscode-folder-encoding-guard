import { DEFAULT_MAX_SCAN_FILES, DEFAULT_SCAN_EXCLUDE, SCAN_PAGE_SIZE, configuredFileSizeLimit, configuredScanFileLimit } from "./fileLimits.js";
import * as vscode from "vscode";
import { EncodingRule, encodingInfo } from "./rules.js";
import type { EncodingScanSnapshot, GitInspectionStatus, ScanFinding } from "./scanner.js";
import type { LineEndingKind, LineEndingStyle } from "./scanCore.js";
import {
  configurationFor,
  getRules,
  getAllowedMixedLineEndings,
  getDisallowedMixedLineEndings,
  fileUriForResource,
  resolveRule,
} from "./workspaceRules.js";

export class RuleItem extends vscode.TreeItem {
  public override readonly contextValue = "encodingRule";

  public constructor(
    public readonly folder: vscode.WorkspaceFolder,
    public readonly rule: EncodingRule,
    public readonly ruleIndex: number,
  ) {
    super(rule.pattern, vscode.TreeItemCollapsibleState.None);
    const info = encodingInfo(rule.encoding);
    this.description = `${info.label} · ${folder.name}`;
    this.tooltip = new vscode.MarkdownString(
      `**${folder.name}**\n\n対象: \`${rule.pattern}\`\n\n期待する文字コード: **${info.label}**\n\n適用順: ${ruleIndex + 1}番目。複数に一致するときは、一覧の上にある設定を優先します。`,
    );
    this.iconPath = new vscode.ThemeIcon("symbol-text");
  }
}

type GroupKind = "rules" | "summary" | "findings" | "allowances" | "scope" | "skipped" | "files";

export class MixedAllowanceItem extends vscode.TreeItem {
  public override readonly contextValue = "mixedAllowance";
  public constructor(
    public readonly folder: vscode.WorkspaceFolder,
    public readonly entry: string,
    public readonly allowed = true,
  ) {
    super(entry, vscode.TreeItemCollapsibleState.None);
    this.description = `${allowed ? "許容する" : "許容しない"} · ${entry.endsWith("/") ? "フォルダー以下" : "ファイル"} · ${folder.name}`;
    this.tooltip = `${allowed ? "混在の注意を表示しません" : "混在を注意表示します"}。右クリックで個別設定を解除すると親の設定に従います。ファイル内容・変更の注意・変換方法は変えません。`;
    this.iconPath = new vscode.ThemeIcon(allowed ? "pass" : "eye");
  }
}

class GroupItem extends vscode.TreeItem {
  public constructor(
    public readonly kind: GroupKind,
    label: string,
    description: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(
      kind === "rules" || kind === "files" ? "list-tree" : kind === "summary" ? "graph" : "warning",
    );
  }
}

class SummaryItem extends vscode.TreeItem {
  public constructor(kind: "encoding" | "lineEnding", value: string, count: number) {
    super(
      kind === "encoding" ? `文字コード: ${summaryLabel(value)}` : `改行: ${lineEndingLabel(value)}`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.description = `${count} 件`;
    this.iconPath = new vscode.ThemeIcon(kind === "encoding" ? "symbol-text" : "word-wrap");
  }
}

class GitStatusItem extends vscode.TreeItem {
  public constructor(status: GitInspectionStatus, showFolder: boolean) {
    super(
      showFolder ? `Git確認 (${status.folder.name})` : "Git確認",
      vscode.TreeItemCollapsibleState.None,
    );
    const descriptions: Record<GitInspectionStatus["kind"], string> = {
      active: `.gitattributes 有効 · 対象 ${status.matchedFileCount} 件`,
      noEolRules: "対象ファイルにeol指定なし",
      disabled: ".gitattributes確認オフ（履歴比較は継続）",
      unavailable: "Git機能を利用できません",
      notRepository: "Gitリポジトリ未認識",
      partlyNotRepository: `一部Git管理外 · ${status.unmanagedFileCount} 件`,
      readFailed: "Git規則または履歴の読み取り失敗",
    };
    this.description = descriptions[status.kind];
    const warning = isGitInspectionWarning(status);
    this.iconPath = new vscode.ThemeIcon(
      warning ? "warning" : status.kind === "active" ? "pass" : "info",
      warning ? new vscode.ThemeColor("problemsWarningIcon.foreground") : undefined,
    );
  }
}

export class FindingItem extends vscode.TreeItem {
  public constructor(public readonly finding: ScanFinding) {
    super(finding.displayPath, vscode.TreeItemCollapsibleState.None);
    this.contextValue = finding.encodingIssue
      ? finding.mixedLineEndings
        ? "encodingMixedFinding"
        : "encodingFinding"
      : finding.mixedLineEndings
        ? "mixedLineEndingFinding"
        : "lineEndingFinding";
    if (finding.localLineEndingChange) this.contextValue += "WithLocalEol";
    if (finding.encodingChange) this.contextValue += "WithChange";
    this.resourceUri = finding.uri;
    this.command = {
      command: "vscode.open",
      title: "ファイルを開く",
      arguments: [finding.uri],
    };
    const lineEndingDescription = finding.mixedLineEndings
      ? `改行混在: ${finding.mixedLineEndings.map(lineEndingLabel).join(" / ")}`
      : undefined;
    const lineEndingChangeDescription = finding.lineEndingChange
      ? [
          finding.lineEndingChangeSource === "git" ? "Git HEADから改行変更" : "基準から改行変更",
          `${lineEndingStateLabel(
            finding.lineEndingChange.from,
            finding.lineEndingChange.fromStyles,
          )} → ${lineEndingStateLabel(
            finding.lineEndingChange.to,
            finding.lineEndingChange.toStyles,
          )}`,
        ].join(": ")
      : undefined;
    const lineEndingRuleDescription = finding.expectedLineEnding
      ? `.gitattributes: ${lineEndingLabel(finding.actualLineEnding ?? "none")} → ${lineEndingLabel(finding.expectedLineEnding)}`
      : undefined;
    const issue = finding.encodingIssue;
    if (issue?.kind === "mismatch") {
      const expected = encodingInfo(issue.expectedEncoding ?? "unknown").label;
      const detected = encodingInfo(issue.detectedEncoding ?? "unknown").label;
      this.description = [
        `現在 ${detected} / 期待値 ${expected}`,
        lineEndingDescription,
        lineEndingChangeDescription,
        lineEndingRuleDescription,
      ]
        .filter(Boolean)
        .join(" · ");
      this.tooltip = [
        `ルール不一致: 現在 ${detected} / 期待値 ${expected}`,
        lineEndingDescription,
        lineEndingChangeDescription,
        lineEndingRuleDescription,
      ].filter(Boolean).join("\n");
      this.iconPath = new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("problemsErrorIcon.foreground"),
      );
    } else if (issue?.kind === "ambiguous") {
      const expectation = issue.expectedEncoding
        ? `期待値 ${encodingInfo(issue.expectedEncoding).label}` : "ルール未設定";
      const candidates = issue.candidates?.map((value) => encodingInfo(value).label).join(" / ");
      this.description = [
        `判定不明 · ${expectation}`,
        lineEndingDescription,
        lineEndingChangeDescription,
        lineEndingRuleDescription,
      ]
        .filter(Boolean)
        .join(" · ");
      this.tooltip = [
        candidates
          ? `複数候補: ${candidates} / ${expectation}`
          : `文字コードを特定できません / ${expectation}`,
        lineEndingDescription,
        lineEndingChangeDescription,
        lineEndingRuleDescription,
      ].filter(Boolean).join("\n");
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("problemsWarningIcon.foreground"),
      );
    } else {
      this.description = [
        lineEndingDescription,
        lineEndingChangeDescription,
        lineEndingRuleDescription,
      ]
        .filter(Boolean)
        .join(" · ");
      this.tooltip = [lineEndingDescription, lineEndingChangeDescription, lineEndingRuleDescription]
        .filter(Boolean)
        .join("\n");
      this.iconPath = new vscode.ThemeIcon(
        "word-wrap",
        new vscode.ThemeColor("problemsWarningIcon.foreground"),
      );
    }
    if (finding.encodingChange) {
      const change = `初回基準から文字コード変更: ${encodingInfo(finding.encodingChange.from).label} → ${encodingInfo(finding.encodingChange.to).label}`;
      this.description = [change, this.description].filter(Boolean).join(" · ");
      this.tooltip = [change, this.tooltip].filter(Boolean).join("\n");
    }
    this.tooltip = [finding.uri.fsPath, this.tooltip].filter(Boolean).join("\n");
  }
}

class MessageItem extends vscode.TreeItem {
  public constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

type ViewItem = GroupItem | RuleItem | SummaryItem | GitStatusItem | FindingItem | MessageItem | MixedAllowanceItem;

export class RulesProvider implements vscode.TreeDataProvider<ViewItem> {
  private readonly changed = new vscode.EventEmitter<ViewItem | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private snapshot: EncodingScanSnapshot | undefined;
  private needsRescan = false;
  private filePageStart = 0;

  public showFilesPage(direction: number): void {
    const last = Math.max(0, Math.floor(((this.snapshot?.files?.length ?? 1) - 1) / SCAN_PAGE_SIZE) * SCAN_PAGE_SIZE);
    this.filePageStart = Math.max(0, Math.min(last, this.filePageStart + (direction < 0 ? -SCAN_PAGE_SIZE : SCAN_PAGE_SIZE)));
    this.refresh();
  }
  private scopeLabel: string | undefined;

  public setScope(label: string | undefined): void { this.scopeLabel = label; this.refresh(); }

  public refresh(): void {
    this.changed.fire(undefined);
  }

  public setSnapshot(snapshot: EncodingScanSnapshot | undefined): void {
    if (snapshot && (snapshot.files?.length ?? 0) > (this.snapshot?.files?.length ?? 0)) {
      this.filePageStart = Math.floor((this.snapshot?.files?.length ?? 0) / SCAN_PAGE_SIZE) * SCAN_PAGE_SIZE;
    }
    this.snapshot = snapshot;
    this.scopeLabel = snapshot?.scopeLabel;
    this.needsRescan = false;
    this.refresh();
  }

  public invalidateSnapshot(changed: boolean): void {
    this.needsRescan = changed;
    this.snapshot = undefined;
    this.filePageStart = 0;
    this.refresh();
  }

  public getTreeItem(item: ViewItem): vscode.TreeItem {
    return item;
  }

  public getChildren(item?: ViewItem): ViewItem[] {
    if (!item) {
      const ruleCount = (vscode.workspace.workspaceFolders ?? []).reduce(
        (count, folder) => count + getRules(folder).length,
        0,
      );
      const statusDescription = this.snapshot
        ? `確認済み ${this.snapshot.scannedCount} 件 · 未確認 ${this.snapshot.skippedCount} 件${this.snapshot.hasMore ? "（解析済み範囲内）· 続きあり" : ""} · ${formatScanTime(this.snapshot.completedAt)}`
        : this.needsRescan ? "変更あり・再確認が必要" : "未スキャン";
      const allowanceCount = (vscode.workspace.workspaceFolders ?? []).reduce(
        (count, folder) => count + getAllowedMixedLineEndings(folder).length + getDisallowedMixedLineEndings(folder).length, 0,
      );
      const inventory = new MessageItem("フォルダーを調べる");
      inventory.command = { command: "folderEncodingGuard.inspectFolderInventory", title: "フォルダーを調べる" };
      const previousInventory = new MessageItem("調べた結果を見る");
      previousInventory.command = { command: "folderEncodingGuard.showInventory", title: "調べた結果を見る" };
      return [
        inventory, previousInventory,
        new GroupItem("scope", "確認範囲", this.scopeLabel ?? "範囲を選んで調べられます"),
        new GroupItem("summary", "状況", statusDescription),
        ...(this.snapshot ? [new GroupItem("files", "保存済みファイルの文字コード", `${this.snapshot.scannedCount ? this.filePageStart + 1 : 0}–${Math.min(this.filePageStart + SCAN_PAGE_SIZE, this.snapshot.scannedCount)} / ${this.snapshot.scannedCount} 件`)] : []),
        new GroupItem("rules", "期待する文字コード", `${ruleCount} 件 · 上の設定を優先`),
        new GroupItem("findings", "要注意", this.snapshot ? `${this.snapshot.findings.length} 件` : "未確認"),
        ...(this.snapshot?.skippedCount ? [new GroupItem("skipped", "未確認の内訳", `${this.snapshot.skippedCount} 件`)] : []),
        ...(allowanceCount > 0 ? [new GroupItem("allowances", "改行混在の扱い", `${allowanceCount} 件`)] : []),
      ];
    }
    if (!(item instanceof GroupItem)) {
      return [];
    }
    if (item.kind === "scope") {
      if (this.scopeLabel) return [new MessageItem(`今回の解析: ${this.scopeLabel}`)];
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => {
        const rules = getRules(folder);
        const config = configurationFor(folder.uri);
        const scope = new MessageItem(folder.name);
        scope.description = rules.length ? `ルール対象のみ（${rules.length} 件）` : "フォルダー全体（ルール未設定）";
        scope.tooltip = [folder.uri.fsPath,
          rules.length ? `対象: ${rules.map((rule) => rule.pattern).join(", ")}` : "対象: **/*",
          `除外: ${config.get("conversionExclude", DEFAULT_SCAN_EXCLUDE)}`,
          `1回: 最大${Math.min(SCAN_PAGE_SIZE, configuredScanFileLimit(config.get<number>("maxScanFiles", DEFAULT_MAX_SCAN_FILES)))} 候補 / 1ファイル ${configuredFileSizeLimit(config.get("maxFileSizeKB", 5120)) / 1024} KiB`,
        ].join("\n");
        return scope;
      });
    }
    if (item.kind === "allowances") {
      return (vscode.workspace.workspaceFolders ?? []).flatMap((folder) =>
        [...getAllowedMixedLineEndings(folder).map((entry) => new MixedAllowanceItem(folder, entry)),
          ...getDisallowedMixedLineEndings(folder).map((entry) => new MixedAllowanceItem(folder, entry, false))],
      );
    }
    if (item.kind === "rules") {
      const rules = (vscode.workspace.workspaceFolders ?? []).flatMap((folder) =>
        getRules(folder).map((rule, index) => new RuleItem(folder, rule, index)),
      );
      return rules.length > 0
        ? rules
        : [new MessageItem("ファイル／フォルダーを右クリックして、期待する文字コードを設定できます")];
    }
    if (!this.snapshot) {
      return [new MessageItem(this.needsRescan
        ? "ファイルが変更されました。更新ボタンで再確認してください"
        : "「範囲を選んで調べる」で1ファイルから確認できます（設定は任意）")];
    }
    const snapshot = this.snapshot;
    if (item.kind === "files") {
      const findings = new Set(snapshot.findings.map((finding) => finding.uri.toString()));
      const rows = (snapshot.files ?? []).slice(this.filePageStart, this.filePageStart + SCAN_PAGE_SIZE).map((file) => {
        const row = new MessageItem(file.displayPath);
        row.contextValue = "scannedFile";
        row.description = `${summaryLabel(file.encoding)} / ${lineEndingLabel(file.lineEnding)} · ${findings.has(file.uri.toString()) ? "要注意" : "注意なし"}`;
        row.tooltip = `${file.uri.fsPath}\n${row.description}\n文字コードは内容からの判定です。ASCII互換・判定不明は一意に確定できません。`;
        row.resourceUri = file.uri;
        row.command = { command: "vscode.open", title: "ファイルを開く", arguments: [file.uri] };
        return row;
      });
      for (const [label, direction, show] of [
        [`前の${SCAN_PAGE_SIZE}件を表示`, -1, this.filePageStart > 0],
        [`次の${SCAN_PAGE_SIZE}件を表示`, 1, (snapshot.files?.length ?? 0) > this.filePageStart + SCAN_PAGE_SIZE],
      ] as const) {
        if (!show) continue;
        const more = new MessageItem(label);
        more.command = { command: "folderEncodingGuard.showFilesPage", title: label, arguments: [direction] };
        rows.push(more);
      }
      if (snapshot.hasMore) {
        const more = new MessageItem(`続きを調べる（最大${SCAN_PAGE_SIZE}件）`);
        more.description = "全体の件数はまだ未確定です";
        more.command = { command: "folderEncodingGuard.continueScan", title: "続きを調べる" };
        rows.push(more);
      }
      return rows.length ? rows : [new MessageItem("確認できたファイルはありません")];
    }
    if (item.kind === "skipped") {
      return (snapshot.skippedFiles ?? []).map((file) => {
        const row = new MessageItem(file.displayPath);
        row.description = file.reason;
        row.tooltip = `${file.uri.fsPath}
${file.reason}`;
        row.resourceUri = file.uri;
        row.command = { command: file.directory ? "revealInExplorer" : "vscode.open", title: file.directory ? "エクスプローラーで表示" : "ファイルを開く", arguments: [file.uri] };
        return row;
      });
    }
    if (item.kind === "summary") {
      const summaries: ViewItem[] = snapshot.summaries.map(
        (summary) => new SummaryItem("encoding", summary.encoding, summary.count),
      );
      summaries.push(
        ...snapshot.lineEndingSummaries.map(
          (summary) => new SummaryItem("lineEnding", summary.encoding, summary.count),
        ),
      );
      if (snapshot.skippedCount > 0) {
        summaries.push(new SummaryItem("encoding", "skipped", snapshot.skippedCount));
      }
      const showGitFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
      summaries.push(
        ...snapshot.gitStatuses.map(
          (status) => new GitStatusItem(status, showGitFolder),
        ),
      );
      return summaries.length > 0 ? summaries : [new MessageItem("確認対象ファイルなし")];
    }
    const coverage = snapshot.skippedCount > 0
      ? [new MessageItem(`未確認 ${snapshot.skippedCount} 件があります（未保存・サイズ超過・読み取り不可など）`)] : [];
    return snapshot.findings.length > 0
      ? [...coverage, ...snapshot.findings.map((finding) => new FindingItem(finding))]
      : [...coverage, new MessageItem(snapshot.scannedCount > 0
        ? `確認できた ${snapshot.scannedCount} 件では要注意なし`
        : "確認できたファイルはありません")];
  }
}

export class EncodingDecorationProvider implements vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  public readonly onDidChangeFileDecorations = this.changed.event;
  private readonly findings = new Map<string, ScanFinding>();

  public refresh(): void {
    this.changed.fire(undefined);
  }

  public setSnapshot(snapshot: EncodingScanSnapshot | undefined): void {
    this.findings.clear();
    for (const finding of snapshot?.findings ?? []) {
      this.findings.set(finding.uri.toString(), finding);
    }
    this.refresh();
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const fileUri = fileUriForResource(uri);
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder || !configurationFor(folder.uri).get("showExplorerBadges", true)) return undefined;
    const finding = this.findings.get(fileUri.toString());
    if (finding?.encodingIssue?.kind === "mismatch") {
      return {
        badge: "!",
        color: new vscode.ThemeColor("problemsErrorIcon.foreground"),
        tooltip: `文字コードがルールと不一致: ${finding.displayPath}`,
      };
    }
    if (finding?.encodingChange) {
      return {
        badge: "Δ",
        color: new vscode.ThemeColor("problemsWarningIcon.foreground"),
        tooltip: `初回基準から文字コード変更: ${encodingInfo(finding.encodingChange.from).label} → ${encodingInfo(finding.encodingChange.to).label}`,
      };
    }
    if (finding?.encodingIssue?.kind === "ambiguous") {
      return {
        badge: "?",
        color: new vscode.ThemeColor("problemsWarningIcon.foreground"),
        tooltip: `文字コードを特定できません: ${finding.displayPath}`,
      };
    }
    if (finding?.mixedLineEndings) {
      return {
        badge: "↵",
        color: new vscode.ThemeColor("problemsWarningIcon.foreground"),
        tooltip: `改行コードが混在: ${finding.displayPath}`,
      };
    }
    if (finding?.lineEndingChange) {
      return {
        badge: "↵",
        color: new vscode.ThemeColor("problemsWarningIcon.foreground"),
        tooltip: `改行コードが変更されました: ${finding.displayPath}`,
      };
    }
    if (finding?.expectedLineEnding) {
      return {
        badge: "↵",
        color: new vscode.ThemeColor("problemsWarningIcon.foreground"),
        tooltip: `.gitattributes の改行指定と不一致: ${finding.displayPath}`,
      };
    }
    const match = resolveRule(uri);
    if (!match) {
      return undefined;
    }
    const info = encodingInfo(match.rule.encoding);
    return {
      badge: info.badge,
      color: new vscode.ThemeColor("charts.blue"),
      tooltip: `期待する文字コード: ${info.label}`,
    };
  }
}

export function summaryLabel(encoding: string): string {
  if (encoding === "ascii") {
    return "ASCII互換";
  }
  if (encoding === "unknown") {
    return "判定不明";
  }
  if (encoding === "skipped") {
    return "除外・未確認";
  }
  return encodingInfo(encoding).label;
}

export function lineEndingLabel(value: string): string {
  if (value === "unknown") return "判定不明";
  if (value === "lf") {
    return "LF";
  }
  if (value === "crlf") {
    return "CRLF";
  }
  if (value === "cr") {
    return "CR";
  }
  if (value === "mixed") {
    return "混在";
  }
  return "改行なし";
}

function lineEndingStateLabel(
  kind: LineEndingKind,
  styles?: readonly LineEndingStyle[],
): string {
  const label = lineEndingLabel(kind);
  return kind === "mixed" && styles
    ? `${label} (${styles.map(lineEndingLabel).join(" / ")})`
    : label;
}

function formatScanTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

const GIT_INSPECTION_WARNING_STATE_KEY = "gitRuleWarningState.v1";

function isGitInspectionWarning(status: GitInspectionStatus): boolean {
  return ["unavailable", "notRepository", "partlyNotRepository", "readFailed"].includes(
    status.kind,
  );
}

export async function notifyGitIssues(
  context: vscode.ExtensionContext,
  statuses: readonly GitInspectionStatus[],
): Promise<void> {
  const issues = statuses.filter(isGitInspectionWarning);
  const signature = issues
    .map((status) => `${status.folder.uri}:${status.kind}`)
    .sort()
    .join("|");
  const previous = context.workspaceState.get<string>(GIT_INSPECTION_WARNING_STATE_KEY, "");
  await context.workspaceState.update(GIT_INSPECTION_WARNING_STATE_KEY, signature);
  if (issues.length === 0 || signature === previous) {
    return;
  }

  const labels: Record<GitInspectionStatus["kind"], string> = {
    active: "",
    noEolRules: "",
    disabled: "",
    unavailable: "Git機能を利用できません",
    notRepository: "Gitリポジトリとして認識されていません",
    partlyNotRepository: `Git管理外の対象が含まれます`,
    readFailed: "Git規則または履歴を読み取れませんでした",
  };
  const details = issues
    .map((status) => `${status.folder.name}: ${labels[status.kind]}`)
    .join(" / ");
  const selected = await vscode.window.showWarningMessage(
    `Gitによる規則・履歴の確認に注意があります。${details}`,
    "設定を開く",
  );
  if (selected === "設定を開く") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:encoding-tools.folder-encoding-guard",
    );
  }
}
