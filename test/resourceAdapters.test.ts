import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import * as fileLimits from "../src/fileLimits.js";

function loadModule<T>(name: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(path.join(process.cwd(), "src", name), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInContext(output.outputText, createContext({ exports, TextEncoder, TextDecoder, require: (id: string) => {
    if (id in dependencies) return dependencies[id];
    throw new Error(`Unexpected dependency: ${id}`);
  }}));
  return exports as T;
}

test("resource rules preserve remote URI identity", () => {
  const remote = { scheme: "vscode-remote", authority: "ssh-remote+example", fsPath: "/workspace/a.txt", path: "/workspace/a.txt" };
  const rules = loadModule<{ fileUriForResource(uri: typeof remote): unknown }>("workspaceRules.ts", {
    "node:path": path, vscode: { Uri: { file: () => { throw new Error("remote URI must not become local"); } } }, "./rules.js": {},
  });
  assert.equal(rules.fileUriForResource(remote), remote);
});

test("conversion refresh only reloads an already-open clean document", async () => {
  const uri = { toString: () => "file:///work/a.txt" };
  const documents: Array<{ uri: typeof uri; isDirty: boolean }> = [];
  const calls: unknown[][] = [];
  const resources = loadModule<{ reopenCleanDocument(uri: unknown, encoding: string): Promise<void> }>("conversionResources.ts", {
    "node:crypto": {}, "./conversionCore.js": {},
    vscode: { workspace: { textDocuments: documents, openTextDocument: async (...args: unknown[]) => { calls.push(args); } } },
  });
  await resources.reopenCleanDocument(uri, "utf8");
  assert.equal(calls.length, 0);
  documents.push({ uri, isDirty: true });
  await resources.reopenCleanDocument(uri, "utf8");
  assert.equal(calls.length, 0);
  documents[0]!.isDirty = false;
  await resources.reopenCleanDocument(uri, "utf8");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], uri);
});

test("Explorer badge setting gates findings and rule mismatches outrank baseline changes", () => {
  let enabled = true;
  const uri = { toString: () => "file:///workspace/a.txt" };
  const view = loadModule<{ EncodingDecorationProvider: new () => { setSnapshot(value: unknown): void; provideFileDecoration(value: unknown): { badge: string } | undefined } }>("encodingView.ts", {
    vscode: { TreeItem: class {}, ThemeColor: class {}, EventEmitter: class { event = () => undefined; fire() {} }, workspace: { getWorkspaceFolder: () => ({ uri }) } },
    "./fileLimits.js": {}, "./rules.js": { encodingInfo: (id: string) => ({ label: id }) },
    "./workspaceRules.js": { fileUriForResource: (value: unknown) => value, configurationFor: () => ({ get: () => enabled }) },
  });
  const provider = new view.EncodingDecorationProvider();
  provider.setSnapshot({ findings: [{ uri, displayPath: "a.txt", encodingChange: { from: "utf8", to: "utf8bom" }, encodingIssue: { kind: "mismatch" } }] });
  assert.equal(provider.provideFileDecoration(uri)?.badge, "!");
  enabled = false;
  assert.equal(provider.provideFileDecoration(uri), undefined);
});


test("malformed backup JSON is ignored as an invalid record", async () => {
  let bytes = Buffer.from('{"version":');
  const backup = loadModule<{ readBackupRecord(uri: unknown): Promise<unknown> }>("conversionBackup.ts", {
    "node:crypto": {}, vscode: {}, "./conversionCore.js": {}, "./localPathSafety.js": {},
    "./stableResourceRead.js": { readStableResource: async () => ({ bytes }) },
  });
  assert.equal(await backup.readBackupRecord({ scheme: "file" }), undefined);
  const valid = JSON.stringify({ version: 1, originalUri: "CORRUPT", relativePath: "a", backupFile: "0.bin", originalHash: "a", convertedHash: "b", sourceEncoding: "utf8", targetEncoding: "utf8bom" });
  bytes = Buffer.concat([Buffer.from(valid.split("CORRUPT")[0]!), Buffer.from([0xff]), Buffer.from(valid.split("CORRUPT")[1]!)]);
  assert.equal(await backup.readBackupRecord({ scheme: "file" }), undefined);
});

