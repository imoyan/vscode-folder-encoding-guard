import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test, { type TestContext } from "node:test";
import { build } from "esbuild";
import { minimatch } from "minimatch";
import { patternForFolder } from "../src/rules.js";
import { classifyLineEndings, classifyTextLineEndings } from "../src/scanCore.js";

type Runtime = typeof import("../src/extension.js") & typeof import("../src/editorEncoding.js") & typeof import("../src/conversionSelection.js");
type Listener = (value: unknown) => unknown;
const bundle = build({
  stdin: { contents: 'export { activate } from "./src/extension.ts"; export { inspectActiveFile } from "./src/editorEncoding.ts"; export { selectConversion } from "./src/conversionSelection.ts";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"],
});

class Emitter {
  private listeners: Listener[] = [];
  public event = (listener: Listener) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((item) => item !== listener); } };
  };
  public fire(value?: unknown): void { this.listeners.forEach((listener) => listener(value)); }
  public dispose(): void { this.listeners = []; }
}
class Cancellation {
  private emitter = new Emitter();
  public token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  public cancel(): void { this.token.isCancellationRequested = true; this.emitter.fire(); }
  public dispose(): void { this.emitter.dispose(); }
}
class Uri {
  public scheme = "file";
  public path: string;
  public constructor(public fsPath: string) { this.path = fsPath; }
  public static file(value: string): Uri { return new Uri(value); }
  public static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(path.join(base.fsPath, ...parts)); }
  public static parse(value: string): Uri { return new Uri(fileURLToPath(value)); }
  public toString(): string { return pathToFileURL(this.fsPath).href; }
}

async function harness(t: TestContext, input: Record<string, string | Uint8Array>) {
  const root = await mkdtemp(path.join(tmpdir(), "encoding-usability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(input)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), data);
  }
  const events = new Map<string, Emitter>();
  const on = (name: string) => {
    const emitter = new Emitter(); events.set(name, emitter); return emitter.event;
  };
  const folder = { uri: Uri.file(root), name: "workspace", index: 0 };
  const config = new Map<string, unknown>();
  const configFailures: string[] = [];
  const state = new Map<string, unknown>();
  const unreadableDirectories = new Set<string>();
  const messages: string[] = [];
  const picks: unknown[] = [];
  const confirmations: string[] = [];
  const information: string[] = [];
  const shownPicks: { items: Record<string, unknown>[]; title?: string }[] = [];
  const searchPatterns: string[] = [];
  const searchLimits: number[] = [];
  let treeChanges = 0;
  let decorationChanges = 0;
  const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let provider: import("../src/encodingView.js").RulesProvider | undefined;
  let decorations: import("../src/encodingView.js").EncodingDecorationProvider | undefined;
  let duringDecode: (() => void) | undefined;
  let progressCancellation: Cancellation | undefined;
  const disposable = { dispose() {} };
  const workspace = {
    workspaceFile: Uri.file(path.join(root, "test.code-workspace")) as Uri | undefined,
    workspaceFolders: [folder], textDocuments: [] as unknown[],
    asRelativePath: (uri: Uri) => path.relative(root, uri.fsPath),
    getWorkspaceFolder: (uri: Uri) => workspace.workspaceFolders.filter((candidate) => uri.fsPath === candidate.uri.fsPath || uri.fsPath.startsWith(candidate.uri.fsPath + path.sep)).sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0],
    getConfiguration: () => ({ inspect: (key: string) => ({ workspaceFolderValue: workspace.workspaceFile ? config.get(key) : undefined, workspaceValue: workspace.workspaceFile ? undefined : config.get(key) }), get: (key: string, fallback?: unknown) => config.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        if (configFailures[0] === key) { configFailures.shift(); throw new Error("設定保存失敗"); }
        if (value === undefined) config.delete(key); else config.set(key, value); events.get("configuration")?.fire({ affectsConfiguration: () => true });
      },
    }),
    findFiles: async (pattern: { pattern: string; base?: Uri | { uri: Uri } }, exclude: string, limit: number) => { searchPatterns.push(pattern.pattern); searchLimits.push(limit); return Object.keys(input)
      .filter((name) => { const base = pattern.base && ("uri" in pattern.base ? pattern.base.uri : pattern.base); return !base || path.join(root, name).startsWith(base.fsPath + path.sep); })
      .filter((name) => minimatch(name, pattern.pattern, { dot: true }) && !minimatch(name, exclude, { dot: true }))
      .slice(0, limit).map((name) => Uri.file(path.join(root, name))); },
    fs: { stat: async (uri: Uri) => { const s = await stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size }; } },
    decode: async (bytes: Uint8Array, options: { encoding: string }) => {
      duringDecode?.();
      if (options.encoding !== "utf8" && options.encoding !== "utf8bom") throw new Error("unsupported fixture encoding");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    encode: async (text: string, options: { encoding: string }) => {
      if (options.encoding === "utf8bom") return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
      if (options.encoding !== "utf8") throw new Error("unsupported fixture encoding");
      return new TextEncoder().encode(text);
    },
    createFileSystemWatcher: () => ({ ...disposable, onDidChange: on("fileChange"), onDidCreate: on("fileCreate"), onDidDelete: on("fileDelete") }),
    onDidChangeTextDocument: on("edit"), onDidOpenTextDocument: on("open"), onDidCloseTextDocument: on("close"),
    onWillSaveTextDocument: on("willSave"), onDidSaveTextDocument: on("save"),
    onDidChangeConfiguration: on("configuration"), onDidChangeWorkspaceFolders: on("folders"),
  };
  const window = {
    activeTextEditor: undefined as { document: unknown } | undefined,
    onDidChangeActiveTextEditor: on("active"),
    createStatusBarItem: () => ({ ...disposable, hide() {}, show() {} }),
    registerTreeDataProvider: (_id: string, value: typeof provider) => { provider = value; return disposable; },
    registerFileDecorationProvider: (value: typeof decorations) => { decorations = value; return disposable; },
    showInformationMessage: async (message: string) => { messages.push(message); return information.shift(); },
    showWarningMessage: async (message: string) => { messages.push(message); return confirmations.shift(); },
    showQuickPick: async (items: Record<string, unknown>[], options: { title?: string }) => {
      shownPicks.push({ items, title: options.title });
      const pick = picks.shift();
      return typeof pick === "function" ? pick(items) : pick;
    },
    showErrorMessage: async (message: string) => { messages.push(message); },
    withProgress: async (_options: unknown, action: (progress: unknown, token: unknown) => Promise<unknown>) => {
      progressCancellation = new Cancellation();
      return action({ report() {} }, progressCancellation.token);
    },
  };
  const vscode = {
    workspace, window, Uri, EventEmitter: Emitter, CancellationTokenSource: Cancellation,
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    TreeItem: class { constructor(public label: string) {} },
    ThemeIcon: class {}, ThemeColor: class {}, MarkdownString: class {},
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
    StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 }, FileType: { File: 1, Directory: 2 }, ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
    extensions: { getExtension: () => undefined },
    languages: { createDiagnosticCollection: () => ({ ...disposable, set() {}, delete() {} }) },
    commands: {
      registerCommand: (name: string, action: (...args: unknown[]) => Promise<unknown>) => { commands.set(name, action); return disposable; },
      executeCommand: async () => undefined,
    },
  };
  const module = { exports: {} };
  const nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
  runInNewContext((await bundle).outputFiles[0]!.text, {
    module, exports: module.exports, require: (id: string) => {
      if (id === "vscode") return vscode;
      const native = nativeRequire(id);
      if (id !== "node:fs/promises") return native;
      return { ...native, opendir: async (directory: string, options: unknown) => {
        if (unreadableDirectories.has(path.relative(root, directory))) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return native.opendir(directory, options);
      } };
    },
    Buffer, process, console, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder,
  });
  const runtime = module.exports as Runtime;
  const memento = { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } };
  const subscriptions: Array<{ dispose(): void }> = [];
  const context = { workspaceState: memento, subscriptions } as unknown as import("vscode").ExtensionContext;
  runtime.activate(context);
  subscriptions.push(provider!.onDidChangeTreeData(() => { treeChanges++; }), decorations!.onDidChangeFileDecorations(() => { decorationChanges++; }));
  t.after(() => subscriptions.forEach((item) => item.dispose()));
  return {
    config, configFailures, state, unreadableDirectories, messages, window, workspace, runtime, picks, confirmations, information, shownPicks, searchPatterns, searchLimits,
    changes: () => ({ tree: treeChanges, decorations: decorationChanges }),
    command: (name: string, ...args: unknown[]) => commands.get(`folderEncodingGuard.${name}`)!(...args),
    fileSelection: (name: string, rule?: string) => runtime.selectConversion(context, () => rule,
      () => workspace.getConfiguration() as unknown as import("vscode").WorkspaceConfiguration,
      Uri.file(path.join(root, name)) as import("vscode").Uri, undefined, "file"),
    selection: () => runtime.selectConversion(context, () => undefined,
      () => workspace.getConfiguration() as unknown as import("vscode").WorkspaceConfiguration,
      folder.uri as import("vscode").Uri),
    uri: (name: string) => Uri.file(path.join(root, name)),
    save: async (name: string, text: string) => {
      const document = { uri: Uri.file(path.join(root, name)), fileName: name, encoding: "utf8", version: 1, isDirty: false, getText: () => text };
      events.get("willSave")!.fire({ document });
      await writeFile(document.uri.fsPath, text);
      events.get("save")!.fire(document);
    },
    scan: () => commands.get("folderEncodingGuard.refresh")!(),
    emit: (event: string, name: string) => events.get(event)!.fire(Uri.file(path.join(root, name))),
    edit: (name: string, text: string) => {
      const document = { uri: Uri.file(path.join(root, name)), fileName: name, encoding: "utf8", isDirty: true, getText: () => text };
      workspace.textDocuments = [document];
      window.activeTextEditor = { document };
      events.get("edit")!.fire({ document, contentChanges: [{ text }] });
    },
    rows: () => {
      const groups = provider!.getChildren();
      return [...groups, ...groups.flatMap((group) => provider!.getChildren(group))];
    },
    badge: (name: string) => decorations!.provideFileDecoration(Uri.file(path.join(root, name)) as import("vscode").Uri),
    cancelProgress: () => progressCancellation!.cancel(),
    duringDecode: (action: () => void) => { duringDecode = action; },
  };
}

