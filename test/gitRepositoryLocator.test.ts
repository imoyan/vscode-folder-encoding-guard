import { realpath } from "node:fs/promises";
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
  await mkdir(path.join(outer, "src"), { recursive: true });
  await writeFile(path.join(inner, ".git"), "gitdir: elsewhere\n");

  const locator = new GitRepositoryLocator();
  assert.equal(await locator.findNearestRoot(source), await realpath(inner));
  assert.equal(await locator.findNearestRoot(path.join(outer, "src")), await realpath(outer));
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

  assert.equal(await new GitRepositoryLocator().findNearestRoot(workspace), await realpath(workspace));
  },
);

test("can invalidate repository topology between inspections", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "locator-refresh-"));
  context.after(() => rm(dir, {recursive:true, force:true}));
  const locator = new GitRepositoryLocator();
  assert.equal(await locator.findNearestRoot(dir), undefined);
  await mkdir(path.join(dir, ".git"));
  locator.clear();
  assert.equal(await locator.findNearestRoot(dir), await realpath(dir));
  await rm(path.join(dir, ".git"), {recursive:true});
  locator.clear();
  assert.equal(await locator.findNearestRoot(dir), undefined);
});

test("searches physical parents of a symlinked directory", {skip:process.platform === "win32"}, async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "locator-link-"));
  context.after(() => rm(dir, {recursive:true, force:true}));
  const outer = path.join(dir, "outer");
  const target = path.join(dir, "target");
  await mkdir(path.join(outer, ".git"), {recursive:true});
  await mkdir(path.join(target, "nested"), {recursive:true});
  await mkdir(path.join(target, ".git"));
  await symlink(path.join(target, "nested"), path.join(outer, "link"), "dir");
  assert.equal(await new GitRepositoryLocator().findNearestRoot(path.join(outer, "link")), await realpath(target));
});