test("a partial undo write retains recovery state and can be retried", async () => {
  const uri = (fsPath: string) => ({ fsPath, scheme: "file", toString: () => fsPath });
  const state = new Map<string, unknown>([["last", "/storage/session"]]);
  let record = { version: 1, originalUri: "/workspace/a.txt", relativePath: "a.txt", backupFile: "0.bin", originalHash: "original", convertedHash: "converted", sourceEncoding: "utf8", targetEncoding: "utf8bom", recoveryRequired: false };
  let disk = "converted";
  let writes = 0;
  let removed = false;
  const prompts: string[] = [];
  const recorded: unknown[][] = [];
  const recovery = loadModule<{ restoreLastConversion(context: unknown, changed: () => void): Promise<boolean> }>("conversionRecovery.ts", {
    "./encodingOperations.js": { recordEncodingOperation: (...args: unknown[]) => recorded.push(args) },
    vscode: { Uri: { parse: uri, file: uri, joinPath: (base: { fsPath: string }, name: string) => uri(`${base.fsPath}/${name}`) }, FileType: { File: 1 },
      workspace: { getWorkspaceFolder: () => ({ uri: uri("/workspace") }), fs: {
        readDirectory: async () => [["0.json", 1]], writeFile: async (_uri: unknown, bytes: Uint8Array) => {
          assert.equal(record.recoveryRequired, true);
          assert.equal(state.get("protected"), "/storage/session");
          writes++;
          if (writes === 1) { disk = "partial"; throw new Error("disk full"); }
          disk = Buffer.from(bytes).toString();
        },
      } }, window: { showWarningMessage: async (message: string, _options: unknown, action: string) => { prompts.push(message); return action; }, showInformationMessage() {}, showErrorMessage() {} } },
    "./conversionCore.js": { conversionBackupReadLimit: () => 1024 },
    "./conversionBackup.js": { LAST_BACKUP_KEY: "last", PROTECTED_BACKUP_KEY: "protected", isConversionBackupSession: () => true,
      readBackupRecord: async () => record, readBackupResource: async () => ({ bytes: Buffer.from("original") }),
      writeJsonAtomic: async (_uri: unknown, value: typeof record) => { record = value; }, deleteStoredBackupSession: async () => { removed = true; } },
    "./conversionResources.js": { isDirty: () => false, hashBytes: (bytes: Uint8Array) => Buffer.from(bytes).toString(), reopenCleanDocument: async () => undefined },
    "./stableResourceRead.js": { readStableResource: async () => ({ bytes: Buffer.from(disk) }), resourceStillMatchesRead: async () => true },
    "./localPathSafety.js": { resolveRealDirectory: async (value: string) => value, resolveRealPathWithin: async (_root: string, value: string) => value },
  });
  const context = { globalStorageUri: uri("/storage"), workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } };
  assert.equal(await recovery.restoreLastConversion(context, () => undefined), false);
  assert.equal(disk, "partial");
  assert.equal(recorded.length, 0);
  assert.equal(removed, false);
  assert.equal(await recovery.restoreLastConversion(context, () => undefined), true);
  assert.equal(disk, "original");
  assert.equal(recorded[0]?.[1], "restore");
  assert.equal(recorded[0]?.[2], "unknown");
  assert.equal(removed, true);
  assert.equal(state.get("protected"), undefined);
  assert.ok(prompts.some((message) => message.includes("現在の内容を置き換えて")));
});


test("file-backed UNC storage reaches filesystem containment checks", async () => {
  let checks = 0;
  const backup = loadModule<{ isConversionBackupSession(root: unknown, candidate: unknown): Promise<boolean> }>("conversionBackup.ts", {
    "node:crypto": {}, vscode: { env: {} }, "./conversionCore.js": {}, "./stableResourceRead.js": {},
    "./localPathSafety.js": { isConversionBackupSessionPath: async () => { checks++; return true; } },
  });
  const root = { scheme: "file", authority: "server", fsPath: "//server/share/storage" };
  const session = { ...root, fsPath: "//server/share/storage/conversion-backups/session" };
  assert.equal(await backup.isConversionBackupSession(root, session), true);
  assert.equal(checks, 1);
  assert.equal(await backup.isConversionBackupSession(root, { ...session, authority: "other" }), false);
  assert.equal(await backup.isConversionBackupSession({ ...root, scheme: "vscode-userdata" }, { ...session, scheme: "vscode-userdata" }), false);
  assert.equal(checks, 1);
});