test("unconfigured scan detects mixed endings without inventing an encoding rule", async (t) => {
  const h = await harness(t, { "mixed.txt": "a\r\nb\n", "bom.txt": new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), "node_modules/ignored.txt": "a\r\nb\n" });
  await h.scan();
  assert.equal(h.badge("mixed.txt")?.badge, "↵");
  assert.equal(h.badge("bom.txt"), undefined);
  assert.equal(h.badge("node_modules/ignored.txt"), undefined);
  assert.ok(h.rows().some((row) => row.description?.toString().startsWith("確認済み 2 件")));
  assert.equal(Object.keys(h.state.get("encodingBaseline.v1") as object).length, 0);
  assert.equal(h.messages.length, 0);
});

test("file changes remove old findings and badges until a fresh scan completes", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n" });
  await h.scan();
  h.emit("fileChange", "node_modules/output.js");
  assert.equal(h.badge("a.txt")?.badge, "↵");
  for (const event of ["fileChange", "fileCreate", "fileDelete"]) {
    h.emit(event, "a.txt");
    assert.equal(h.badge("a.txt"), undefined);
    assert.ok(h.rows().some((row) => row.description === "変更あり・再確認が必要"));
    assert.ok(!h.rows().some((row) => row.label === "要注意ファイルはありません"));
    await h.scan();
    assert.equal(h.badge("a.txt")?.badge, "↵");
  }
});

test("edits during a scan cancel it and cannot restore stale findings", async (t) => {
  const h = await harness(t, { "a.txt": "é\r\nb\n" });
  await h.scan();
  h.duringDecode(() => h.emit("fileChange", "a.txt"));
  await h.scan();
  assert.equal(h.badge("a.txt"), undefined);
  assert.ok(h.rows().some((row) => row.description === "変更あり・再確認が必要"));
});

