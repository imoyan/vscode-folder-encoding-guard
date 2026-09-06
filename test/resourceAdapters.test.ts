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
  runInContext(output.outputText, createContext({ exports, require: (id: string) => {
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
