import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { CancellationTokenLike } from "../src/gitProcess.js";
import {
  createGitInspectionBudget,
  chunkGitArguments,
  inspectGitRepository,
  isPartialCloneRepository,
  readRepositoryHead,
  readStagedRenameSnapshot,
  RepositoryInspectionTarget,
} from "../src/gitRepositoryInspection.js";

test("chunks fully decorated Git arguments within the process limit", () => {
  const prefix = ":(top,literal,icase)";
  const argumentsToChunk = Array.from(
    { length: 2_000 },
    (_value, index) => `${prefix}file-${index}.txt`,
  );
  const chunks = chunkGitArguments(argumentsToChunk, 24_000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) =>
    chunk.reduce((size, value) => size + Buffer.byteLength(value) + 1, 0) <= 24_000,
  ));
});

const neverCancelled: CancellationTokenLike = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

const gitHelp = spawnSync("git", ["check-attr", "-h"], {
  encoding: "utf8",
  env: gitEnvironmentWithoutCommandOverrides(),
});
const gitTestOptions = {
  skip: gitHelp.error || !`${gitHelp.stdout}${gitHelp.stderr}`.includes("--source")
    ? "Git 2.41以降が必要です"
    : false,
};
const nonWindowsGitTestOptions = {
  skip: gitTestOptions.skip || process.platform === "win32"
    ? gitTestOptions.skip || "Unix filesystem behavior is required"
    : false,
};

test("reads raw HEAD content with HEAD attributes and current attributes separately", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, ".gitattributes"), "*.txt text eol=lf\n");
  writeFileSync(path.join(repository, "sample.txt"), "one\ntwo\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  writeFileSync(path.join(repository, ".gitattributes"), "*.txt text eol=crlf\n");
  writeFileSync(path.join(repository, "sample.txt"), "one\r\ntwo\r\n");
  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "sample",
      currentPath: "sample.txt",
      headPath: "sample.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: true,
    })],
    neverCancelled,
  );

  assert.equal(result.get("sample")?.expectedLineEnding, "crlf");
  assert.equal(result.get("sample")?.attributeLookupFailed, false);
  assert.deepEqual(result.get("sample")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
  assert.match(result.get("sample")?.historyIdentity ?? "", /^git:/);
});

test("preserves the style set of mixed HEAD line endings", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "sample.txt"), "one\ntwo\r\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "sample",
      currentPath: "sample.txt",
      headPath: "sample.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("sample")?.head, {
    kind: "found",
    lineEndings: { kind: "mixed", styles: ["lf", "crlf"] },
  });
});

test("matches decomposed macOS paths to normalized Git tree paths", {
  ...gitTestOptions,
  skip: gitTestOptions.skip || process.platform !== "darwin"
    ? gitTestOptions.skip || "macOS固有の検証です"
    : false,
}, async (context) => {
  const repository = createRepository(context);
  const decomposedPath = "e\u0301.txt";
  git(repository, "config", "core.precomposeunicode", "true");
  writeFileSync(path.join(repository, decomposedPath), "one\ntwo\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "accented",
      currentPath: decomposedPath,
      headPath: decomposedPath,
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("accented")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
});

test("matches case-only working-tree names when Git ignores case", {
  ...gitTestOptions,
  skip: gitTestOptions.skip || process.platform !== "darwin"
    ? gitTestOptions.skip || "case-insensitive macOS filesystem向けの検証です"
    : false,
}, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "sample.txt"), "one\ntwo\n");
  commitAll(repository);
  git(repository, "config", "core.ignorecase", "true");
  renameSync(
    path.join(repository, "sample.txt"),
    path.join(repository, "Sample.txt"),
  );
  writeFileSync(path.join(repository, "Sample.txt"), "one\r\ntwo\r\n");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "case-only",
      currentPath: "Sample.txt",
      headPath: "Sample.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("case-only")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
});

test("keeps untracked paths absent without failing tracked history in ignore-case repositories", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "tracked.txt"), "one\ntwo\n");
  commitAll(repository);
  git(repository, "config", "core.ignorecase", "true");
  writeFileSync(path.join(repository, "untracked.txt"), "new\n");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [
      target(repository, {
        key: "tracked",
        currentPath: "tracked.txt",
        headPath: "tracked.txt",
        expectedEncoding: "utf8",
        maxSize: 1024,
        readCurrentAttributes: false,
      }),
      target(repository, {
        key: "untracked",
        currentPath: "untracked.txt",
        headPath: "untracked.txt",
        expectedEncoding: "utf8",
        maxSize: 1024,
        readCurrentAttributes: false,
      }),
    ],
    neverCancelled,
  );

  assert.equal(result.get("tracked")?.head.kind, "found");
  assert.deepEqual(result.get("untracked")?.head, { kind: "absent" });
});