test("current file inspection reports mixed endings from unsaved text", async (t) => {
  const h = await harness(t, { "a.txt": "unchanged\n" });
  await h.scan();
  h.edit("a.txt", "edited\r\ntext\n");
  await h.runtime.inspectActiveFile();
  assert.match(h.messages.at(-1)!, /改行混在: LF \/ CRLF（未保存の編集内容）/);
  assert.match(h.messages.at(-1)!, /文字コード設定はありません/);
  assert.ok(h.rows().some((row) => row.description === "変更あり・再確認が必要"));
});

test("configured folders retain rule-scoped scanning and the file limit", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n", "outside.md": "a\r\nb\n" });
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }]);
  await h.scan();
  assert.equal(h.badge("a.txt")?.badge, "↵");
  assert.equal(h.badge("outside.md"), undefined);
  h.config.set("rules", []);
  h.config.set("maxScanFiles", 1);
  await h.scan();
  assert.ok(h.rows().some((row) => String(row.description).includes("続きあり")));
  assert.equal(h.rows().filter((row) => row.contextValue === "scannedFile").length, 1);
  await h.command("continueScan");
  assert.equal(h.rows().filter((row) => row.contextValue === "scannedFile").length, 2);
  assert.equal(h.badge("outside.md")?.badge, "↵");
});

test("document and byte inspection agree on CR, CRLF, LF, empty and non-ASCII text", () => {
  for (const text of ["", "日本語😀", "a\r", "a\r\nb\n", "\r\r\n\n"]) {
    assert.deepEqual(classifyTextLineEndings(text), classifyLineEndings(new TextEncoder().encode(text)));
  }
});


test("unconfigured unknown encodings are actionable without a made-up expectation", async (t) => {
  const h = await harness(t, { "unknown.txt": new Uint8Array([0x81]) });
  await h.scan();
  assert.equal(h.badge("unknown.txt")?.badge, "?");
  assert.ok(h.rows().some((row) => row.description === "判定不明 · ルール未設定"));
});

test("unconfigured scan preserves size limits and drops obsolete rule baselines", async (t) => {
  const h = await harness(t, { "large.txt": "x".repeat(2048), "small.txt": "ok\n" });
  h.config.set("maxFileSizeKB", 1);
  h.state.set("lineEndingBaseline.v2", { [h.uri("small.txt").toString()]: { kind: "lf", identity: "unavailable:utf8", source: "baseline" } });
  await h.scan();
  assert.ok(h.rows().some((row) => row.label === "文字コード: 除外・未確認" && row.description === "1 件"));
  assert.equal(Object.keys(h.state.get("lineEndingBaseline.v2") as object).length, 0);
});


test("saved-file inspection reads physical mixed endings even if editor text is normalized", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n" });
  h.window.activeTextEditor = { document: {
    uri: h.uri("a.txt"), fileName: "a.txt", encoding: "utf8", isDirty: false, version: 1,
    getText: () => "a\nb\n",
  } };
  await h.runtime.inspectActiveFile();
  assert.match(h.messages.at(-1)!, /改行混在: LF \/ CRLF（保存済みファイル）/);
});

test("saved-file inspection reports unchecked endings when the size limit prevents a read", async (t) => {
  const h = await harness(t, { "large.txt": "x".repeat(2048) });
  h.config.set("maxFileSizeKB", 1);
  h.window.activeTextEditor = { document: {
    uri: h.uri("large.txt"), fileName: "large.txt", encoding: "utf8", isDirty: false, version: 1,
    getText: () => "editor contents",
  } };
  await h.runtime.inspectActiveFile();
  assert.match(h.messages.at(-1)!, /改行: 未確認/);
});


test("skipped files are explicitly unchecked and scan scope changes visibly with rules", async (t) => {
  const h = await harness(t, { "a.txt": "abc", "large.txt": "x".repeat(2048) });
  h.config.set("maxFileSizeKB", 1);
  await h.scan();
  assert.ok(h.rows().some((row) => row.description === "フォルダー全体（ルール未設定）"));
  assert.ok(h.rows().some((row) => row.label?.toString().startsWith("未確認 1 件があります")));
  assert.ok(h.rows().some((row) => row.label === "確認できた 1 件では要注意なし"));
  h.config.set("rules", [{ pattern: "a.txt", encoding: "utf8" }]);
  await h.scan();
  assert.ok(h.rows().some((row) => row.description === "ルール対象のみ（1 件）"));
  assert.ok(h.rows().some((row) => row.tooltip?.toString().includes("対象: a.txt")));
  h.edit("a.txt", "unsaved");
  await h.scan();
  assert.ok(h.rows().some((row) => row.label === "確認できたファイルはありません"));
});

test("rule editing preserves priority; moving and stale operations are guarded", async (t) => {
  const h = await harness(t, {});
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }, { pattern: "**/*", encoding: "shiftjis" }]);
  const second = h.rows().find((row) => row.label === "**/*")!;
  h.picks.push({ encoding: "utf8bom" });
  const beforeEdit = h.changes();
  await h.command("editRule", second);
  assert.ok(h.changes().tree > beforeEdit.tree);
  assert.ok(h.changes().decorations > beforeEdit.decorations);
  let rules = h.config.get("rules") as { pattern: string; encoding: string }[];
  assert.equal(rules[0]?.pattern, "*.txt");
  assert.equal(rules[1]?.encoding, "utf8bom");
  const changed = h.rows().find((row) => row.label === "**/*")!;
  const beforeMove = h.changes();
  await Promise.all([h.command("moveRuleUp", changed), h.command("moveRuleUp", changed)]);
  assert.ok(h.changes().tree > beforeMove.tree);
  assert.ok(h.changes().decorations > beforeMove.decorations);
  rules = h.config.get("rules") as typeof rules;
  assert.equal(rules[0]?.pattern, "**/*");
  await h.command("removeRule", second);
  assert.equal((h.config.get("rules") as unknown[]).length, 2);
  assert.ok(h.messages.some((message) => message.includes("設定が更新")));
  h.picks.push(undefined);
  await h.command("editRule", h.rows().find((row) => row.label === "**/*"));
  assert.equal((h.config.get("rules") as typeof rules)[0]?.encoding, "utf8bom");
});

