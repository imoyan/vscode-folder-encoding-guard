import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GitRepositoryLocator } from "../src/gitRepositoryLocator.js";

test("selects the nearest nested Git repository", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "folder-encoding-guard-git-root-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const outer = path.join(temporary, "outer");
  const inner = path.join(outer, "vendor", "inner");
  const source = path.join(inner, "src");
  await mkdir(path.join(outer, ".git"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(inner, ".git"), "gitdir: elsewhere\n");

  const locator = new GitRepositoryLocator();
  assert.equal(await locator.findNearestRoot(source), inner);
  assert.equal(await locator.findNearestRoot(path.join(outer, "src")), outer);
});

test("returns undefined outside a Git repository", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "folder-encoding-guard-git-root-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "workspace", "src");
  await mkdir(source, { recursive: true });

  assert.equal(await new GitRepositoryLocator().findNearestRoot(source), undefined);
});

test(
  "recognizes a symbolic-link Git marker",
  { skip: process.platform === "win32" ? "symlink permissions vary on Windows" : false },
  async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "folder-encoding-guard-git-root-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "workspace");
  const gitDirectory = path.join(temporary, "git-directory");
  await mkdir(workspace);
  await mkdir(gitDirectory);
  await symlink(gitDirectory, path.join(workspace, ".git"), "dir");

  assert.equal(await new GitRepositoryLocator().findNearestRoot(workspace), workspace);
  },
);
