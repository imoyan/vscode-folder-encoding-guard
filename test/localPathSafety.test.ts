import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  isPathWithin,
  isConversionBackupSessionPath,
  resolveRealDirectory,
  resolveMissingRecoveryPath,
  resolveRealPathWithin,
} from "../src/localPathSafety.js";

test("accepts real files contained by a workspace root", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "folder-encoding-guard-path-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "workspace");
  const nested = path.join(workspace, "nested");
  const file = path.join(nested, "sample.txt");
  await mkdir(nested, { recursive: true });
  await writeFile(file, "sample");

  const realWorkspace = await resolveRealDirectory(workspace);
  assert.ok(realWorkspace);
  assert.equal(await resolveRealPathWithin(realWorkspace, file), await realpath(file));
});

test(
  "rejects a workspace symlink that resolves outside the workspace",
  { skip: process.platform === "win32" ? "symlink permissions vary on Windows" : false },
  async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "folder-encoding-guard-path-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "workspace");
  const outside = path.join(temporary, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(outside, "sample.txt"), "sample");
  await symlink(outside, path.join(workspace, "linked"), "dir");

  const realWorkspace = await resolveRealDirectory(workspace);
  assert.ok(realWorkspace);
  assert.equal(
    await resolveRealPathWithin(realWorkspace, path.join(workspace, "linked", "sample.txt")),
    undefined,
  );
  },
);

test("resolves only the same missing target inside the conversion root", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "folder-encoding-guard-recovery-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const workspace = path.join(temporary, "workspace");
  const nested = path.join(workspace, "nested");
  const target = path.join(nested, "sample.txt");
  await mkdir(nested, { recursive: true });
  await writeFile(target, "partial");
  const realWorkspace = await realpath(workspace);
  const expectedTarget = await realpath(target);
  await unlink(target);

  assert.equal(
    await resolveMissingRecoveryPath(realWorkspace, target, expectedTarget),
    expectedTarget,
  );

});

test(
  "rejects a missing recovery target redirected through a symlink",
  { skip: process.platform === "win32" ? "symlink permissions vary on Windows" : false },
  async (context) => {
    const temporary = await mkdtemp(path.join(tmpdir(), "folder-encoding-guard-recovery-"));
    context.after(async () => rm(temporary, { recursive: true, force: true }));
    const workspace = path.join(temporary, "workspace");
    const outside = path.join(temporary, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, path.join(workspace, "linked"), "dir");

    assert.equal(
      await resolveMissingRecoveryPath(
        await realpath(workspace),
        path.join(workspace, "linked", "sample.txt"),
        path.join(outside, "sample.txt"),
      ),
      undefined,
    );
  },
);

test("uses path segments rather than string prefixes for containment", () => {
  assert.equal(isPathWithin("/workspace/project", "/workspace/project/file.txt"), true);
  assert.equal(isPathWithin("/workspace/project", "/workspace/project-copy/file.txt"), false);
});

test("accepts only real direct conversion session children for recursive cleanup", async (context) => {
  const storage = await mkdtemp(path.join(tmpdir(), "backup-containment-"));
  context.after(() => rm(storage, { recursive: true, force: true }));
  const valid = path.join(
    storage,
    "conversion-backups",
    "2026-09-04T12-34-56-789Z-123e4567-e89b-12d3-a456-426614174000",
  );
  await mkdir(valid, { recursive: true });
  assert.equal(await isConversionBackupSessionPath(storage, valid), true);
  assert.equal(
    await isConversionBackupSessionPath(storage, path.join(storage, "conversion-backups")),
    false,
  );
  assert.equal(
    await isConversionBackupSessionPath(storage, path.join(storage, "other-data")),
    false,
  );
  assert.equal(
    await isConversionBackupSessionPath(storage, path.join(valid, "nested")),
    false,
  );
});


test("rejects linked backup parents and linked sessions", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "backup-linked-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const storage = path.join(root, "storage");
  const outside = path.join(root, "outside");
  const name = "2026-09-04T12-34-56-789Z-123e4567-e89b-12d3-a456-426614174000";
  await mkdir(storage);
  await mkdir(path.join(outside, name), { recursive: true });
  const parent = path.join(storage, "conversion-backups");
  await symlink(outside, parent, "dir");
  assert.equal(await isConversionBackupSessionPath(storage, path.join(parent, name)), false);
  await unlink(parent);
  await mkdir(parent);
  await symlink(path.join(outside, name), path.join(parent, name), "dir");
  assert.equal(await isConversionBackupSessionPath(storage, path.join(parent, name)), false);
  assert.ok(await realpath(path.join(outside, name)));
});
