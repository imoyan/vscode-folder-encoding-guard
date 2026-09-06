import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredFileSizeLimit,
  MAX_IN_MEMORY_FILE_BYTES,
} from "../src/fileLimits.js";

test("caps whole-file operations to a safe in-memory size", () => {
  assert.equal(configuredFileSizeLimit(undefined), 5 * 1024 * 1024);
  assert.equal(configuredFileSizeLimit(1024), 1024 * 1024);
  assert.equal(configuredFileSizeLimit(102400), MAX_IN_MEMORY_FILE_BYTES);
});