test("rule edits reject configuration changes while the picker is open", async (t) => {
  const h = await harness(t, {});
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }]);
  const item = h.rows().find((row) => row.label === "*.txt");
  h.picks.push(() => {
    h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }, { pattern: "new/**", encoding: "shiftjis" }]);
    return { encoding: "utf8bom" };
  });
  await h.command("editRule", item);
  assert.equal((h.config.get("rules") as { encoding: string }[])[0]?.encoding, "utf8");
});

test("conversion reports skipped paths and warns before replacing a normal backup", async (t) => {
  const h = await harness(t, { "ready.txt": "abc", "same.txt": new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), "binary.txt": "a\0b", "large.txt": "x".repeat(2048) });
  h.config.set("maxFileSizeKB", 1);
  h.state.set("folderEncodingGuard.lastConversionBackup", h.uri("backup").toString());
  h.information.push("対象外の理由を見る");
  h.picks.push({ encoding: true, eol: false }, { encoding: "utf8bom" }, { encoding: "utf8" }, undefined,
    (items: Record<string, unknown>[]) => items);
  h.confirmations.push("変換する");
  const selection = await h.selection();
  assert.equal(selection?.selected.length, 1);
  assert.equal(selection?.selected[0]?.relativePath, "ready.txt");
  const report = h.shownPicks.find((pick) => pick.title?.includes("候補外のファイル"))!;
  assert.ok(report.items.some((item) => item.label === "binary.txt" && item.description === "バイナリとして除外"));
  assert.ok(report.items.some((item) => item.label === "large.txt" && item.description === "ファイルサイズ上限を超えています"));
  assert.ok(h.messages.some((message) => message.includes("前回の変換は元に戻せなくなります")));
});

test("cancelling backup replacement yields no conversion; protected backups retain their notice", async (t) => {
  const h = await harness(t, { "ready.txt": "abc" });
  const backup = h.uri("backup").toString();
  h.state.set("folderEncodingGuard.lastConversionBackup", backup);
  h.picks.push({ encoding: true, eol: false }, { encoding: "utf8bom" }, { encoding: "utf8" }, (items: unknown[]) => items);
  assert.equal(await h.selection(), undefined);
  assert.equal(h.state.get("folderEncodingGuard.lastConversionBackup"), backup);
  h.state.set("folderEncodingGuard.protectedConversionBackup", backup);
  h.confirmations.push("退避データを残して続ける", "変換する");
  h.picks.push({ encoding: true, eol: false }, { encoding: "utf8bom" }, { encoding: "utf8" }, (items: unknown[]) => items);
  const before = h.messages.length;
  assert.ok(await h.selection());
  assert.ok(h.messages.slice(before).some((message) => message.includes("前回の復元が未完了")));
  assert.ok(!h.messages.slice(before).some((message) => message.includes("前回の変換は元に戻せなくなります")));
});


test("a manual scan retries one delayed file event but respects explicit cancellation", async (t) => {
  const h = await harness(t, { "a.txt": "é\r\nb\n" });
  let delayed = false;
  h.duringDecode(() => { if (!delayed) { delayed = true; h.emit("fileChange", "a.txt"); } });
  await h.scan();
  assert.equal(h.badge("a.txt")?.badge, "↵");
  let calls = 0;
  h.duringDecode(() => { calls += 1; h.emit("fileChange", "a.txt"); h.cancelProgress(); });
  await h.scan();
  assert.equal(calls, 1);
  assert.equal(h.badge("a.txt"), undefined);
});

test("scan exposes skipped paths and reasons", async (t) => {
  const h = await harness(t, { "dirty.txt": "a", "large.txt": "x".repeat(2048), "ok.txt": "a" });
  h.config.set("maxFileSizeKB", 1);
  h.edit("dirty.txt", "changed");
  await h.scan();
  assert.ok(h.rows().some((row) => row.label === "dirty.txt" && row.description === "未保存の変更があります"));
  assert.ok(h.rows().some((row) => row.label === "large.txt" && row.description?.toString().includes("サイズ上限超過")));
});

test("acknowledging local EOL updates only its baseline and rejects stale content", async (t) => {
  const h = await harness(t, { "a.txt": "a\n" });
  h.config.set("rules", [{ pattern: "**/*", encoding: "utf8" }]);
  await h.scan();
  const encodingBaseline = JSON.stringify(h.state.get("encodingBaseline.v1"));
  await writeFile(h.uri("a.txt").fsPath, "a\r\nb\n");
  await h.scan();
  const item = h.rows().find((row) => row.contextValue?.includes("WithLocalEol"));
  assert.ok(item);
  h.confirmations.push("確認済みにする");
  await h.command("acknowledgeLineEndingChange", item);
  assert.equal(JSON.stringify(h.state.get("encodingBaseline.v1")), encodingBaseline);
  assert.ok(!h.rows().some((row) => row.contextValue?.includes("WithLocalEol")));
  assert.ok(h.rows().some((row) => row.contextValue === "mixedLineEndingFinding"));
  await writeFile(h.uri("a.txt").fsPath, "a\r\n");
  await h.scan();
  const stale = h.rows().find((row) => row.contextValue?.includes("WithLocalEol"));
  assert.ok(stale);
  const before = JSON.stringify(h.state.get("lineEndingBaseline.v2"));
  await writeFile(h.uri("a.txt").fsPath, "different\r\n");
  h.confirmations.push("確認済みにする");
  await h.command("acknowledgeLineEndingChange", stale);
  assert.equal(JSON.stringify(h.state.get("lineEndingBaseline.v2")), before);
  assert.ok(h.messages.some((message) => message.includes("比較基準が変わっています")));
});


test("escaped folder rules enumerate broadly and scan only matching files", async (t) => {
  const h = await harness(t, { "legacy/[generated]/a.txt": "a\r\nb\n", "other.txt": "a\r\nb\n" });
  h.config.set("rules", [{ pattern: patternForFolder("legacy/[generated]"), encoding: "utf8" }]);
  await h.scan();
  assert.deepEqual(h.searchPatterns, []);
  assert.equal(h.badge("legacy/[generated]/a.txt")?.badge, "↵");
  assert.equal(h.badge("other.txt"), undefined);
});

