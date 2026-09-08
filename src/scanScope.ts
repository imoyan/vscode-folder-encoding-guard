import * as path from "node:path";
import * as vscode from "vscode";

export interface ScanScope {
  readonly label: string;
  readonly targets: readonly { uri: vscode.Uri; directory: boolean; rulesOnly?: boolean }[];
}

export async function selectScanScope(supplied?: vscode.Uri, selected?: readonly vscode.Uri[]): Promise<ScanScope | "workspace" | undefined> {
  let uris = selected?.length ? selected : supplied ? [supplied] : undefined;
  if (!uris) {
    const choice = await vscode.window.showQuickPick([
      { label: "現在のファイルだけ", mode: "active", description: "まず1ファイルの結果を確認" },
      { label: "ファイルを選ぶ", mode: "files", description: "複数選択できます" },
      { label: "フォルダーを選ぶ", mode: "folders", description: "選択したフォルダー以下だけを解析" },
      { label: "ワークスペース全体", mode: "workspace", description: "設定対象をまとめて解析（件数上限あり）" },
    ], { title: "解析する範囲を選択", placeHolder: "小さい範囲から確認し、必要に応じて広げられます" });
    if (!choice) return undefined;
    if (choice.mode === "workspace") return "workspace";
    if (choice.mode === "active") {
      const uri = vscode.window.activeTextEditor?.document.uri;
      uris = uri ? [uri] : [];
    } else {
      uris = await vscode.window.showOpenDialog({ canSelectFiles: choice.mode === "files", canSelectFolders: choice.mode === "folders", canSelectMany: true, title: "解析する対象を選択", openLabel: "この範囲を解析" });
    }
  }
  if (!uris?.length) return undefined;
  const targets: Array<{ uri: vscode.Uri; directory: boolean }> = [];
  for (const uri of new Map(uris.map((uri) => [uri.toString(), uri])).values()) {
    if (uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(uri)) {
      void vscode.window.showErrorMessage("開いているワークスペース内のファイル／フォルダーを選択してください。");
      return undefined;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File && stat.type !== vscode.FileType.Directory) throw new Error("通常のファイル／フォルダーではありません");
      targets.push({ uri, directory: stat.type === vscode.FileType.Directory });
    } catch {
      void vscode.window.showErrorMessage(`対象を読み取れません: ${uri.fsPath}`);
      return undefined;
    }
  }
  return { targets, label: targets.map(({ uri, directory }) => `${vscode.workspace.asRelativePath(uri)}${directory ? "/ 以下" : ""}`).join("、") };
}

export function scopeContains(scope: ScanScope, uri: vscode.Uri): boolean {
  return scope.targets.some((target) => {
    if (target.uri.scheme !== uri.scheme || target.uri.authority !== uri.authority) return false;
    if (!target.directory) return target.uri.toString() === uri.toString();
    const relative = path.relative(target.uri.fsPath, uri.fsPath);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}


export function scopeSelectsFile(scope: ScanScope, uri: vscode.Uri, matchesRules: boolean): boolean {
  return scope.targets.some((target) => (!target.rulesOnly || matchesRules) && scopeContains({ label: "", targets: [target] }, uri));
}

export function attributesAffectScope(scope: ScanScope, uri: vscode.Uri): boolean {
  const directory = vscode.Uri.file(path.dirname(uri.fsPath));
  return scope.targets.some((target) =>
    scopeContains({ label: "", targets: [{ uri: directory, directory: true }] }, target.uri) ||
    (target.directory && scopeContains({ label: "", targets: [target] }, uri)),
  );
}
