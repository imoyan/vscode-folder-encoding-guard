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