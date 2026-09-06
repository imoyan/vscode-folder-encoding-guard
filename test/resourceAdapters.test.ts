import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

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

test("save repair drains the newest save after an in-flight read", async () => {
  let releaseRead!: () => void;
  let announceRead!: () => void;
  const started = new Promise<void>((resolve) => { announceRead = resolve; });
  const held = new Promise<void>((resolve) => { releaseRead = resolve; });
  const document = { uri: { scheme: "file", toString: () => "file:///workspace/a.txt" }, version: 1, isDirty: false, encoding: "utf8", fileName: "a.txt" };
  let reads = 0;
  const writes: string[] = [];
  const encode = async (text: string) => Buffer.from(text);
  const decode = async (bytes: Uint8Array) => Buffer.from(bytes).toString();
  const editor = loadModule<{ repairMismatchedSave(doc: typeof document, pending: { text: string; actualEncoding: string; expectedEncoding: string }, repairing: Set<string>): Promise<void> }>("editorEncoding.ts", {
    "node:path": path,
    vscode: { workspace: { getWorkspaceFolder: () => ({ uri: document.uri }), encode, decode, fs: { writeFile: async (_uri: unknown, bytes: Uint8Array) => { writes.push(Buffer.from(bytes).toString()); } }, openTextDocument: async () => document }, window: { showInformationMessage: () => undefined, showErrorMessage: (message: string) => { throw new Error(message); } } },
    "./scanCore.js": {}, "./fileLimits.js": { configuredFileSizeLimit: () => 1024 }, "./rules.js": { encodingInfo: () => ({ label: "UTF-8" }) },
    "./workspaceRules.js": { resolveRule: () => ({ rule: { encoding: "utf8bom" } }), configurationFor: () => ({ get: () => 1024 }) },
    "./stableResourceRead.js": { readStableResource: async (_uri: unknown, _max: number, stale: () => boolean) => {
      reads++;
      if (reads === 1) { announceRead(); await held; }
      return stale() ? undefined : { bytes: Buffer.from("newest") };
    }, resourceStillMatchesRead: async (_uri: unknown, _max: number, _saved: unknown, stale: () => boolean) => !stale() },
  });
  const repairing = new Set<string>();
  const first = editor.repairMismatchedSave(document, { text: "old", actualEncoding: "utf8", expectedEncoding: "utf8bom" }, repairing);
  await started;
  document.version++;
  await editor.repairMismatchedSave(document, { text: "middle", actualEncoding: "utf8", expectedEncoding: "utf8bom" }, repairing);
  document.version++;
  await editor.repairMismatchedSave(document, { text: "newest", actualEncoding: "utf8", expectedEncoding: "utf8bom" }, repairing);
  releaseRead();
  await first;
  assert.deepEqual(writes, ["newest"]);
  assert.equal(reads, 2);
  assert.equal(repairing.size, 0);
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
  const backup = loadModule<{ readBackupRecord(uri: unknown): Promise<unknown> }>("conversionBackup.ts", {
    "node:crypto": {}, vscode: {}, "./conversionCore.js": {}, "./localPathSafety.js": {},
    "./stableResourceRead.js": { readStableResource: async () => ({ bytes: Buffer.from('{"version":') }) },
  });
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
  const recovery = loadModule<{ restoreLastConversion(context: unknown, changed: () => void): Promise<boolean> }>("conversionRecovery.ts", {
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
      writeJsonAtomic: async (_uri: unknown, value: typeof record) => { record = value; }, deleteIfPresent: async () => { removed = true; } },
    "./conversionResources.js": { isDirty: () => false, hashBytes: (bytes: Uint8Array) => Buffer.from(bytes).toString(), reopenCleanDocument: async () => undefined },
    "./stableResourceRead.js": { readStableResource: async () => ({ bytes: Buffer.from(disk) }), resourceStillMatchesRead: async () => true },
    "./localPathSafety.js": { resolveRealDirectory: async (value: string) => value, resolveRealPathWithin: async (_root: string, value: string) => value },
  });
  const context = { globalStorageUri: uri("/storage"), workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } };
  assert.equal(await recovery.restoreLastConversion(context, () => undefined), false);
  assert.equal(disk, "partial");
  assert.equal(removed, false);
  assert.equal(await recovery.restoreLastConversion(context, () => undefined), true);
  assert.equal(disk, "original");
  assert.equal(removed, true);
  assert.equal(state.get("protected"), undefined);
  assert.ok(prompts.some((message) => message.includes("現在の内容を置き換えて")));
});