test("reopening a comparison side preserves both URIs and labels their encodings", async () => {
  const uri = (value: string, scheme: string) => ({ scheme, fsPath: value, toString: () => `${scheme}:${value}` });
  const original = uri("/a.txt", "git");
  const modified = uri("/a.txt", "file");
  class Diff { constructor(public original: unknown, public modified: unknown) {} }
  const input = new Diff(original, modified);
  const documents = [{ uri: original, encoding: "shiftjis", isDirty: false }, { uri: modified, encoding: "utf8", isDirty: false }];
  const calls: unknown[][] = [];
  const recorded: unknown[][] = [];
  const editor = loadModule<{ reopenWithExpectedEncoding(document: unknown, match: unknown): Promise<void>; updateStatus(status: unknown, document: unknown): void; diagnosticFor(document: unknown): unknown }>("editorEncoding.ts", {
    "./encodingOperations.js": { recordEncodingOperation: (...args: unknown[]) => recorded.push(args) },
    "node:path": path, "./scanCore.js": {}, "./fileLimits.js": {}, "./stableResourceRead.js": {}, "./workspaceRules.js": {},
    "./rules.js": { encodingInfo: (id: string) => ({ label: id }) },
    vscode: { TabInputTextDiff: Diff, workspace: { textDocuments: documents, openTextDocument: async (selected: unknown, options: { encoding: string }) => {
      const doc = documents.find((entry) => entry.uri === selected)!; doc.encoding = options.encoding; return doc;
    } }, window: { tabGroups: { activeTabGroup: { activeTab: { input } } }, showTextDocument: () => { throw new Error("must keep comparison"); }, showErrorMessage: (error: string) => { throw new Error(error); } }, commands: { executeCommand: async (...args: unknown[]) => { calls.push(args); } } },
  });
  await editor.reopenWithExpectedEncoding(documents[1], { rule: { encoding: "utf8bom" } });
  assert.deepEqual(recorded[0]?.slice(1), ["reopen", "utf8", "utf8bom"]);
  assert.equal(calls[0]?.[0], "vscode.diff");
  assert.equal(calls[0]?.[1], original);
  assert.equal(calls[0]?.[2], modified);
  assert.match(String(calls[0]?.[3]), /左 Git版: shiftjis \/ 右 作業中: utf8bom/);
  const status = { text: "", show() {} };
  editor.updateStatus(status, documents[1]);
  assert.match(status.text, /左 Git版: shiftjis \/ 右 作業中: utf8bom/);
  assert.equal(editor.diagnosticFor(documents[0]), undefined);
});