test("prefers the exact HEAD spelling for a staged case-only rename", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "sample.txt"), "one\ntwo\n");
  commitAll(repository);
  git(repository, "config", "core.ignorecase", "true");
  git(repository, "mv", "sample.txt", "temporary.txt");
  git(repository, "mv", "temporary.txt", "Sample.txt");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  const staged = await readStagedRenameSnapshot(
    "git",
    repository,
    headCommit,
    neverCancelled,
  );
  assert.equal(staged.kind, "found");
  const headPath = staged.kind === "found"
    ? staged.headPathByCurrentPath.get("sample.txt") ?? "sample.txt"
    : "sample.txt";

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "renamed",
      currentPath: "Sample.txt",
      headPath,
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );
  assert.equal(result.get("renamed")?.head.kind, "found");
});

test("ignores replace refs when reading the committed baseline", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  const tracked = path.join(repository, "tracked.txt");
  const replacement = path.join(repository, "replacement.txt");
  writeFileSync(tracked, "one\ntwo\n");
  commitAll(repository);
  writeFileSync(replacement, "one\r\ntwo\r\n");
  const originalBlob = git(repository, "rev-parse", "HEAD:tracked.txt").trim();
  const replacementBlob = git(repository, "hash-object", "-w", replacement).trim();
  git(repository, "replace", originalBlob, replacementBlob);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "tracked",
      currentPath: "tracked.txt",
      headPath: "tracked.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("tracked")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
});

test("reads a staged rename from the index and compares its original HEAD path", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "old.txt"), "one\ntwo\n");
  commitAll(repository);
  git(repository, "mv", "old.txt", "new.txt");
  writeFileSync(path.join(repository, "new.txt"), "one\r\ntwo\r\n");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  const staged = await readStagedRenameSnapshot(
    "git",
    repository,
    headCommit,
    neverCancelled,
  );

  assert.equal(staged.kind, "found");
  assert.equal(
    staged.kind === "found" ? staged.headPathByCurrentPath.get("new.txt") : undefined,
    "old.txt",
  );
  assert.equal(
    staged.kind === "found" ? staged.uncertainCurrentPaths.has("new.txt") : true,
    false,
  );
  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "renamed",
      currentPath: "new.txt",
      headPath: staged.kind === "found"
        ? staged.headPathByCurrentPath.get("new.txt")
        : undefined,
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("renamed")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
});

test("fails history safely for a staged rename with edited content", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "old.txt"), "one\ntwo\n");
  commitAll(repository);
  git(repository, "mv", "old.txt", "new.txt");
  writeFileSync(path.join(repository, "new.txt"), "one\r\ntwo\r\n");
  git(repository, "add", "-A");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  const staged = await readStagedRenameSnapshot(
    "git",
    repository,
    headCommit,
    neverCancelled,
  );

  assert.equal(staged.kind, "found");
  assert.equal(
    staged.kind === "found" ? staged.headPathByCurrentPath.get("new.txt") : undefined,
    undefined,
  );
  assert.equal(
    staged.kind === "found" ? staged.uncertainCurrentPaths.has("new.txt") : false,
    true,
  );
  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "renamed",
      currentPath: "new.txt",
      headPath: "new.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
      historyPreconditionFailed: true,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("renamed")?.head, { kind: "failed" });
});

test("fails history safely when identical deleted files make a staged rename ambiguous", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "a.txt"), "same\n");
  writeFileSync(path.join(repository, "b.txt"), "same\n");
  commitAll(repository);
  renameSync(path.join(repository, "b.txt"), path.join(repository, "c.txt"));
  rmSync(path.join(repository, "a.txt"));
  git(repository, "add", "-A");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const staged = await readStagedRenameSnapshot(
    "git",
    repository,
    headCommit,
    neverCancelled,
  );
  assert.equal(staged.kind, "found");
  assert.equal(
    staged.kind === "found" ? staged.uncertainCurrentPaths.has("c.txt") : false,
    true,
  );
});

