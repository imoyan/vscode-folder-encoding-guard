import * as path from "node:path";
import * as vscode from "vscode";
import { classifyTextLineEndings, classifyLineEndings } from "./scanCore.js";
import { configuredFileSizeLimit } from "./fileLimits.js";
import { readStableResource, resourceStillMatchesRead } from "./stableResourceRead.js";
import { encodingInfo } from "./rules.js";
import { RuleMatch, resolveRule, configurationFor } from "./workspaceRules.js";

export function isDocumentEncodingMatch(document: vscode.TextDocument, match: RuleMatch): boolean {
  return document.encoding.toLowerCase() === match.rule.encoding.toLowerCase();
}

export function diagnosticFor(document: vscode.TextDocument): vscode.Diagnostic | undefined {
  const match = resolveRule(document.uri);
  if (!match || isDocumentEncodingMatch(document, match)) {
    return undefined;
  }
  const actual = encodingInfo(document.encoding).label;
  const expected = encodingInfo(match.rule.encoding).label;
  const range = document.lineAt(0).range;
  const diagnostic = new vscode.Diagnostic(
    range,
    `文字コードがフォルダールールと異なります。現在: ${actual} / 期待値: ${expected}`,
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
      `${path.basename(document.fileName)}: 現在 ${encodingInfo(document.encoding).label}。${details}。一致するフォルダールールはありません。`,
    );
    return;
  }

  const actual = encodingInfo(document.encoding).label;
  const expected = encodingInfo(match.rule.encoding).label;
  if (isDocumentEncodingMatch(document, match)) {
    void vscode.window.showInformationMessage(
      `${path.basename(document.fileName)}: ${actual}。${details}。文字コードはフォルダールールと一致しています。`,
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
  if (document.isDirty) {
    void vscode.window.showErrorMessage(
      "未保存の変更があるため開き直せません。内容を退避してから文字コードを変更してください。",
    );
    return;
  }
  try {
    const reopened = await vscode.workspace.openTextDocument(document.uri, {
      encoding: match.rule.encoding,
    });
    await vscode.window.showTextDocument(reopened, { preview: false, preserveFocus: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`文字コードを変更できませんでした: ${message}`);
  }
}

export function updateStatus(status: vscode.StatusBarItem, document: vscode.TextDocument): void {
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
    ? `フォルダールールと一致: ${match.rule.pattern}`
    : `文字コードが不一致です。クリックして確認: ${match.rule.pattern}`;
  status.show();
}
