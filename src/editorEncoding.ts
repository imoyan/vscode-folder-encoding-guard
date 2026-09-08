import * as path from "node:path";
import * as vscode from "vscode";
import { classifyTextLineEndings, classifyLineEndings } from "./scanCore.js";
import { configuredFileSizeLimit } from "./fileLimits.js";
import { readStableResource, resourceStillMatchesRead } from "./stableResourceRead.js";
import { encodingInfo } from "./rules.js";
import { RuleMatch, resolveRule, configurationFor } from "./workspaceRules.js";

function activeComparison(): { original: vscode.Uri; modified: vscode.Uri } | undefined {
  const input = vscode.window.tabGroups?.activeTabGroup.activeTab?.input;
  return vscode.TabInputTextDiff && input instanceof vscode.TabInputTextDiff ? input : undefined;
}

function comparisonEncoding(uri: vscode.Uri): string {
  const document = vscode.workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString());
  return document ? encodingInfo(document.encoding).label : "読み込み待ち";
}

function comparisonLabel(input: { original: vscode.Uri; modified: vscode.Uri }): string {
  return `左 ${input.original.scheme === "git" ? "Git版" : "比較元"}: ${comparisonEncoding(input.original)} / 右 ${input.modified.scheme === "git" ? "Git版" : "作業中"}: ${comparisonEncoding(input.modified)}`;
}

export function isDocumentEncodingMatch(document: vscode.TextDocument, match: RuleMatch): boolean {
  return document.encoding.toLowerCase() === match.rule.encoding.toLowerCase();
}

export function diagnosticFor(document: vscode.TextDocument): vscode.Diagnostic | undefined {
  if (document.uri.scheme === "git") return undefined;
  const match = resolveRule(document.uri);
  if (!match || isDocumentEncodingMatch(document, match)) {
    return undefined;
  }
  const actual = encodingInfo(document.encoding).label;
  const expected = encodingInfo(match.rule.encoding).label;
  const range = document.lineAt(0).range;
  const diagnostic = new vscode.Diagnostic(
    range,
    `文字コードが文字コード設定と異なります。現在: ${actual} / 期待値: ${expected}`,
    vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.source = "文字コード・改行チェック";
  diagnostic.code = "encoding-mismatch";
  return diagnostic;
}

export async function inspectActiveFile(): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (!document) {
    void vscode.window.showInformationMessage("確認するファイルを開いてください。");
    return;
  }
  const details = await describeDocumentLineEndings(document);
  const match = resolveRule(document.uri);
  if (!match) {
    void vscode.window.showInformationMessage(
      `${path.basename(document.fileName)}: 現在 ${encodingInfo(document.encoding).label}。${details}。一致する文字コード設定はありません。`,
    );
    return;
  }

  const actual = encodingInfo(document.encoding).label;
  const expected = encodingInfo(match.rule.encoding).label;
  if (isDocumentEncodingMatch(document, match)) {
    void vscode.window.showInformationMessage(
      `${path.basename(document.fileName)}: ${actual}。${details}。文字コードは文字コード設定と一致しています。`,
    );
    return;
  }
  const action = "期待値で開き直す";
  const selected = await vscode.window.showWarningMessage(
    `${path.basename(document.fileName)}: 現在 ${actual} / 期待値 ${expected}。${details}。`,
    action,
  );
  if (selected === action) {
    await reopenWithExpectedEncoding(document, match);
  }
}

async function describeDocumentLineEndings(document: vscode.TextDocument): Promise<string> {
  let endings;
  let source: string;
  if (document.isDirty || document.uri.scheme !== "file") {
    endings = classifyTextLineEndings(document.getText());
    source = document.isDirty ? "未保存の編集内容" : "現在の文書";
  } else {
    const version = document.version;
    const encoding = document.encoding;
    const changed = (): boolean => document.isDirty || document.version !== version || document.encoding !== encoding;
    const maxSize = configuredFileSizeLimit(configurationFor(document.uri).get<number>("maxFileSizeKB", 5120));
    try {
      const read = await readStableResource(document.uri, maxSize, changed);
      if (!read || !(await resourceStillMatchesRead(document.uri, maxSize, read, changed))) {
        return "改行: 未確認（変更中・読み取り不可・サイズ上限の可能性があります）";
      }
      endings = classifyLineEndings(read.bytes, encoding);
      source = "保存済みファイル";
    } catch {
      return "改行: 未確認（ファイルを安全に読み取れませんでした）";
    }
  }
  const label = endings.kind === "none" ? "改行なし"
    : endings.kind === "mixed" ? `改行混在: ${endings.styles.join(" / ").toUpperCase()}`
      : `改行: ${endings.kind.toUpperCase()}`;
  return `${label}（${source}）`;
}

export async function reopenWithExpectedEncoding(
  document: vscode.TextDocument,
  match: RuleMatch,
): Promise<void> {
  return reopenWithEncoding(document, match.rule.encoding);
}

const openingDocuments = new Set<string>();

async function reopenWithEncoding(document: vscode.TextDocument, encoding: string): Promise<void> {
  if (document.isDirty) {
    void vscode.window.showErrorMessage(
      "未保存の変更があるため開き直せません。内容を退避してから文字コードを変更してください。",
    );
    return;
  }
  const key = document.uri.toString();
  if (openingDocuments.has(key)) return;
  openingDocuments.add(key);
  const comparison = activeComparison();
  try {
    const reopened = await vscode.workspace.openTextDocument(document.uri, {
      encoding,
    });
    if (comparison && [comparison.original, comparison.modified].some((uri) => uri.toString() === document.uri.toString())) {
      await vscode.commands.executeCommand("vscode.diff", comparison.original, comparison.modified,
        `${path.basename(comparison.modified.fsPath)} — ${comparisonLabel(comparison)}`, { preview: false });
    } else {
      await vscode.window.showTextDocument(reopened, { preview: false, preserveFocus: false });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`文字コードを変更できませんでした: ${message}`);
  } finally { openingDocuments.delete(key); }
}

export function updateStatus(status: vscode.StatusBarItem, document: vscode.TextDocument): void {
  const comparison = activeComparison();
  if (comparison) {
    status.command = "folderEncodingGuard.inspectActiveFile";
    status.text = comparisonLabel(comparison);
    status.tooltip = "比較の左右を読み込んでいる文字コードです。文字コードの変更はファイル変換とは異なります。";
    status.backgroundColor = undefined;
    status.show();
    return;
  }
  status.command = "folderEncodingGuard.inspectActiveFile";
  const match = resolveRule(document.uri);
  if (!match) {
    status.hide();
    return;
  }
  const expected = encodingInfo(match.rule.encoding);
  const matches = isDocumentEncodingMatch(document, match);
  status.text = matches ? `$(pass) ${expected.label}` : `$(warning) ${document.encoding} → ${expected.label}`;
  status.backgroundColor = matches
    ? undefined
    : new vscode.ThemeColor("statusBarItem.warningBackground");
  status.tooltip = matches
    ? `文字コード設定と一致: ${match.rule.pattern}`
    : `文字コードが不一致です。クリックして確認: ${match.rule.pattern}`;
  status.show();
}