test("Western single-byte ambiguity is never preselected for conversion", async (t) => {
  const h = await harness(t, { "western.txt": new Uint8Array([0x82]) });
  const decode = h.workspace.decode;
  const encode = h.workspace.encode;
  h.workspace.decode = async (bytes, options) => {
    if (options.encoding === "iso88591") return String.fromCharCode(...bytes);
    if (options.encoding === "windows1252") return Array.from(bytes, (value) => value === 0x82 ? "‚" : String.fromCharCode(value)).join("");
    return decode(bytes, options);
  };
  h.workspace.encode = async (text, options) => {
    if (options.encoding === "iso88591") return Uint8Array.from(text, (char) => char.charCodeAt(0));
    if (options.encoding === "windows1252") return Uint8Array.from(text, (char) => char === "‚" ? 0x82 : char.charCodeAt(0));
    return encode(text, options);
  };
  h.picks.push({ encoding: true, eol: false }, { encoding: "utf8" }, { encoding: "iso88591" }, (items: Record<string, unknown>[]) => {
    assert.equal(items.length, 1);
    assert.equal(items[0]?.picked, false);
    assert.equal(items[0]?.needsConfirmation, true);
    return undefined;
  });
  await h.selection();
  assert.ok(h.shownPicks.some((pick) => pick.items.some((item) => item.label === "western.txt")));
});


test("legacy save enforcement warns without rewriting successive saves", async (t) => {
  const h = await harness(t, { "a.txt": "initial" });
  h.config.set("rules", [{ pattern: "**/*", encoding: "utf8bom" }]);
  h.config.set("enforceOnSave", true);
  h.config.set("warnOnSave", false);
  await h.save("a.txt", "first");
  await h.save("a.txt", "newest");
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "newest");
  assert.equal(h.messages.filter((message) => message.startsWith("保存注意:")).length, 2);
});


test("file settings override a folder setting without changing sibling files", async (t) => {
  const h = await harness(t, { "one.txt": "a", "two.txt": "b" });
  h.config.set("rules", [{ pattern: "**/*", encoding: "utf8" }]);
  h.picks.push({ encoding: "utf8bom", label: "UTF-8 with BOM" });
  await h.command("configureFile", h.uri("one.txt"));
  assert.equal(h.badge("one.txt")?.badge, "UB");
  assert.equal(h.badge("two.txt")?.badge, "U8");
  assert.ok(h.rows().some((row) => row.label === "期待する文字コード"));
  assert.ok(!h.rows().some((row) => /[0-9]位/.test(String(row.description))));
});

test("scoped scans avoid whole-workspace enumeration and retain other baselines", async (t) => {
  const h = await harness(t, { "part/a.txt": "a\n", "other/b.txt": "b\n" });
  h.config.set("rules", [{ pattern: "**/*", encoding: "utf8" }]);
  await h.scan();
  const before = JSON.stringify((h.state.get("encodingBaseline.v1") as Record<string, unknown>)[h.uri("other/b.txt").toString()]);
  h.searchPatterns.length = 0;
  await h.command("scanSelection", h.uri("part/a.txt"));
  assert.deepEqual(h.searchPatterns, []);
  assert.equal(JSON.stringify((h.state.get("encodingBaseline.v1") as Record<string, unknown>)[h.uri("other/b.txt").toString()]), before);
  assert.ok(h.rows().some((row) => row.label === "今回の解析: part/a.txt"));
  await h.command("scanSelection", h.uri("part"));
  assert.ok(h.rows().some((row) => row.label === "文字コード: ASCII互換" && row.description === "1 件"));
  await h.scan();
  assert.ok(h.rows().some((row) => row.label === "今回の解析: part/ 以下"));
});


test("selected unconfigured files invalidate on changes without reacting to unrelated files", async (t) => {
  const h = await harness(t, { "chosen.txt": "a\r\nb\n", "other.txt": "other" });
  h.config.set("rules", [{ pattern: "other.txt", encoding: "utf8" }]);
  await h.command("scanSelection", h.uri("chosen.txt"));
  assert.equal(h.badge("chosen.txt")?.badge, "↵");
  h.emit("fileChange", "other.txt");
  assert.equal(h.badge("chosen.txt")?.badge, "↵");
  h.emit("fileChange", "chosen.txt");
  assert.equal(h.badge("chosen.txt"), undefined);
  assert.ok(h.rows().some((row) => row.label === "今回の解析: chosen.txt"));
});

test("cancelling the scope picker does not start a whole-workspace scan", async (t) => {
  const h = await harness(t, { "a.txt": "a" });
  h.picks.push(undefined);
  await h.command("scanSelection");
  assert.deepEqual(h.searchPatterns, []);
});


test("mixed-ending choices support a denied file inside an allowed folder and inheritance", async (t) => {
  const h = await harness(t, { "data/a.csv": "a\r\nb\n", "data/b.csv": "a\r\nb\n" });
  h.picks.push({ label: "許容する", allow: true });
  await h.command("configureMixedPolicy", h.uri("data"));
  await h.scan();
  assert.equal(h.badge("data/a.csv"), undefined);
  h.picks.push({ label: "許容しない", allow: false });
  await h.command("configureMixedPolicy", h.uri("data/a.csv"));
  await h.scan();
  assert.equal(h.badge("data/a.csv")?.badge, "↵");
  assert.equal(h.badge("data/b.csv"), undefined);
  const denied = h.rows().find((row) => row.label === "data/a.csv" && String(row.description).startsWith("許容しない"));
  assert.ok(denied);
  const finding = h.rows().find((row) => row.contextValue === "mixedLineEndingFinding");
  h.picks.push({ folder: false });
  h.information.push("元に戻す");
  await h.command("allowMixedLineEndings", finding);
  await h.scan();
  assert.equal(h.badge("data/a.csv")?.badge, "↵");
  await h.command("removeMixedAllowance", denied);
  assert.equal(h.badge("data/a.csv"), undefined);
  assert.equal(await readFile(h.uri("data/a.csv").fsPath, "utf8"), "a\r\nb\n");
  h.picks.push(undefined);
  const before = JSON.stringify([...h.config]);
  await h.command("configureMixedPolicy", h.uri("data/a.csv"));
  assert.equal(JSON.stringify([...h.config]), before);
});


