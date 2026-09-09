import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { EncodingScanSnapshot, ScannedFile } from "./scanner.js";
import { summaryLabel, lineEndingLabel } from "./encodingView.js";
import { encodingInfo } from "./rules.js";
import type { EncodingOperationLog } from "./encodingOperations.js";

export function escapeInventoryText(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Read-only inventory; mutations always use the existing explicit commands. */
export class EncodingInventory implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private snapshot?: EncodingScanSnapshot;
  private folder?: vscode.Uri;
  private stale = false;
  private busy = false;
  private conversionActive = false;
  private offset = 0;
  private revision = 0;
  private visible: readonly ScannedFile[] = [];
  constructor(private readonly operations: EncodingOperationLog) {}
  public dispose(): void { this.panel?.dispose(); }
  public show(): void {
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel("folderEncodingGuard.inventory", "フォルダーの文字コード一覧", vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
      this.panel = panel;
      panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
      panel.webview.onDidReceiveMessage((message: unknown) => { void this.handle(message); });
    } else this.panel.reveal();
    this.render();
  }
  public setConversionActive(active: boolean): void {
    this.conversionActive = active;
    this.render();
  }
  public update(snapshot: EncodingScanSnapshot, folder?: vscode.Uri): void {
    this.folder = folder;
    const previousCount = this.snapshot?.files?.length ?? 0;
    if ((snapshot.files?.length ?? 0) > previousCount) this.offset = Math.floor(previousCount / 100) * 100;
    this.snapshot = snapshot; this.stale = false; this.refresh();
  }
  public invalidate(changed: boolean): void {
    if (changed) this.stale = !!this.snapshot;
    else { this.folder = undefined; this.snapshot = undefined; this.offset = 0; this.stale = false; }
    this.refresh();
  }
  public refresh(): void {
    if (!this.conversionActive) this.render();
  }
  private render(): void {
    if (!this.panel) return;
    const nonce = randomBytes(16).toString("hex");
    const revision = ++this.revision;
    const esc = escapeInventoryText;
    const files = this.snapshot?.files ?? [];
    this.offset = Math.min(this.offset, Math.max(0, Math.floor((files.length - 1) / 100) * 100));
    this.visible = files.slice(this.offset, this.offset + 100);
    const button = (action: string, text: string, disabled = false, index?: number) => `<button data-action="${action}"${index === undefined ? "" : ` data-index="${index}"`}${this.busy || this.conversionActive || disabled ? " disabled" : ""}>${text}</button>`;
    const navigation = `${button("previous", "前の100件", this.offset === 0)}${button("next", "次の100件", this.offset + 100 >= files.length)}${button("continue", "続きを調べる（最大100件）", !this.snapshot?.hasMore || this.stale)}`;
    const rows = this.visible.map((file, index) => {
      const document = vscode.workspace.textDocuments.find(entry => entry.uri.toString() === file.uri.toString());
      const operations = this.operations.forFile(file.uri);
      const latest = operations.at(-1);
      const latestLabel = latest ? `${latest.kind === "reopen" ? "表示だけ変更" : latest.kind === "restore" ? "復元して保存" : "変換して保存"}: ${summaryLabel(latest.from)} → ${summaryLabel(latest.to)}` : "";
      const history = operations.map(entry => `<li>${esc(new Date(entry.at).toLocaleString())} · ${entry.kind === "reopen" ? "表示だけ変更（保存なし）" : entry.kind === "restore" ? "元に戻して保存" : "変換して保存"}: ${esc(summaryLabel(entry.from))} → ${esc(summaryLabel(entry.to))}${entry.lineEnding ? ` / 改行 → ${esc(entry.lineEnding.toUpperCase())}` : ""}</li>`).join("");
      return `<tr><td title="${esc(file.uri.fsPath)}">${esc(file.displayPath)}</td><td>${this.stale ? "未再確認<br>前回: " : ""}${esc(summaryLabel(file.encoding))}</td><td>${esc(lineEndingLabel(file.lineEnding))}${this.stale ? "（前回）" : ""}</td><td>${document ? esc(encodingInfo(document.encoding).label) + (document.isDirty ? "（未保存の編集あり）" : "") : "開いていません"}</td><td>${history ? `<details><summary>${esc(latestLabel)}（${operations.length}件）</summary><ul>${history}</ul><p>変換前は読み取りに指定した文字コードです。内容の判定結果とは異なります。</p></details>` : "操作記録なし"}</td><td>${button("open", "開く", false, index)} ${button("convert", "変換して保存", false, index)}</td></tr>`;
    }).join("");
    const skipped = this.snapshot?.skippedFiles?.map(file => `<li>${esc(file.displayPath)}: ${esc(file.reason)}</li>`).join("");
    this.panel.webview.html = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px}h1{font-size:20px}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:6px 10px;cursor:pointer;margin:3px}button:disabled{opacity:.5;cursor:default}table{border-collapse:collapse;width:100%;margin-top:16px}th,td{text-align:left;border-bottom:1px solid var(--vscode-panel-border);padding:10px;vertical-align:top;overflow-wrap:anywhere}th{white-space:nowrap}p{line-height:1.6}.notice{color:var(--vscode-editorWarning-foreground)}summary{cursor:pointer}ul{padding-left:20px}li{margin-bottom:8px}
