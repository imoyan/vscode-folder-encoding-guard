import assert from "node:assert/strict";
import test from "node:test";
import { gitPathComparisonKey } from "../src/gitPath.js";

test("normalizes decomposed Git paths only on macOS", () => {
  const decomposed = "e\u0301.txt";
  assert.equal(gitPathComparisonKey(decomposed, "darwin"), "é.txt");
  assert.equal(gitPathComparisonKey(decomposed, "linux"), decomposed);
  assert.equal(gitPathComparisonKey("Src/Foo.txt", "darwin", true), "src/foo.txt");
});