test("folder-scoped scans ignore excluded changes while direct file scopes observe them", async (t) => {
  const h = await harness(t, { "part/a.txt": "a\r\nb\n", "part/node_modules/b.txt": "a\r\nb\n" });
  await h.command("scanSelection", h.uri("part"));
  assert.equal(h.badge("part/a.txt")?.badge, "↵");
  h.emit("fileChange", "part/node_modules/b.txt");
  assert.equal(h.badge("part/a.txt")?.badge, "↵");
  await h.command("scanSelection", h.uri("part/node_modules/b.txt"));
  assert.equal(h.badge("part/node_modules/b.txt")?.badge, "↵");
  h.emit("fileChange", "part/node_modules/b.txt");
  assert.equal(h.badge("part/node_modules/b.txt"), undefined);
});


test("mixed policy shows inherited and exact settings and restores failed writes", async (t) => {
  const h = await harness(t, { "data/a.csv": "a\r\nb\n" });
  h.config.set("allowedMixedLineEndings", ["data/"]);
  await h.command("configureMixedPolicy", h.uri("data/a.csv"));
  assert.match(h.shownPicks.at(-1)!.title!, /現在：許容する.*data\/ から継承/);
  await h.command("configureMixedPolicy", h.uri("data"));
  assert.match(h.shownPicks.at(-1)!.title!, /現在：許容する.*この対象の指定/);
  h.configFailures.push("allowedMixedLineEndings");
  h.picks.push({ allow: false });
  await h.command("configureMixedPolicy", h.uri("data/a.csv"));
  assert.deepEqual(h.config.get("allowedMixedLineEndings"), ["data/"]);
  assert.equal(h.config.has("disallowedMixedLineEndings"), false);
  assert.ok(h.messages.some((message) => message.includes("元の設定に戻しました")));
  h.configFailures.push("allowedMixedLineEndings", "disallowedMixedLineEndings");
  h.picks.push({ allow: false });
  await h.command("configureMixedPolicy", h.uri("data/a.csv"));
  assert.ok(h.messages.some((message) => message.includes("復元に失敗")));
});

test("allowed mixed endings start unselected and final confirmation explains all newlines", async (t) => {
  const h = await harness(t, { "data.csv": "a\r\nb\n" });
  h.config.set("allowedMixedLineEndings", ["data.csv"]);
  h.picks.push({ encoding: false, eol: true }, { value: "lf" }, { encoding: "utf8" }, (items: Record<string, unknown>[]) => {
    assert.equal(items[0]?.picked, false);
    assert.equal(items[0]?.changesAllowedMixedEndings, true);
    assert.match(String(items[0]?.description), /許容済みの混在を統一/);
    return items;
  });
  h.confirmations.push("変換する");
  assert.ok(await h.selection());
  assert.ok(h.messages.some((message) => message.includes("セル内改行を含むすべての改行")));
  assert.equal(await readFile(h.uri("data.csv").fsPath, "utf8"), "a\r\nb\n");
});

test("additional scans retain findings without recounting overlaps and retry skipped files", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n", "b.txt": "a\r\nb\n" });
  await h.command("scanSelection", h.uri("a.txt"));
  await h.command("addScanSelection", h.uri("a.txt"));
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 1 件/);
  await h.command("addScanSelection", h.uri("b.txt"));
  assert.equal(h.badge("a.txt")?.badge, "↵");
  assert.equal(h.badge("b.txt")?.badge, "↵");
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 2 件/);
  h.emit("fileChange", "a.txt");
  assert.equal(h.badge("b.txt"), undefined);
  await h.scan();
  assert.equal(h.badge("a.txt")?.badge, "↵");
  assert.equal(h.badge("b.txt")?.badge, "↵");
  h.edit("b.txt", "a\n");
  await h.command("scanSelection", h.uri("b.txt"));
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /未確認 1 件/);
  h.workspace.textDocuments = [];
  await h.command("addScanSelection", h.uri("b.txt"));
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 1 件 · 未確認 0 件/);
});

test("cancelling an additional scan preserves the previous results and scope", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n", "b.txt": "日本語\r\nb\n" });
  await h.command("scanSelection", h.uri("a.txt"));
  h.duringDecode(() => h.cancelProgress());
  await h.command("addScanSelection", h.uri("b.txt"));
  assert.equal(h.badge("a.txt")?.badge, "↵");
  assert.equal(h.badge("b.txt"), undefined);
  assert.equal(h.rows().find((row) => row.label === "確認範囲")?.description, "a.txt");
});


test("single-folder rollback restores its existing workspace-level values", async (t) => {
  const h = await harness(t, { "a.txt": "a\n" });
  h.workspace.workspaceFile = undefined;
  h.config.set("allowedMixedLineEndings", ["a.txt"]);
  h.configFailures.push("allowedMixedLineEndings");
  h.picks.push({ allow: false });
  await h.command("configureMixedPolicy", h.uri("a.txt"));
  assert.deepEqual(h.config.get("allowedMixedLineEndings"), ["a.txt"]);
  assert.equal(h.config.has("disallowedMixedLineEndings"), false);
});

test("refresh preserves explicitly added files outside the workspace rules", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n", "b.csv": "a\r\nb\n", "c.csv": "a\r\nb\n" });
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }]);
  await h.scan();
  await h.command("addScanSelection", h.uri("b.csv"));
  await h.scan();
  assert.equal(h.badge("a.txt")?.badge, "↵");
  assert.equal(h.badge("b.csv")?.badge, "↵");
  assert.equal(h.badge("c.csv"), undefined);
});


test("outer directory selection includes nested workspace roots", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n", "nested/b.txt": "a\r\nb\n" });
  h.workspace.workspaceFolders.push({ uri: h.uri("nested"), name: "nested", index: 1 });
  await h.command("scanSelection", h.uri(""));
  assert.equal(h.badge("a.txt")?.badge, "↵");
  assert.equal(h.badge("nested/b.txt")?.badge, "↵");
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 2 件/);
});