test("fails history safely for multiple exact renames of identical blobs", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "a.txt"), "same\n");
  writeFileSync(path.join(repository, "b.txt"), "same\n");
  commitAll(repository);
  renameSync(path.join(repository, "a.txt"), path.join(repository, "d.txt"));
  renameSync(path.join(repository, "b.txt"), path.join(repository, "c.txt"));
  git(repository, "add", "-A");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const staged = await readStagedRenameSnapshot(
    "git",
    repository,
    headCommit,
    neverCancelled,
  );
  assert.equal(staged.kind, "found");
  if (staged.kind === "found") {
    assert.equal(staged.headPathByCurrentPath.size, 2);
    assert.equal(staged.uncertainCurrentPaths.has("c.txt"), true);
    assert.equal(staged.uncertainCurrentPaths.has("d.txt"), true);
  }
});

test("fails history safely when an exact rename competes with an identical addition", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "a.txt"), "same\n");
  commitAll(repository);
  renameSync(path.join(repository, "a.txt"), path.join(repository, "c.txt"));
  writeFileSync(path.join(repository, "b.txt"), "same\n");
  git(repository, "add", "-A");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const staged = await readStagedRenameSnapshot(
    "git",
    repository,
    headCommit,
    neverCancelled,
  );
  assert.equal(staged.kind, "found");
  if (staged.kind === "found") {
    assert.equal(staged.uncertainCurrentPaths.has("b.txt"), true);
    assert.equal(staged.uncertainCurrentPaths.has("c.txt"), true);
  }
});

test("accepts uppercase Git boolean values while reading staged state", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "tracked.txt"), "base\n");
  commitAll(repository);
  git(repository, "config", "core.ignorecase", "TRUE");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  assert.equal(
    (await readStagedRenameSnapshot(
      "git",
      repository,
      headCommit,
      neverCancelled,
    )).kind,
    "found",
  );
});

test("does not execute an external checkout filter while reading HEAD", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  const filterDriver = `marker-${path.basename(repository).replaceAll(".", "-")}`;
  const marker = path.join(repository, "filter-ran");
  const filterScript = path.join(repository, "marker-filter.cjs");
  writeFileSync(
    filterScript,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");process.stdin.pipe(process.stdout);`,
  );
  writeFileSync(
    path.join(repository, ".gitattributes"),
    `filtered.txt filter=${filterDriver} text eol=lf\n`,
  );
  writeFileSync(path.join(repository, "filtered.txt"), "one\ntwo\n");
  commitAll(repository);
  git(
    repository,
    "config",
    `filter.${filterDriver}.smudge`,
    quoteCommand(process.execPath, filterScript),
  );
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "filtered",
      currentPath: "filtered.txt",
      headPath: "filtered.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("filtered")?.head, { kind: "failed" });
  assert.equal(existsSync(marker), false);
});

test("treats a configured filter named unset as external without running it", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  const marker = path.join(repository, "filter-unset-ran");
  const filterScript = path.join(repository, "unset-filter.cjs");
  writeFileSync(
    filterScript,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");process.stdin.pipe(process.stdout);`,
  );
  writeFileSync(
    path.join(repository, ".gitattributes"),
    "filtered.txt filter=unset text eol=lf\n",
  );
  writeFileSync(path.join(repository, "filtered.txt"), "one\ntwo\n");
  commitAll(repository);
  git(
    repository,
    "config",
    "filter.unset.smudge",
    quoteCommand(process.execPath, filterScript),
  );
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "filtered",
      currentPath: "filtered.txt",
      headPath: "filtered.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("filtered")?.head, { kind: "failed" });
  assert.equal(existsSync(marker), false);
});

test("fails safely for a required filter without a checkout command", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, ".gitattributes"), "filtered.txt filter=required text\n");
  writeFileSync(path.join(repository, "filtered.txt"), "one\ntwo\n");
  commitAll(repository);
  git(repository, "config", "filter.required.clean", "cat");
  git(repository, "config", "filter.required.required", "true");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "filtered",
      currentPath: "filtered.txt",
      headPath: "filtered.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("filtered")?.head, { kind: "failed" });
});

test("treats an empty working-tree encoding as disabled", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "sample.txt"), "one\ntwo\n");
  commitAll(repository);
  writeFileSync(
    path.join(repository, ".gitattributes"),
    "sample.txt working-tree-encoding=\n",
  );
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "sample",
      currentPath: "sample.txt",
      headPath: "sample.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("sample")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
});

