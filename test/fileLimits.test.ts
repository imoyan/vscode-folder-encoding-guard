import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredScanFileLimit,
  configuredFileSizeLimit,
  DEFAULT_MAX_SCAN_FILES,
  MAX_IN_MEMORY_FILE_BYTES,
  MAX_SCAN_FILES,
} from "../src/fileLimits.js";

test("normalizes the configured scan file limit", () => {
  assert.equal(configuredScanFileLimit(undefined), DEFAULT_MAX_SCAN_FILES);
  assert.equal(configuredScanFileLimit(Number.NaN), DEFAULT_MAX_SCAN_FILES);
  assert.equal(configuredScanFileLimit(0), 1);
  assert.equal(configuredScanFileLimit(10.9), 10);
  assert.equal(configuredScanFileLimit(MAX_SCAN_FILES + 1), MAX_SCAN_FILES);
});

test("caps whole-file operations to a safe in-memory size", () => {
  assert.equal(configuredFileSizeLimit(undefined), 5 * 1024 * 1024);
  assert.equal(configuredFileSizeLimit(1024), 1024 * 1024);
  assert.equal(configuredFileSizeLimit(102400), MAX_IN_MEMORY_FILE_BYTES);
});
