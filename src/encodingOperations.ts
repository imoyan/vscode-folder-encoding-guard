import * as vscode from "vscode";

export interface EncodingOperation {
  readonly uri: string;
  readonly kind: "convert" | "reopen" | "restore";
  readonly from: string;
  readonly to: string;
  readonly at: number;
  readonly lineEnding?: string;
}
const changes = new vscode.EventEmitter<EncodingOperation>();
export const onEncodingOperation = changes.event;
export function recordEncodingOperation(uri: vscode.Uri, kind: EncodingOperation["kind"], from: string, to: string, lineEnding?: string): void {
  changes.fire({ uri: uri.toString(), kind, from, to, at: Date.now(), lineEnding });
}

export class EncodingOperationLog {
  private entries: EncodingOperation[];
  private saving = false;
  private dirty = false;
  private warned = false;
  constructor(private readonly state: vscode.Memento) {
    const stored = state.get<unknown>("encodingOperations.v1");
    this.entries = Array.isArray(stored) ? stored.slice(-1000).filter((item): item is EncodingOperation =>
      !!item && typeof item === "object" && typeof item.uri === "string" && item.uri.length < 8192 &&
      ["convert", "reopen", "restore"].includes(item.kind) && typeof item.from === "string" && item.from.length < 80 &&
      typeof item.to === "string" && item.to.length < 80 && Number.isFinite(item.at) &&
      (item.lineEnding === undefined || ["lf", "crlf"].includes(item.lineEnding)),
    ) : [];
  }
  public forFile(uri: vscode.Uri): readonly EncodingOperation[] { return this.entries.filter(entry => entry.uri === uri.toString()); }
  public forFiles(uris: readonly vscode.Uri[]): ReadonlyMap<string, readonly EncodingOperation[]> {
    const keys = new Set(uris.map(uri => uri.toString()));
    const grouped = new Map<string, EncodingOperation[]>();
    for (const entry of this.entries) {
      if (!keys.has(entry.uri)) continue;
      const operations = grouped.get(entry.uri);
      if (operations) operations.push(entry);
      else grouped.set(entry.uri, [entry]);
    }
    return grouped;
  }
  public append(entry: EncodingOperation): void {
    this.entries = [...this.entries, entry].slice(-1000);
    this.dirty = true;
    void this.flush();
  }
  private async flush(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.state.update("encodingOperations.v1", this.entries);
      }
    } catch {
      if (!this.warned) void vscode.window.showWarningMessage("操作前後の記録を保存できませんでした。このウィンドウでは確認できますが、再起動後は保持されません。");
      this.warned = true;
    } finally { this.saving = false; }
  }
}