test("scoped refresh removes deleted baselines while keeping unselected files", async (t) => {
  const input: Record<string, string> = { "part/a.txt": "日本語\n", "outside.txt": "日本語\n" };
  const h = await harness(t, input);
  h.config.set("rules", [{ pattern: "**/*", encoding: "utf8" }]);
  await h.scan();
  const outside = h.uri("outside.txt").toString();
  const removed = h.uri("part/a.txt").toString();
  await rm(h.uri("part/a.txt").fsPath);
  delete input["part/a.txt"];
  await h.command("scanSelection", h.uri("part"));
  for (const key of ["encodingBaseline.v1", "lineEndingBaseline.v2"]) {
    const baseline = h.state.get(key) as Record<string, unknown>;
    assert.ok(baseline[outside]);
    assert.equal(baseline[removed], undefined);
  }
});


test("large folders expose the first 100 files without scanning or listing everything", async (t) => {
  const input = Object.fromEntries(Array.from({ length: 5101 }, (_, i) => [`file-${String(i).padStart(4, "0")}.txt`, "hello\n"]));
  const h = await harness(t, input);
  await h.command("scanSelection", h.uri(""));
  assert.deepEqual(h.searchLimits, []);
  let rows = h.rows().filter((row) => row.contextValue === "scannedFile");
  assert.equal(rows.length, 100);
  assert.match(String(rows[0]?.description), /ASCII互換 \/ LF · 注意なし/);
  assert.equal(rows[0]?.command?.command, "vscode.open");
  const firstLabels = rows.map((row) => row.label);
  assert.ok(h.rows().some((row) => row.label === "続きを解析（最大100件）"));
  await h.command("continueScan");
  assert.deepEqual(h.searchLimits, []);
  rows = h.rows().filter((row) => row.contextValue === "scannedFile");
  assert.equal(rows.length, 100);
  assert.ok(rows.every((row) => !firstLabels.includes(row.label)));
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 200 件/);
  await h.command("showFilesPage", -1);
  assert.deepEqual(h.rows().filter((row) => row.contextValue === "scannedFile").map((row) => row.label), firstLabels);
  assert.deepEqual(h.messages.filter((message) => message.includes("件を超えました")), []);
});

test("continuation reaches the end without retrying skipped files or duplicating findings", async (t) => {
  const h = await harness(t, { "large.txt": "a".repeat(2048), "mixed.txt": "a\r\nb\n", "ok.txt": "hello\n" });
  h.config.set("maxScanFiles", 1);
  h.config.set("maxFileSizeKB", 1);
  await h.scan();
  await h.command("continueScan");
  await h.command("continueScan");
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 2 件 · 未確認 1 件/);
  assert.ok(!h.rows().some((row) => row.label === "続きを解析（最大100件）"));
  assert.equal(h.rows().filter((row) => row.contextValue === "mixedLineEndingFinding").length, 1);
  const before = h.searchPatterns.length;
  await h.command("continueScan");
  assert.equal(h.searchPatterns.length, before);
});

test("page cancellation preserves the cursor and refresh restarts the small preview", async (t) => {
  const h = await harness(t, { "a.txt": "日本語\n", "b.txt": "日本語\n" });
  h.config.set("maxScanFiles", 1);
  await h.scan();
  h.duringDecode(() => h.cancelProgress());
  await h.command("continueScan");
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 1 件/);
  h.duringDecode(() => {});
  await h.command("continueScan");
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 2 件/);
  await h.scan();
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 1 件/);
});

test("filtered candidates advance the cursor and do not erase unseen baselines", async (t) => {
  const h = await harness(t, { "skip.md": "hello\n", "keep.txt": "日本語\n" });
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }]);
  await h.scan();
  const key = h.uri("keep.txt").toString();
  const before = (h.state.get("encodingBaseline.v1") as Record<string, unknown>)[key];
  h.config.set("maxScanFiles", 1);
  await h.scan();
  assert.deepEqual((h.state.get("encodingBaseline.v1") as Record<string, unknown>)[key], before);
  await h.command("continueScan");
  assert.ok(h.rows().some((row) => row.contextValue === "scannedFile" && row.label === "keep.txt"));
  assert.ok(!h.rows().some((row) => row.label === "続きを解析（最大100件）"));
});


test("nested roots can be paged without exceeding limits or recounting their files", async (t) => {
  const h = await harness(t, { "a.txt": "hello\n", "nested/b.txt": "hello\n" });
  h.workspace.workspaceFolders.push({ uri: h.uri("nested"), name: "nested", index: 1 });
  h.config.set("maxScanFiles", 1);
  await h.command("scanSelection", h.uri(""));
  await h.command("continueScan");
  assert.match(String(h.rows().find((row) => row.label === "状況")?.description), /確認済み 2 件/);
  assert.ok(!h.rows().some((row) => row.label === "続きを解析（最大100件）"));
});

test("findings from individually added workspace roots keep their identity", async (t) => {
  const h = await harness(t, { "left/a.txt": "a\r\nb\n", "right/a.txt": "a\r\nb\n" });
  h.workspace.workspaceFolders.splice(0, 1,
    { uri: h.uri("left"), name: "left", index: 0 },
    { uri: h.uri("right"), name: "right", index: 1 });
  await h.command("scanSelection", h.uri("left/a.txt"));
  await h.command("addScanSelection", h.uri("right/a.txt"));
  const findings = h.rows().filter((row) => row.contextValue === "mixedLineEndingFinding");
  assert.deepEqual(findings.map((row) => row.label).sort(), ["left/a.txt", "right/a.txt"]);
  assert.ok(findings.every((row) => String(row.tooltip).includes(row.resourceUri!.fsPath)));
});


test("rules-only retained scopes ignore unmatched changes but track explicit additions", async (t) => {
  const h = await harness(t, { "a.txt": "a\r\nb\n", "b.csv": "a\r\nb\n", "unrelated.md": "hello" });
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }]);
  await h.scan();
  await h.command("addScanSelection", h.uri("b.csv"));
  h.emit("fileChange", "unrelated.md");
  h.emit("fileCreate", "another.md");
  assert.equal(h.badge("a.txt")?.badge, "↵");
  assert.equal(h.badge("b.csv")?.badge, "↵");
  h.emit("fileChange", "b.csv");
  assert.ok(h.rows().some((row) => row.description === "変更あり・再確認が必要"));
});

