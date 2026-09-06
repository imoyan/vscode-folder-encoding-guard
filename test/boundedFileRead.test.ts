import assert from "node:assert/strict";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import {
  localFileStillMatches,
  readStableLocalFile,
} from "../src/boundedFileRead.js";

test("reads a local file within the configured bound", async (context) => {
  const directory = temporaryDirectory(context);
  const filePath = path.join(directory, "sample.txt");
  writeFileSync(filePath, "one\ntwo\n");

  const read = await readStableLocalFile(filePath, 9);

  assert.equal(Buffer.from(read?.bytes ?? []).toString("utf8"), "one\ntwo\n");
  assert.equal(await localFileStillMatches(filePath, read!, 9), true);
});

test("rejects oversized, replaced, and cancelled local reads", async (context) => {
  const directory = temporaryDirectory(context);
  const filePath = path.join(directory, "sample.txt");
  const replacement = path.join(directory, "replacement.txt");
  writeFileSync(filePath, "content\n");

  assert.equal(await readStableLocalFile(filePath, 2), undefined);
  assert.equal(await readStableLocalFile(filePath, 1024, () => true), undefined);

  const read = await readStableLocalFile(filePath, 1024);
  writeFileSync(replacement, "new data\n");
  rmSync(filePath);
  renameSync(replacement, filePath);
  assert.equal(await localFileStillMatches(filePath, read!, 1024), false);
});

test("stops a bounded read between chunks", async (context) => {
  const directory = temporaryDirectory(context);
  const filePath = path.join(directory, "large.txt");
  writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 0x61));
  let checks = 0;

  const read = await readStableLocalFile(
    filePath,
    3 * 1024 * 1024,
    () => {
      checks += 1;
      return checks >= 5;
    },
  );

  assert.equal(read, undefined);
  assert.ok(checks >= 5);
});

test(
  "does not follow a symbolic link",
  { skip: process.platform === "win32" ? "Symlink permissions vary on Windows" : false },
  async (context) => {
    const directory = temporaryDirectory(context);
    const outside = path.join(directory, "outside.txt");
    const link = path.join(directory, "link.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, link);

    assert.equal(await readStableLocalFile(link, 1024), undefined);
  },
);

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "folder-encoding-guard-read-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("rejects an in-place edit whose length and mtime are restored", async (context) => {
  const dir = temporaryDirectory(context);
  const file = path.join(dir, "same.txt");
  writeFileSync(file, "before");
  const metadata = statSync(file);
  const before = await readStableLocalFile(file, 1024);
  writeFileSync(file, "edited");
  utimesSync(file, metadata.atime, metadata.mtime);
  assert.equal(await localFileStillMatches(file, before!, 1024), false);
});

test("treats disappearance after reading as an unstable result", async (context) => {
  const dir = temporaryDirectory(context);
  const file = path.join(dir, "gone.txt");
  writeFileSync(file, "data");
  let checks = 0;
  const result = await readStableLocalFile(file, 1024, () => {
    if (++checks === 6) rmSync(file, { force: true });
    return false;
  });
  assert.equal(result, undefined);
});