</style></head><body><h1>フォルダーの文字コード一覧</h1><p>${esc(this.snapshot?.scopeLabel ?? "フォルダーを選んで調べてください")}</p>
${button("choose", "フォルダーを選んで調べる")}${button("refresh", "同じ範囲を調べ直す", !this.snapshot)}${this.folder ? button("convertFolder", "このフォルダーを変換して保存") : ""}
${this.folder ? "<p>フォルダーの変換は表示中の100件に限定せず、配下から候補を確認して選びます。ファイルを開く必要はありません。</p>" : ""}
${navigation}
<p>保存済みファイルを調べた結果と、エディターの読み込み設定を分けて表示します。ASCII互換・判定不明などは文字コードを一意に特定できません。</p>
${this.conversionActive ? '<p>変換・復元の完了後に一覧を更新します。</p>' : ""}
${this.stale ? '<p class="notice">ファイルや設定が変わりました。前回の結果を残しています。「同じ範囲を調べ直す」で現在の状態を確認してください。</p>' : ""}
<p>${files.length ? this.offset + 1 : 0}–${Math.min(files.length, this.offset + 100)} / 確認済み ${files.length} 件${this.snapshot?.hasMore ? " · 続きあり（全体の件数は未確定）" : ""}</p>
<table><thead><tr><th>ファイル</th><th>保存済みの文字コード<br>（内容からの判定）</th><th>改行</th><th>エディターの読み込み</th><th>この拡張での操作</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="6">まだ確認したファイルがありません。「フォルダーを選んで調べる」から開始できます。</td></tr>'}</tbody></table>
${navigation}
${skipped ? `<details><summary>読み取れなかった項目</summary><ul>${skipped}</ul></details>` : ""}
<p>操作記録はこのワークスペースに直近1,000件まで保存します。ファイル本文は記録しません。拡張の外で行った変換や表示変更は記録対象外です。</p>
<script nonce="${nonce}">const api=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(!button||button.disabled)return;document.querySelectorAll('button').forEach(item=>item.disabled=true);api.postMessage({action:button.dataset.action,index:Number(button.dataset.index),revision:${revision}});});</script></body></html>`;
  }
  private async handle(message: unknown): Promise<void> {
    if (!message || typeof message !== "object" || this.busy || this.conversionActive) return;
    const { action, index, revision } = message as { action?: unknown; index?: unknown; revision?: unknown };
    if (revision !== this.revision || typeof action !== "string") return;
    const file = typeof index === "number" && Number.isInteger(index) ? this.visible[index] : undefined;
    this.busy = true;
    try {
      if (action === "choose") await vscode.commands.executeCommand("folderEncodingGuard.inspectFolderInventory");
      else if (action === "refresh" && this.snapshot) await vscode.commands.executeCommand("folderEncodingGuard.refresh");
      else if (action === "continue" && this.snapshot?.hasMore && !this.stale) await vscode.commands.executeCommand("folderEncodingGuard.continueScan");
      else if (action === "convertFolder" && this.folder) await vscode.commands.executeCommand("folderEncodingGuard.convertFolder", this.folder);
      else if (action === "previous") this.offset = Math.max(0, this.offset - 100);
      else if (action === "next") this.offset += 100;
      else if (file && action === "open") await vscode.commands.executeCommand("vscode.open", file.uri);
      else if (file && action === "convert") await vscode.commands.executeCommand("folderEncodingGuard.convertFile", file.uri);
    } catch (error) {
      void vscode.window.showErrorMessage(`一覧の操作を完了できませんでした: ${error instanceof Error ? error.message : String(error)}`);
    } finally { this.busy = false; this.refresh(); }
  }
}