test("does not treat a committed symlink target as text history", nonWindowsGitTestOptions, async (context) => {
  const repository = createRepository(context);
  symlinkSync("target", path.join(repository, "sample.txt"));
  commitAll(repository);
  rmSync(path.join(repository, "sample.txt"));
  writeFileSync(path.join(repository, "sample.txt"), "one\ntwo\n");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "sample",
      currentPath: "sample.txt",
      headPath: "sample.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("sample")?.head, { kind: "failed" });
});

test("does not treat a committed gitlink as absent after a working-tree type change", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "tracked.txt"), "base\n");
  commitAll(repository);
  const linkedCommit = git(repository, "rev-parse", "HEAD").trim();
  git(
    repository,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${linkedCommit},module`,
  );
  commitIndex(repository);
  writeFileSync(path.join(repository, "module"), "regular file\n");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "module",
      currentPath: "module",
      headPath: "module",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("module")?.head, { kind: "failed" });
});

test("honors legacy crlf when resolving current eol rules", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  const fsMonitorMarker = path.join(repository, "fsmonitor-ran");
  const fsMonitorScript = path.join(repository, "fsmonitor.cjs");
  writeFileSync(
    path.join(repository, ".gitattributes"),
    "sample.txt -crlf eol=crlf\n",
  );
  writeFileSync(path.join(repository, "sample.txt"), "one\ntwo\n");
  writeFileSync(
    fsMonitorScript,
    `require("node:fs").writeFileSync(${JSON.stringify(fsMonitorMarker)},"ran")`,
  );
  git(repository, "config", "core.autocrlf", "true");
  git(
    repository,
    "config",
    "core.fsmonitor",
    quoteCommand(process.execPath, fsMonitorScript),
  );

  const result = await inspectGitRepository(
    "git",
    repository,
    undefined,
    [target(repository, {
      key: "sample",
      currentPath: "sample.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: true,
    })],
    neverCancelled,
  );

  assert.equal(result.get("sample")?.expectedLineEnding, undefined);
  assert.equal(result.get("sample")?.attributeLookupFailed, false);
  assert.equal(existsSync(fsMonitorMarker), false);
});

test("fails safely for ambiguous set and unset attribute values", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, ".gitattributes"), "sample.txt text=set\n");
  writeFileSync(path.join(repository, "sample.txt"), "one\ntwo\n");
  commitAll(repository);
  git(repository, "config", "core.eol", "crlf");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "sample",
      currentPath: "sample.txt",
      headPath: "sample.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("sample")?.head, { kind: "failed" });
});

test("invalidates a cached HEAD baseline when checkout policy or HEAD path changes", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  git(repository, "config", "core.eol", "lf");
  writeFileSync(path.join(repository, ".gitattributes"), "*.txt text=auto\n");
  writeFileSync(path.join(repository, "first.txt"), "one\ntwo\n");
  writeFileSync(path.join(repository, "second.txt"), "three\nfour\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  const initial = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "file",
      currentPath: "first.txt",
      headPath: "first.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );
  const initialIdentity = initial.get("file")?.historyIdentity;
  assert.match(initialIdentity ?? "", /^git:/);

  const cached = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "file",
      currentPath: "first.txt",
      headPath: "first.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
      baselineIdentity: initialIdentity,
      baselineSource: "git",
    })],
    neverCancelled,
  );
  assert.deepEqual(cached.get("file")?.head, { kind: "notNeeded" });

  const refreshedUnknownDetails = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "file",
      currentPath: "first.txt",
      headPath: "first.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
      baselineIdentity: initialIdentity,
      baselineSource: "git",
      baselineDetailsKnown: false,
    })],
    neverCancelled,
  );
  assert.deepEqual(refreshedUnknownDetails.get("file")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });

  git(repository, "config", "core.eol", "crlf");
  const changedPolicy = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "file",
      currentPath: "first.txt",
      headPath: "first.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
      baselineIdentity: initialIdentity,
      baselineSource: "git",
    })],
    neverCancelled,
  );
  assert.notEqual(changedPolicy.get("file")?.historyIdentity, initialIdentity);
  assert.deepEqual(changedPolicy.get("file")?.head, {
    kind: "found",
    lineEndings: { kind: "crlf", styles: ["crlf"] },
  });

  const renamedPath = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "file",
      currentPath: "first.txt",
      headPath: "second.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
      baselineIdentity: changedPolicy.get("file")?.historyIdentity,
      baselineSource: "git",
    })],
    neverCancelled,
  );
  assert.notEqual(
    renamedPath.get("file")?.historyIdentity,
    changedPolicy.get("file")?.historyIdentity,
  );
  assert.equal(renamedPath.get("file")?.head.kind, "found");
});

test("fails safely when UTF-16 would receive byte-oriented CRLF conversion", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, ".gitattributes"), "utf16.txt text eol=crlf\n");
  writeFileSync(path.join(repository, "utf16.txt"), Buffer.from([0x61, 0x00, 0x0a, 0x00]));
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "utf16",
      currentPath: "utf16.txt",
      headPath: "utf16.txt",
      expectedEncoding: "utf16le",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("utf16")?.head, { kind: "failed" });
});

test("does not read a HEAD blob larger than the file limit", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "large.txt"), "one\ntwo\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "large",
      currentPath: "large.txt",
      headPath: "large.txt",
      expectedEncoding: "utf8",
      maxSize: 1,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("large")?.head, { kind: "failed" });
});

test("reports an unreadable tracked blob instead of treating it as absent", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "tracked.txt"), "one\ntwo\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  const blob = git(repository, "rev-parse", "HEAD:tracked.txt").trim();
  rmSync(path.join(repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "tracked",
      currentPath: "tracked.txt",
      headPath: "tracked.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("tracked")?.head, { kind: "failed" });
});

test("keeps cached results when a later blob read fails", nonWindowsGitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "cached.txt"), "cached\n");
  writeFileSync(path.join(repository, "uncached.txt"), "uncached\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  const cachedTarget = target(repository, {
    key: "cached",
    currentPath: "cached.txt",
    headPath: "cached.txt",
    expectedEncoding: "utf8",
    maxSize: 1024,
    readCurrentAttributes: false,
  });
  const initial = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [cachedTarget],
    neverCancelled,
  );
  const wrapper = path.join(repository, "git-wrapper.cjs");
  const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    wrapper,
    `#!/usr/bin/env node\n` +
      `const {spawnSync}=require("node:child_process");\n` +
      `if(process.argv.includes("cat-file")){process.exit(7);}\n` +
      `const result=spawnSync(${JSON.stringify(gitExecutable)},process.argv.slice(2),{stdio:"inherit",env:process.env});\n` +
      `if(result.error){throw result.error;}process.exit(result.status ?? 1);\n`,
  );
  chmodSync(wrapper, 0o755);

  const result = await inspectGitRepository(
    wrapper,
    repository,
    headCommit,
    [
      {
        ...cachedTarget,
        baselineIdentity: initial.get("cached")?.historyIdentity,
        baselineSource: "git",
      },
      target(repository, {
        key: "uncached",
        currentPath: "uncached.txt",
        headPath: "uncached.txt",
        expectedEncoding: "utf8",
        maxSize: 1024,
        readCurrentAttributes: false,
      }),
    ],
    neverCancelled,
  );

  assert.deepEqual(result.get("cached")?.head, { kind: "notNeeded" });
  assert.deepEqual(result.get("uncached")?.head, { kind: "failed" });
});

