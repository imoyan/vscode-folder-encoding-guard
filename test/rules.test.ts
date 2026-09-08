import assert from "node:assert/strict";
import test from "node:test";
import {
  findMatchingRule,
  normalizeRelativePath,
  patternForFolder,
  patternForFile,
  isMixedPathAllowed,
  sanitizeRules,
} from "../src/rules.js";

test("normalizes platform path separators", () => {
  assert.equal(normalizeRelativePath(".\\legacy\\src\\"), "legacy/src");
});

test("creates a recursive literal pattern for a selected folder", () => {
  assert.equal(patternForFolder("legacy/source"), "legacy/source/**");
  assert.equal(patternForFolder(""), "**");
  assert.equal(patternForFolder("legacy/[generated]"), "legacy/\\[generated\\]/**");
});

test("uses the first matching rule", () => {
  const rules = [
    { pattern: "legacy/special/**", encoding: "utf8" },
    { pattern: "legacy/**", encoding: "shiftjis" },
  ];
  assert.deepEqual(findMatchingRule(rules, "legacy/special/a.txt", false), {
    rule: rules[0],
    index: 0,
  });
  assert.deepEqual(findMatchingRule(rules, "legacy/other/a.txt", false), {
    rule: rules[1],
    index: 1,
  });
  assert.equal(findMatchingRule(rules, "src/a.txt", false), undefined);
});

test("can match case-insensitively on supported platforms", () => {
  const rules = [{ pattern: "Legacy/**", encoding: "shiftjis" }];
  assert.ok(findMatchingRule(rules, "legacy/a.txt", true));
  assert.equal(findMatchingRule(rules, "legacy/a.txt", false), undefined);
});

test("drops malformed configuration entries", () => {
  assert.deepEqual(
    sanitizeRules([
      { pattern: "legacy/**", encoding: "shiftjis" },
      { pattern: "", encoding: "utf8" },
      { pattern: "src/**" },
      { pattern: "src/**", encoding: "made-up" },
      null,
    ]),
    [{ pattern: "legacy/**", encoding: "shiftjis" }],
  );
});


test("single-file settings match only the literal selected filename", () => {
  for (const name of ["legacy/[sample].txt", "!special.txt", "#note.txt"]) {
    const rules = [{ pattern: patternForFile(name), encoding: "utf8bom" }];
    assert.ok(findMatchingRule(rules, name));
    assert.equal(findMatchingRule(rules, "other.txt"), undefined);
    assert.equal(findMatchingRule(rules, name + "/nested.txt"), undefined);
  }
});


test("the most specific mixed-ending policy wins and denial wins equal paths", () => {
  assert.equal(isMixedPathAllowed(["data/"], "data/a.csv", ["data/a.csv"]), false);
  assert.equal(isMixedPathAllowed(["data/"], "data/b.csv", ["data/a.csv"]), true);
  assert.equal(isMixedPathAllowed(["data/special/a.csv"], "data/special/a.csv", ["data/"]), true);
  assert.equal(isMixedPathAllowed(["./"], "data/a.csv", ["data/"]), false);
  assert.equal(isMixedPathAllowed(["data/[literal].csv"], "data/[literal].csv", []), true);
  assert.equal(isMixedPathAllowed(["data/a.csv"], "data/a.csv", ["data/a.csv"]), false);
  assert.equal(isMixedPathAllowed(["data/"], "database/a.csv", []), false);
});
