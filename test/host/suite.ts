import assert from "node:assert/strict";
import * as vscode from "vscode";
import { writeFile } from "node:fs/promises";
import { picks, confirmations, providers, errors, expectedErrors, notices } from "./hostDriver.js";
import type { ScanFinding } from "../../src/scanner.js";
import { readBackupResource } from "../../src/conversionBackup.js";

type Item = vscode.TreeItem & { kind?: string; finding?: ScanFinding; entry?: string };
const command = (name: string, ...args: unknown[]) => vscode.commands.executeCommand(`folderEncodingGuard.${name}`, ...args);
async function items(kind: string): Promise<Item[]> {
  const provider = providers.get("folderEncodingGuard.rulesView");
  assert.ok(provider);
  const roots = await provider.getChildren() as Item[];
  const group = roots.find((item) => item.kind === kind);
  return group ? (await provider.getChildren(group) as Item[]) : [];
}
async function finding(uri: vscode.Uri): Promise<Item> {
  const item = (await items("findings")).find((item) => item.finding?.uri.toString() === uri.toString());
  assert.ok(item, `Missing finding: ${uri.fsPath}; summary=${JSON.stringify((await items("summary")).map((row) => row.label))}`);
  return item;
}
async function scan(): Promise<void> {
  await command("refresh");
  assert.deepEqual(errors, []);
}

// File events arrive asynchronously. Wait for delivery before the next manual
// scan, instead of racing an earlier write against its invalidation event.
async function withObservedFileChange(uri: vscode.Uri, action: () => PromiseLike<unknown>): Promise<void> {
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let accept: (() => void) | undefined;
  const event = new Promise<void>((resolve, reject) => {
    accept = resolve;
    timer = setTimeout(() => reject(new Error(`Missing file event: ${uri.fsPath}`)), 10000);
  });
  const observe = (changed: vscode.Uri): void => {
    if (changed.toString() !== uri.toString()) return;
    // Native watchers may deliver create/change in separate batches. Wait for
    // a quiet period, bounded by the timeout, before the next scripted action.
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => accept?.(), 250);
  };
  const listeners = [watcher.onDidCreate(observe), watcher.onDidChange(observe)];
  try {
    await action();
    await event;
  } finally {
    clearTimeout(timer);
    clearTimeout(quietTimer);
    listeners.forEach((listener) => listener.dispose());
    watcher.dispose();
  }
}

async function writeObserved(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  await withObservedFileChange(uri, () => vscode.workspace.fs.writeFile(uri, bytes));
}