test("classifies a shared HEAD blob once per encoding", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "first.txt"), "shared\n");
  writeFileSync(path.join(repository, "second.txt"), "shared\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  let verificationCount = 0;

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    ["first.txt", "second.txt"].map((filePath) => target(repository, {
      key: filePath,
      currentPath: filePath,
      headPath: filePath,
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })),
    neverCancelled,
    {
      verifyEncoding: async () => {
        verificationCount += 1;
        return true;
      },
    },
  );

  assert.equal(verificationCount, 1);
  assert.deepEqual(result.get("first.txt")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
  assert.deepEqual(result.get("second.txt")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
});

test("shares the HEAD content budget across repositories", gitTestOptions, async (context) => {
  const firstRepository = createRepository(context);
  const secondRepository = createRepository(context);
  for (const repository of [firstRepository, secondRepository]) {
    writeFileSync(path.join(repository, "tracked.txt"), "one\n");
    commitAll(repository);
  }
  const budget = createGitInspectionBudget(7);
  const inspect = async (repository: string) => inspectGitRepository(
    "git",
    repository,
    git(repository, "rev-parse", "HEAD").trim(),
    [target(repository, {
      key: "tracked",
      currentPath: "tracked.txt",
      headPath: "tracked.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: false,
    })],
    neverCancelled,
    { budget },
  );

  assert.deepEqual((await inspect(firstRepository)).get("tracked")?.head, {
    kind: "found",
    lineEndings: { kind: "lf", styles: ["lf"] },
  });
  assert.deepEqual((await inspect(secondRepository)).get("tracked")?.head, {
    kind: "failed",
  });
  assert.equal(budget.remainingHeadContentBytes, 3);
});

