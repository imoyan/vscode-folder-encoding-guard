import * as vscode from "vscode";
import type { SerialTaskQueue } from "./coalescingTask.js";
import { normalizeRelativePath } from "./rules.js";
import { ALLOWED_MIXED_LINE_ENDINGS_SETTING, DISALLOWED_MIXED_LINE_ENDINGS_SETTING, configurationFor, getAllowedMixedLineEndings, getDisallowedMixedLineEndings, relativePathFor } from "./workspaceRules.js";

function samePath(left: string, right: string): boolean {
  return left.replaceAll("\\", "/").endsWith("/") === right.endsWith("/") && normalizeRelativePath(left) === normalizeRelativePath(right);
}

export function readMixedPolicy(folder: vscode.WorkspaceFolder, entry: string): boolean | undefined {
  if (getDisallowedMixedLineEndings(folder).some((path) => samePath(path, entry))) return false;
  return getAllowedMixedLineEndings(folder).some((path) => samePath(path, entry)) ? true : undefined;
}

/** Called inside the shared settings queue. Removing a setting restores inheritance. */
export async function writeMixedPolicy(folder: vscode.WorkspaceFolder, entry: string, allow: boolean | undefined): Promise<void> {
  const config = configurationFor(folder.uri);
  const allowed = getAllowedMixedLineEndings(folder).filter((path) => !samePath(path, entry));
  const denied = getDisallowedMixedLineEndings(folder).filter((path) => !samePath(path, entry));
  if (allow === true) allowed.push(entry);
  if (allow === false) denied.push(entry);
  await config.update(DISALLOWED_MIXED_LINE_ENDINGS_SETTING, denied, vscode.ConfigurationTarget.WorkspaceFolder);
  await config.update(ALLOWED_MIXED_LINE_ENDINGS_SETTING, allowed, vscode.ConfigurationTarget.WorkspaceFolder);
}

let choosing = false;
export async function configureMixedPolicy(uri: vscode.Uri | undefined, queue: SerialTaskQueue): Promise<void> {
  if (choosing) return;
  uri ??= vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== "file") return;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return;
  choosing = true;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File && stat.type !== vscode.FileType.Directory) return;
    const relative = relativePathFor(uri, folder);
    const entry = stat.type === vscode.FileType.Directory ? `${relative || "."}/` : relative;
    const choice = await vscode.window.showQuickPick([
      { label: "許容する", description: "改行混在の注意を表示しない", allow: true },
      { label: "許容しない", description: "改行混在を注意表示する（保存は妨げない）", allow: false },
      { label: "個別設定を解除", description: "親フォルダーの設定に従う。設定がなければ注意表示", allow: undefined },
    ], { title: `${relative || folder.name} の改行混在`, placeHolder: "ファイル内容は変更しません。より具体的なファイル／フォルダーの設定を優先します" });
    if (!choice) return;
    await queue.run(() => writeMixedPolicy(folder, entry, choice.allow));
    void vscode.window.showInformationMessage(`${entry}: ${choice.label}。ファイル内容や変換方法は変更していません。`);
  } catch (error) {
    void vscode.window.showErrorMessage(`改行混在の設定に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  } finally { choosing = false; }
}