export async function run(): Promise<void> {
  console.log("Folder Encoding Guard Extension Host suite started");
  const extension = vscode.extensions.getExtension("yusuke-local.folder-encoding-guard");
  assert.ok(extension);
  await extension.activate();
  const folders = vscode.workspace.workspaceFolders!;
  const plain = folders.find((folder) => folder.name === "plain")!;
  const tracked = folders.find((folder) => folder.name === "tracked")!;
  for (const folder of folders) {
    await vscode.workspace.getConfiguration("folderEncodingGuard", folder.uri).update("rules", [{ pattern: "**/*.txt", encoding: "utf8" }], vscode.ConfigurationTarget.WorkspaceFolder);
  }
  // The scanner resolves repositories itself using the actual Git executable.
  const git = vscode.extensions.getExtension("vscode.git");
  assert.ok(git);
  await git.activate();
  const mixed = vscode.Uri.joinPath(plain.uri, "mixed.txt");
  await writeObserved(mixed, new TextEncoder().encode("日本語\n混在\r\n"));
  await scan();
  picks.push({ title: "意図的な改行混在", label: "このフォルダー以下" });
  await command("allowMixedLineEndings", await finding(mixed));
  await scan();
  assert.equal((await items("findings")).some((item) => item.finding?.uri.toString() === mixed.toString()), false);
  const allowances = await items("allowances");
  assert.equal(allowances.length, 1);
  assert.equal(allowances[0]?.entry, "./");
  await writeObserved(mixed, new TextEncoder().encode("日本語\n混在\r"));
  await scan();
  assert.ok((await finding(mixed)).finding?.lineEndingChange);
  assert.equal((await finding(mixed)).finding?.mixedLineEndings, undefined);
  await command("removeMixedAllowance", allowances[0]);
  assert.equal((await items("allowances")).length, 0);
  assert.ok((await finding(mixed)).finding?.mixedLineEndings);

  const changed = vscode.Uri.joinPath(tracked.uri, "history.txt");
  await writeObserved(changed, await vscode.workspace.encode("履歴\r\n", { encoding: "utf8bom" }));
  await scan();
  const change = await finding(changed);
  assert.ok(change.finding?.encodingChange);
  assert.equal(change.finding?.lineEndingChangeSource, "git");
  const bytes = await vscode.workspace.fs.readFile(changed);
  confirmations.push("キャンセル");
  await command("acknowledgeEncodingChange", change);
  await scan();
  assert.ok((await finding(changed)).finding?.encodingChange);
  confirmations.push("確認済みにする");
  await command("acknowledgeEncodingChange", change);
  const acknowledged = await finding(changed);
  assert.equal(acknowledged.finding?.encodingChange, undefined);
  assert.equal(acknowledged.finding?.lineEndingChangeSource, "git");
  assert.ok(acknowledged.finding?.encodingIssue);
  assert.deepEqual(await vscode.workspace.fs.readFile(changed), bytes);
  await writeObserved(changed, await vscode.workspace.encode("履歴\r\n", { encoding: "utf16le" }));
  await scan();
  assert.equal((await finding(changed)).finding?.encodingChange?.from, "utf8bom");

  const dirtyItem = await finding(changed);
  const document = await vscode.workspace.openTextDocument(changed);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(changed, new vscode.Position(0, 0), "未保存");
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(document.isDirty);
  confirmations.push("確認済みにする");
  await command("acknowledgeEncodingChange", dirtyItem);
  expectedErrors.push("保存注意: history.txt は UTF-16 LE、フォルダールールは UTF-8 です。");
  await withObservedFileChange(changed, async () => { assert.ok(await document.save()); });
  await scan();
  assert.equal((await finding(changed)).finding?.encodingChange?.from, "utf8bom");
  // A stale item cannot acknowledge bytes changed after the displayed scan.
  const stale = await finding(changed);
  await writeObserved(changed, await vscode.workspace.encode("別の内容\r\n", { encoding: "utf16le" }));
  confirmations.push("確認済みにする");
  await command("acknowledgeEncodingChange", stale);
  await scan();
  assert.equal((await finding(changed)).finding?.encodingChange?.from, "utf8bom");

  const plainConfig = vscode.workspace.getConfiguration("folderEncodingGuard", plain.uri);
  await plainConfig.update("rules", [{ pattern: "**/*.txt", encoding: "utf8" }, { pattern: "extra/**", encoding: "utf8" }], vscode.ConfigurationTarget.WorkspaceFolder);
  let rule = (await items("rules")).find((item) => item.label === "extra/**");
  assert.ok(rule);
  picks.push({ title: "文字コードを変更", label: "Shift JIS / CP932" });
  await command("editRule", rule);
  assert.equal(vscode.workspace.getConfiguration("folderEncodingGuard", plain.uri).get<{ encoding: string }[]>("rules")?.[1]?.encoding, "shiftjis");
  rule = (await items("rules")).find((item) => item.label === "extra/**");
  await command("moveRuleUp", rule);
  assert.equal(vscode.workspace.getConfiguration("folderEncodingGuard", plain.uri).get<{ pattern: string }[]>("rules")?.[0]?.pattern, "extra/**");
  rule = (await items("rules")).find((item) => item.label === "extra/**");
  await command("moveRuleDown", rule);
  assert.equal(vscode.workspace.getConfiguration("folderEncodingGuard", plain.uri).get<{ pattern: string }[]>("rules")?.[1]?.pattern, "extra/**");
  await command("removeRule", (await items("rules")).find((item) => item.label === "extra/**"));
  assert.ok((await items("scope")).some((item) => item.description?.toString().includes("ルール対象のみ")));

  const conversionFolder = vscode.Uri.joinPath(plain.uri, "convert");
  await vscode.workspace.fs.createDirectory(conversionFolder);
  const target = vscode.Uri.joinPath(conversionFolder, "sample.txt");
  const original = await vscode.workspace.encode("café\r\n", { encoding: "windows1252" });
  await writeObserved(target, original);
  picks.push({ title: "変換する項目", label: "文字コードと改行コード" }, { title: "変換先の改行", label: "LF" }, { title: "現在の文字コード", label: "Windows-1252" }, { title: "変換候補", all: true });
  confirmations.push("変換する");
  await command("convertFolder", conversionFolder);
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(target)), Buffer.from("café\n"));
  confirmations.push("元に戻す");
  assert.equal(await command("undoLastConversion"), true, JSON.stringify({ errors, notices }));
  assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(target)), Buffer.from(original));
  // Backup reads accept native profile storage, but keep bounds/provider guards.
  assert.ok(await readBackupResource(target, original.length));
  assert.ok(await readBackupResource(target.with({ scheme: "vscode-userdata" }), original.length));
  assert.equal(await readBackupResource(target, original.length - 1), undefined);
  assert.equal(await readBackupResource(target.with({ scheme: "vscode-userdata", authority: "remote" }), original.length), undefined);
  assert.equal(await readBackupResource(target.with({ scheme: "unknown" }), original.length), undefined);
  assert.deepEqual(picks, []);
  assert.deepEqual(confirmations, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(expectedErrors, []);
  console.log("操作フロー成功: 混在許容・解除・変更再検知・確認済み・Git差分維持・古い一覧の拒否・変換と復元");
  assert.ok(process.env.FEG_HOST_RESULT);
  await writeFile(process.env.FEG_HOST_RESULT, "passed");
}