test("attribute changes invalidate only ancestor or contained scopes", async (t) => {
  const h = await harness(t, { "part/a.txt": "a\r\nb\n", "other/.gitattributes": "*.txt eol=lf" });
  await h.command("scanSelection", h.uri("part/a.txt"));
  h.workspace.workspaceFolders.push({ uri: h.uri("other"), name: "other", index: 1 });
  h.emit("fileChange", "other/.gitattributes");
  assert.equal(h.badge("part/a.txt")?.badge, "↵");
  h.emit("fileChange", ".gitattributes");
  assert.equal(h.badge("part/a.txt"), undefined);
  await h.command("scanSelection", h.uri("part"));
  h.emit("fileChange", "part/nested/.gitattributes");
  assert.equal(h.badge("part/a.txt"), undefined);
});

test("a missing direct target loses both baselines without treating permission errors as deletion", async (t) => {
  const h = await harness(t, { "a.txt": "日本語\n" });
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }]);
  await h.command("scanSelection", h.uri("a.txt"));
  const key = h.uri("a.txt").toString();
  const originalStat = h.workspace.fs.stat;
  h.workspace.fs.stat = async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  await h.scan();
  for (const setting of ["encodingBaseline.v1", "lineEndingBaseline.v2"]) assert.ok((h.state.get(setting) as Record<string, unknown>)[key]);
  h.workspace.fs.stat = originalStat;
  await rm(h.uri("a.txt").fsPath);
  await h.scan();
  for (const setting of ["encodingBaseline.v1", "lineEndingBaseline.v2"]) assert.equal((h.state.get(setting) as Record<string, unknown>)[key], undefined);
  await writeFile(h.uri("a.txt").fsPath, "別の内容\r\n");
  await h.scan();
  assert.ok(!h.rows().some((row) => row.contextValue?.includes("WithChange") || row.contextValue?.includes("WithLocalEol")));
});

test("adding an unconfigured page does not reset an existing Git warning signature", async t => {
  const h = await harness(t, { "a.txt": "hello\n", "b.md": "hello\n" });
  h.config.set("rules", [{ pattern: "*.txt", encoding: "utf8" }]);
  await h.command("scanSelection", h.uri("a.txt"));
  const warnings = () => h.messages.filter(message => message.startsWith("Gitによる規則・履歴の確認に注意があります"));
  assert.equal(warnings().length, 1);
  const signature = h.state.get("gitRuleWarningState.v1");
  await h.command("addScanSelection", h.uri("b.md"));
  assert.equal(h.state.get("gitRuleWarningState.v1"), signature);
  await h.scan();
  assert.equal(warnings().length, 1);
});

test("unreadable subtrees stay unconfirmed, preserve baselines and allow other files to finish", async t => {
  const h = await harness(t, { "locked/a.txt": "日本語\n", "healthy/b.txt": "日本語\n" });
  h.config.set("rules", [{ pattern: "**/*.txt", encoding: "utf8" }]);
  await h.scan();
  const key = h.uri("locked/a.txt").toString();
  h.unreadableDirectories.add("locked");
  await h.scan();
  assert.equal(h.rows().find(row => String(row.description).includes("配下は未確認"))?.command?.command, "revealInExplorer");
  assert.ok(h.rows().some(row => row.contextValue === "scannedFile" && row.label === "healthy/b.txt"));
  assert.ok(!h.messages.some(message => message.includes("スキャンに失敗")));
  assert.ok(!h.rows().some(row => row.label === "続きを解析（最大100件）"));
  for (const setting of ["encodingBaseline.v1", "lineEndingBaseline.v2"]) assert.ok((h.state.get(setting) as Record<string, unknown>)[key]);
  h.unreadableDirectories.clear();
  await h.command("addScanSelection", h.uri("locked"));
  assert.ok(!h.rows().some(row => String(row.description).includes("配下は未確認")));
  await h.scan();
  assert.equal(h.rows().filter(row => row.contextValue === "scannedFile").length, 2);
});

test("single file conversion skips folder enumeration, preserves EOL and confirms rule mismatch", async t => {
  const h = await harness(t, { "a.txt": "日本語\r\n内部\n", "b.txt": "other" });
  h.config.set("conversionExclude", "**/*");
  h.picks.push({ encoding: "utf8bom" }, { encoding: "utf8" });
  h.confirmations.push("変換する");
  const selection = await h.fileSelection("a.txt", "utf8");
  assert.equal(selection?.selected.length, 1);
  assert.equal(selection?.selected[0]?.uri.toString(), h.uri("a.txt").toString());
  assert.equal(selection?.targetEncoding, "utf8bom");
  assert.equal(selection?.targetLineEnding, undefined);
  assert.deepEqual(h.searchPatterns, []);
  assert.equal(h.shownPicks.length, 2);
  assert.ok(h.messages.some(message => message.includes("内容のプレビュー") && message.includes("ルールは変更しません")));
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "日本語\r\n内部\n");
});

test("single file conversion refuses dirty documents and supports cancelling confirmation", async t => {
  const h = await harness(t, { "a.txt": "日本語\n" });
  h.workspace.textDocuments.push({ uri: h.uri("a.txt"), isDirty: true });
  assert.equal(await h.fileSelection("a.txt"), undefined);
  assert.equal(h.shownPicks.length, 0);
  assert.ok(h.messages.some(message => message.includes("先にファイルを保存")));
  h.workspace.textDocuments.length = 0;
  h.picks.push({ encoding: "utf8bom" }, { encoding: "utf8" });
  assert.equal(await h.fileSelection("a.txt"), undefined);
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "日本語\n");
});

test("single file conversion explains unrepresentable content without saving", async t => {
  const h = await harness(t, { "a.txt": "日本語\n" });
  h.picks.push({ encoding: "windows1252" }, { encoding: "utf8" });
  assert.equal(await h.fileSelection("a.txt"), undefined);
  assert.ok(h.messages.some(message => message.includes("変換先で表現できない文字")));
  assert.equal(await readFile(h.uri("a.txt").fsPath, "utf8"), "日本語\n");
});

test("single file conversion reports no change when source and target match", async t => {
  const h = await harness(t, { "a.txt": "日本語\n" });
  h.picks.push({ encoding: "utf8" }, { encoding: "utf8" });
  assert.equal(await h.fileSelection("a.txt"), undefined);
  assert.ok(h.shownPicks[1]?.items.some(item => item.encoding === "utf8"));
  assert.ok(h.messages.some(message => message.includes("変換不要")));
});