test("operation log preserves separate conversions and display changes with bounded persistence", async () => {
  const state = new Map<string, unknown>();
  const module = loadModule<{ EncodingOperationLog: new (state: unknown) => { append(entry: unknown): void; forFile(uri: unknown): readonly { kind: string }[] } }>("encodingOperations.ts", {
    vscode: { EventEmitter: class { event = () => {}; fire() {} }, window: { showWarningMessage() {} } },
  });
  const storage = { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } };
  const log = new module.EncodingOperationLog(storage);
  const uri = { toString: () => "file:///a.txt" };
  log.append({ uri: uri.toString(), kind: "convert", from: "shiftjis", to: "utf8", at: 1 });
  log.append({ uri: uri.toString(), kind: "reopen", from: "utf8", to: "shiftjis", at: 2 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const reloaded = new module.EncodingOperationLog(storage);
  assert.deepEqual(Array.from(reloaded.forFile(uri), item => item.kind), ["convert", "reopen"]);
  for (let at = 3; at < 1005; at++) log.append({ uri: uri.toString(), kind: "reopen", from: "utf8", to: "shiftjis", at });
  assert.equal(log.forFile(uri).length, 1000);
});

test("inventory messages only address displayed files and block duplicate conversion", async () => {
  let receive: (message: unknown) => void = () => {};
  let finish: (() => void) | undefined;
  const calls: unknown[][] = [];
  const webview = { html: "", onDidReceiveMessage: (listener: typeof receive) => { receive = listener; } };
  const uri = { fsPath: "/work/a.txt", toString: () => "file:///work/a.txt" };
  const module = loadModule<{ EncodingInventory: new (log: unknown) => { show(): void; update(snapshot: unknown): void } }>("encodingInventory.ts", {
    "node:crypto": { randomBytes: () => ({ toString: () => "testnonce" }) },
    "./fileLimits.js": fileLimits,
    "./encodingView.js": { summaryLabel: (value: string) => value, lineEndingLabel: (value: string) => value },
    "./rules.js": { encodingInfo: (id: string) => ({ label: id }) },
    vscode: { ViewColumn: { Active: 1 }, workspace: { textDocuments: [] }, window: {
      createWebviewPanel: () => ({ webview, onDidDispose() {}, reveal() {} }), showErrorMessage() {},
    }, commands: { executeCommand: (...args: unknown[]) => { calls.push(args); return new Promise<void>(resolve => { finish = resolve; }); } } },
  });
  const inventory = new module.EncodingInventory({ forFile: () => [] });
  inventory.show(); inventory.update({ files: [{ uri, displayPath: "a.txt", encoding: "utf8", lineEnding: "lf" }] });
  const revision = Number(/revision:(\d+)/.exec(webview.html)![1]);
  receive({ action: "convert", index: 0, revision: revision - 1 });
  assert.equal(calls.length, 0);
  receive({ action: "convert", index: 0, revision });
  receive({ action: "convert", index: 0, revision });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "folderEncodingGuard.convertFile");
  assert.equal(calls[0]?.[1], uri);
  finish?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  const nextRevision = Number(/revision:(\d+)/.exec(webview.html)![1]);
  receive({ action: "convert", index: 1000, uri: "file:///outside.txt", revision: nextRevision });
  assert.equal(calls.length, 1);
});

test("inventory defers per-file and editor refreshes throughout a large conversion", () => {
  let html = "";
  let renders = 0;
  let lookups = 0;
  let converted = false;
  const webview = {
    get html() { return html; },
    set html(value: string) { html = value; renders++; },
    onDidReceiveMessage() {},
  };
  const uri = { fsPath: "/work/a.txt", toString: () => "file:///work/a.txt" };
  const module = loadModule<{ EncodingInventory: new (log: unknown) => {
    show(): void; update(snapshot: unknown): void; invalidate(changed: boolean): void;
    refresh(): void; setConversionActive(active: boolean): void;
  } }>("encodingInventory.ts", {
    "node:crypto": { randomBytes: () => ({ toString: () => "testnonce" }) },
    "./fileLimits.js": fileLimits,
    "./encodingView.js": { summaryLabel: (value: string) => value, lineEndingLabel: (value: string) => value },
    "./rules.js": { encodingInfo: (id: string) => ({ label: id }) },
    vscode: { ViewColumn: { Active: 1 }, workspace: { textDocuments: [] }, window: {
      createWebviewPanel: () => ({ webview, onDidDispose() {}, reveal() {} }),
    } },
  });
  const inventory = new module.EncodingInventory({ forFile: () => {
    lookups++;
    return converted ? [{ kind: "convert", from: "shiftjis", to: "utf8", at: 0 }] : [];
  } });
  inventory.show();
  inventory.update({ files: Array.from({ length: 100 }, () => ({ uri, displayPath: "a.txt", encoding: "shiftjis", lineEnding: "lf" })) });
  inventory.setConversionActive(true);
  const before = { renders, lookups };
  for (let index = 0; index < 5000; index++) {
    converted = true;
    inventory.invalidate(true);
    inventory.refresh();
  }
  assert.equal(renders, before.renders);
  assert.equal(lookups, before.lookups);
  inventory.setConversionActive(false);
  assert.equal(renders, before.renders + 1);
  assert.equal(lookups, before.lookups + 100);
  assert.match(html, /再確認が必要/);
  assert.match(html, /shiftjis → utf8/);
  assert.doesNotMatch(html, /完了後に一覧を更新/);
});