test("chunks attribute requests and ignores a false promisor setting", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, ".gitattributes"), "*.txt text eol=crlf\n");
  writeFileSync(path.join(repository, "tracked.txt"), "one\r\ntwo\r\n");
  writeFileSync(path.join(repository, "auto.dat"), "one\ntwo\n");
  commitAll(repository);
  git(repository, "config", "remote.origin.promisor", "false");
  git(repository, "config", "core.autocrlf", "yes");
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  const targets: RepositoryInspectionTarget[] = Array.from({ length: 205 }, (_, index) => target(repository, {
    key: `file-${index}`,
    currentPath: `file-${index}.txt`,
    expectedEncoding: "utf8",
    maxSize: 1024,
    readCurrentAttributes: true,
  }));
  targets.push(target(repository, {
    key: "tracked",
    currentPath: "tracked.txt",
    headPath: "tracked.txt",
    expectedEncoding: "utf8",
    maxSize: 1024,
    readCurrentAttributes: true,
  }));
  targets.push(target(repository, {
    key: "auto",
    currentPath: "auto.dat",
    headPath: "auto.dat",
    expectedEncoding: "utf8",
    maxSize: 1024,
    readCurrentAttributes: false,
  }));

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    targets,
    neverCancelled,
  );

  assert.equal(result.size, 207);
  assert.equal(result.get("file-204")?.expectedLineEnding, "crlf");
  assert.deepEqual(result.get("tracked")?.head, {
    kind: "found",
    lineEndings: { kind: "crlf", styles: ["crlf"] },
  });
  assert.deepEqual(result.get("auto")?.head, {
    kind: "found",
    lineEndings: { kind: "crlf", styles: ["crlf"] },
  });
});

test("treats a bare promisor setting as a partial clone", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  writeFileSync(path.join(repository, "tracked.txt"), "one\ntwo\n");
  commitAll(repository);
  const headCommit = git(repository, "rev-parse", "HEAD").trim();
  appendFileSync(
    path.join(repository, ".git", "config"),
    "\n[remote \"origin\"]\n\tpromisor\n",
  );

  assert.deepEqual(
    await readRepositoryHead("git", repository, neverCancelled),
    { kind: "found", commit: headCommit },
  );

  const result = await inspectGitRepository(
    "git",
    repository,
    headCommit,
    [target(repository, {
      key: "tracked",
      currentPath: "tracked.txt",
      headPath: "tracked.txt",
      expectedEncoding: "utf8",
      maxSize: 1024,
      readCurrentAttributes: true,
    })],
    neverCancelled,
  );

  assert.deepEqual(result.get("tracked")?.head, { kind: "failed" });
  assert.equal(result.get("tracked")?.attributeLookupFailed, true);

  const missingCommit = "a".repeat(40);
  const headReference = git(repository, "symbolic-ref", "HEAD").trim();
  writeFileSync(path.join(repository, ".git", headReference), `${missingCommit}\n`);
  assert.deepEqual(
    await readRepositoryHead("git", repository, neverCancelled),
    { kind: "found", commit: missingCommit },
  );
});

test("treats every non-zero numeric promisor value as true", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  for (const value of ["2", "-1", "01", "1k", "0x1"]) {
    git(repository, "config", "remote.origin.promisor", value);
    assert.equal(await isPartialCloneRepository("git", repository, neverCancelled), true);
  }
  for (const value of ["+0", "0k", "0x0"]) {
    git(repository, "config", "remote.origin.promisor", value);
    assert.equal(await isPartialCloneRepository("git", repository, neverCancelled), false);
  }
});

test("recognizes a promisor remote whose subsection contains spaces", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  git(repository, "config", "remote.foo bar.promisor", "true");

  assert.equal(await isPartialCloneRepository("git", repository, neverCancelled), true);
});

