import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
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
  const state = new Map<string, unknown>();
  const messages: string[] = [];
  const picks: unknown[] = [];
  const confirmations: string[] = [];
  const information: string[] = [];
  const shownPicks: { items: Record<string, unknown>[]; title?: string }[] = [];
  const searchPatterns: string[] = [];
  let treeChanges = 0;
  let decorationChanges = 0;
  const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let provider: import("../src/encodingView.js").RulesProvider | undefined;
  let decorations: import("../src/encodingView.js").EncodingDecorationProvider | undefined;
  let duringDecode: (() => void) | undefined;
  let progressCancellation: Cancellation | undefined;
  const disposable = { dispose() {} };
  const workspace = {
    workspaceFolders: [folder], textDocuments: [] as unknown[],
    getWorkspaceFolder: (uri: Uri) => (uri.fsPath === root || uri.fsPath.startsWith(root + path.sep)) ? folder : undefined,
    getConfiguration: () => ({ get: (key: string, fallback?: unknown) => config.get(key) ?? fallback,
      update: async (key: string, value: unknown) => {
        config.set(key, value); events.get("configuration")?.fire({ affectsConfiguration: () => true });
      },
    }),
    findFiles: async (pattern: { pattern: string }, exclude: string, limit: number) => { searchPatterns.push(pattern.pattern); return Object.keys(input)
      .filter((name) => minimatch(name, pattern.pattern, { dot: true }) && !minimatch(name, exclude, { dot: true }))
      .slice(0, limit).map((name) => Uri.file(path.join(root, name))); },
    fs: { stat: async (uri: Uri) => { const s = await stat(uri.fsPath); return { type: 1, size: s.size }; } },
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
    StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 }, FileType: { File: 1 }, ConfigurationTarget: { WorkspaceFolder: 3 },
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
    module, exports: module.exports, require: (id: string) => id === "vscode" ? vscode : nativeRequire(id),
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
    config, state, messages, window, workspace, runtime, picks, confirmations, information, shownPicks, searchPatterns,
    changes: () => ({ tree: treeChanges, decorations: decorationChanges }),
    command: (name: string, ...args: unknown[]) => commands.get(`folderEncodingGuard.${name}`)!(...args),
    selection: () => runtime.selectConversion(context, () => undefined,
      () => workspace.getConfiguration() as unknown as import("vscode").WorkspaceConfiguration,
      folder.uri as import("vscode").Uri),
    uri: (name: string) => Uri.file(path.join(root, name)),
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
  assert.match(h.messages.at(-1)!, /フォルダールールはありません/);
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
  assert.ok(h.messages.some((message) => message.includes("1 件を超えました")));
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
  assert.deepEqual(h.searchPatterns, ["**/*"]);
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
