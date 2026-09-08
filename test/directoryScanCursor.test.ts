import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import test from "node:test";
import { DirectoryScanCursor } from "../src/directoryScanCursor.js";

function fixture(count: number, directory = false) {
  let reads = 0;
  let opens = 0;
  let closes = 0;
  const cursor = new DirectoryScanCursor("/fixture", () => false, async () => {
    opens++;
    return {
      read: async () => {
        const index = reads++;
        return index < count ? { name: String(index), isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false } as Dirent : null;
      },
      close: async () => { closes++; },
    };
  });
  return { cursor, stats: () => ({ reads, opens, closes }) };
}

test("50,000 files are traversed once with a one-entry lookahead", async () => {
  const h = fixture(50_000);
  try {
    for (let offset = 0; offset < 50_000; offset += 100) {
      const page = await h.cursor.peek(100, () => false);
      assert.equal(page.paths.length, 100);
      assert.equal(page.paths[0], `/fixture/${offset}`);
      assert.equal(page.complete, offset === 49_900);
      assert.ok(h.stats().reads <= offset + 102);
      h.cursor.commit(page.paths.length);
    }
    assert.deepEqual(h.stats(), { reads: 50_001, opens: 1, closes: 1 });
  } finally { await h.cursor.dispose(); }
});

test("uncommitted and cancelled pages replay without rewinding the directory", async () => {
  const h = fixture(200);
  try {
    const partial = await h.cursor.peek(100, () => h.stats().reads >= 5);
    assert.equal(partial.paths.length, 5);
    const first = await h.cursor.peek(100, () => false);
    assert.equal(first.paths[0], "/fixture/0");
    const before = h.stats().reads;
    assert.deepEqual(await h.cursor.peek(100, () => false), first);
    assert.equal(h.stats().reads, before);
    h.cursor.commit(100);
    assert.equal((await h.cursor.peek(100, () => false)).paths[0], "/fixture/100");
  } finally { await h.cursor.dispose(); }
  assert.equal(h.stats().closes, 1);
});

test("directory-only trees have bounded metadata work and release their open handle", async () => {
  const h = fixture(5000, true);
  const page = await h.cursor.peek(100, () => false);
  assert.equal(page.paths.length, 0);
  assert.equal(page.complete, false);
  assert.ok(h.stats().reads <= 1000);
  await h.cursor.dispose();
  assert.equal(h.stats().closes, 1);
});