test("distinguishes unborn repositories from missing HEAD objects", async (context) => {
  const repository = createRepository(context);
  assert.deepEqual(
    await readRepositoryHead("git", repository, neverCancelled),
    { kind: "unborn" },
  );

  writeFileSync(path.join(repository, "tracked.txt"), "content\n");
  commitAll(repository);
  const commit = git(repository, "rev-parse", "HEAD").trim();
  assert.deepEqual(
    await readRepositoryHead("git", repository, neverCancelled),
    { kind: "found", commit },
  );
  const nested = path.join(repository, "nested");
  mkdirSync(nested);
  assert.deepEqual(
    await readRepositoryHead("git", nested, neverCancelled),
    { kind: "failed" },
  );

  rmSync(path.join(repository, ".git", "objects", commit.slice(0, 2), commit.slice(2)));
  assert.deepEqual(
    await readRepositoryHead("git", repository, neverCancelled),
    { kind: "failed" },
  );
  assert.deepEqual(
    await readRepositoryHead("git", path.join(repository, "missing"), neverCancelled),
    { kind: "failed" },
  );
});

function createRepository(context: TestContext): string {
  const repository = mkdtempSync(path.join(tmpdir(), "folder-encoding-guard-"));
  context.after(() => rmSync(repository, { recursive: true, force: true }));
  mkdirSync(path.join(repository, "hooks"));
  writeFileSync(path.join(repository, "global-attributes"), "");
  writeFileSync(path.join(repository, "global-config"), "");
  git(repository, "init", "--quiet");
  git(repository, "config", "core.autocrlf", "false");
  git(repository, "config", "core.eol", "native");
  git(repository, "config", "core.attributesFile", path.join(repository, "global-attributes"));
  return repository;
}

function target(
  repository: string,
  value: Omit<RepositoryInspectionTarget, "inspectHistory" | "historyRepositoryId">,
): RepositoryInspectionTarget {
  return {
    ...value,
    inspectHistory: value.headPath !== undefined,
    historyRepositoryId: repository,
  };
}

function commitAll(repository: string): void {
  const hooks = path.join(repository, "hooks");
  git(repository, "-c", `core.hooksPath=${hooks}`, "add", "--all");
  commitIndex(repository);
}

function commitIndex(repository: string): void {
  const hooks = path.join(repository, "hooks");
  git(
    repository,
    "-c",
    `core.hooksPath=${hooks}`,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Folder Encoding Guard Tests",
    "-c",
    "user.email=tests@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
}

function git(repository: string, ...args: string[]): string {
  const environment: NodeJS.ProcessEnv = {
    ...gitEnvironmentWithoutCommandOverrides(),
    GIT_CONFIG_GLOBAL: path.join(repository, "global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ATTR_SOURCE",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_COUNT",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]) {
    delete environment[key];
  }
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitEnvironmentWithoutCommandOverrides(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GIT_CONFIG_COUNT;
  delete environment.GIT_CONFIG_PARAMETERS;
  return environment;
}

function quoteCommand(executable: string, script: string): string {
  return `${JSON.stringify(executable)} ${JSON.stringify(script)}`;
}
test("preserves trailing spaces in the repository root", {skip:process.platform === "win32"}, async (context) => {
  const parent = createRepository(context);
  const repository = path.join(parent, "trailing ");
  mkdirSync(repository);
  git(repository, "init");
  assert.deepEqual(await readRepositoryHead("git", repository, neverCancelled), {kind:"unborn"});
});

test("uses effective empty filter commands and overriding false requirements", gitTestOptions, async (context) => {
  const repository = createRepository(context);
  git(repository, "config", "--add", "filter.safe.smudge", "unavailable-command");
  git(repository, "config", "--add", "filter.safe.smudge", "");
  git(repository, "config", "--add", "filter.safe.required", "true");
  git(repository, "config", "--add", "filter.safe.required", "false");
  writeFileSync(path.join(repository, ".gitattributes"), "a.txt text eol=lf filter=safe\n");
  writeFileSync(path.join(repository, "a.txt"), "text\n");
  commitAll(repository);
  const result = await inspectGitRepository("git", repository, git(repository, "rev-parse", "HEAD").trim(), [target(repository, {key:"a.txt",currentPath:"a.txt",headPath:"a.txt",expectedEncoding:"utf8",maxSize:1024,readCurrentAttributes:true})], neverCancelled);
  assert.equal(result.get("a.txt")?.attributeLookupFailed, false);
  assert.equal(result.get("a.txt")?.head.kind, "found");
});
