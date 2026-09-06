import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveEolRule,
  gitHeadBlobFitsConfiguredLimit,
  gitWouldTreatAsText,
  GitCheckoutConfig,
  groupGitAttributes,
  hasExternalGitFilter,
  headBlobEncodingHint,
  parseGitBatchOutput,
  parseStagedNameStatusOutput,
  parseGitTreeOutput,
  projectCheckoutLineEnding,
  projectCheckoutLineEndings,
  selectGitTreeEntriesWithinBudget,
} from "../src/gitInspectionCore.js";
import { classifyLineEndings } from "../src/scanCore.js";

const lfCheckout: GitCheckoutConfig = {
  autoCrlf: "false",
  coreEol: "lf",
  nativeEol: "lf",
};

test("groups all attributes for each Git path", () => {
  assert.deepEqual(
    groupGitAttributes([
      { path: "src/a.txt", attribute: "text", value: "set" },
      { path: "src/a.txt", attribute: "eol", value: "crlf" },
      { path: "src/a.txt", attribute: "working-tree-encoding", value: "UTF-16LE" },
    ]).get("src/a.txt"),
    { eol: "crlf", text: "set", workingTreeEncoding: "UTF-16LE", crlf: undefined, filter: undefined },
  );
});

test("projects only Git built-in CRLF checkout conversion", () => {
  const lf = classifyLineEndings(Buffer.from("one\ntwo\n"));
  const crlf = classifyLineEndings(Buffer.from("one\r\ntwo\r\n"));
  const mixed = classifyLineEndings(Buffer.from("one\r\ntwo\n"));

  assert.equal(projectCheckoutLineEnding(lf, { text: "set", eol: "crlf" }, lfCheckout), "crlf");
  assert.equal(projectCheckoutLineEnding(crlf, { text: "set", eol: "lf" }, lfCheckout), "crlf");
  assert.equal(
    projectCheckoutLineEnding(lf, { text: "unset", eol: "crlf" }, lfCheckout),
    undefined,
  );
  assert.equal(projectCheckoutLineEnding(mixed, { text: "auto", eol: "crlf" }, lfCheckout), "mixed");
  assert.equal(projectCheckoutLineEnding(mixed, { text: "set", eol: "crlf" }, lfCheckout), "crlf");
  assert.equal(projectCheckoutLineEnding(lf, { filter: "lfs" }, lfCheckout), undefined);
  assert.equal(
    projectCheckoutLineEnding(
      lf,
      { text: "auto" },
      { ...lfCheckout, autoCrlf: "true" },
      false,
    ),
    "lf",
  );
  assert.deepEqual(
    projectCheckoutLineEndings(
      classifyLineEndings(Buffer.from("one\ntwo\r")),
      { text: "set", eol: "crlf" },
      lfCheckout,
    ),
    { kind: "mixed", styles: ["crlf", "cr"] },
  );
});

test("models legacy text and crlf attribute values", () => {
  const lf = classifyLineEndings(Buffer.from("one\ntwo\n"));
  const mixed = classifyLineEndings(Buffer.from("one\r\ntwo\n"));
  const crlfConfig = { ...lfCheckout, autoCrlf: "true" as const };

  assert.equal(projectCheckoutLineEnding(lf, { text: "input" }, crlfConfig), "lf");
  assert.equal(
    projectCheckoutLineEnding(lf, { crlf: "auto" }, { ...lfCheckout, coreEol: "crlf" }),
    "crlf",
  );
  assert.equal(projectCheckoutLineEnding(mixed, { text: "set" }, crlfConfig), undefined);
  assert.equal(projectCheckoutLineEnding(lf, { text: "unset" }, crlfConfig), undefined);
  assert.equal(
    projectCheckoutLineEnding(lf, { text: "auto", eol: "lf" }, crlfConfig),
    "lf",
  );
});

test("does not project byte CRLF conversion into UTF-16 without working-tree-encoding", () => {
  const utf16 = classifyLineEndings(Buffer.from([0x61, 0x00, 0x0a, 0x00]), "utf16le");
  assert.equal(
    projectCheckoutLineEnding(utf16, { text: "set", eol: "crlf" }, lfCheckout, true, "utf16le"),
    undefined,
  );
  assert.equal(
    projectCheckoutLineEnding(utf16, { text: "unset" }, lfCheckout, true, "utf16le"),
    "lf",
  );
  const noSemanticNewline = classifyLineEndings(
    Buffer.from([0x30, 0x0a, 0x30, 0x0b]),
    "utf16be",
  );
  assert.equal(noSemanticNewline.kind, "none");
  assert.equal(
    projectCheckoutLineEnding(
      noSemanticNewline,
      { text: "set", eol: "crlf" },
      lfCheckout,
      true,
      "utf16be",
    ),
    undefined,
  );
});

test("uses core.autocrlf and core.eol only when text conversion applies", () => {
  const lf = classifyLineEndings(Buffer.from("one\ntwo\n"));
  assert.equal(
    projectCheckoutLineEnding(lf, {}, { ...lfCheckout, autoCrlf: "true" }),
    "crlf",
  );
  assert.equal(
    projectCheckoutLineEnding(lf, { text: "set" }, { ...lfCheckout, coreEol: "crlf" }),
    undefined,
  );
  assert.equal(
    projectCheckoutLineEnding(lf, {}, { ...lfCheckout, autoCrlf: "input" }),
    "lf",
  );
});

test("classifies raw blobs as UTF-8 when working-tree-encoding is active", () => {
  assert.equal(headBlobEncodingHint("utf16le", { workingTreeEncoding: "UTF-16LE" }), "utf8");
  assert.equal(headBlobEncodingHint("utf16le", {}), "utf16le");
  assert.equal(headBlobEncodingHint("utf16le", { workingTreeEncoding: "set" }), undefined);
  assert.equal(headBlobEncodingHint("utf16le", { workingTreeEncoding: "unset" }), undefined);
});

test("uses only effective eol rules without an external filter", () => {
  assert.equal(effectiveEolRule({ eol: "crlf" }), "crlf");
  assert.equal(effectiveEolRule({ text: "unset", eol: "crlf" }), undefined);
  assert.equal(hasExternalGitFilter({ filter: "lfs" }), true);
  assert.equal(hasExternalGitFilter({ filter: "unset" }), false);
  assert.equal(
    hasExternalGitFilter(
      { filter: "unset" },
      { checkoutFilterDrivers: new Set(["unset"]) },
    ),
    true,
  );
  assert.equal(
    hasExternalGitFilter(
      { filter: "lfs" },
      { checkoutFilterDrivers: new Set() },
    ),
    false,
  );
});

test("uses Git's text heuristic before automatic CRLF conversion", () => {
  assert.equal(gitWouldTreatAsText(Buffer.from("one\ntwo\n")), true);
  assert.equal(gitWouldTreatAsText(Buffer.from("one\0two\n")), false);
  assert.equal(gitWouldTreatAsText(Buffer.from("one\rtwo\n")), false);
  assert.equal(gitWouldTreatAsText(Buffer.alloc(128, 0x01)), false);
  assert.equal(gitWouldTreatAsText(Buffer.from("日本語\n")), true);
});

test("parses ls-tree output including paths with spaces", () => {
  const oid = "a".repeat(40);
  const output = Buffer.from(`100644 blob ${oid}      12\tpath with space.txt\0`);
  assert.deepEqual(parseGitTreeOutput(output), [
    { mode: "100644", objectId: oid, path: "path with space.txt", size: 12 },
  ]);
});

test("keeps an unreadable blob distinct from an absent path", () => {
  const oid = "a".repeat(40);
  const output = Buffer.from(`100644 blob ${oid}       -\tbroken.txt\0`);
  assert.deepEqual(parseGitTreeOutput(output), [
    { mode: "100644", objectId: oid, path: "broken.txt", size: undefined },
  ]);
});

test("retains a symlink mode so callers can reject it", () => {
  const oid = "a".repeat(40);
  const output = Buffer.from(`120000 blob ${oid}       6\tlinked.txt\0`);
  assert.deepEqual(parseGitTreeOutput(output), [
    { mode: "120000", objectId: oid, path: "linked.txt", size: 6 },
  ]);
});

test("retains gitlinks and trees so callers fail closed instead of treating them as absent", () => {
  const oid = "a".repeat(40);
  const output = Buffer.from(
    `160000 commit ${oid}       -\tmodule\0` +
      `040000 tree ${oid}       -\tdirectory\0`,
  );
  assert.deepEqual(parseGitTreeOutput(output), [
    { mode: "160000", objectId: oid, path: "module", size: undefined },
    { mode: "040000", objectId: oid, path: "directory", size: undefined },
  ]);
});

test("bounds total HEAD blob reads and still admits later small blobs", () => {
  const entries = [
    { mode: "100644", objectId: "a".repeat(40), path: "first.txt", size: 6 },
    { mode: "100644", objectId: "b".repeat(40), path: "second.txt", size: 5 },
    { mode: "100644", objectId: "c".repeat(40), path: "third.txt", size: 4 },
    { mode: "100644", objectId: "a".repeat(40), path: "duplicate.txt", size: 6 },
  ];
  const selection = selectGitTreeEntriesWithinBudget(entries, 10);

  assert.deepEqual(selection.selected.map((entry) => entry.path), ["first.txt", "third.txt"]);
  assert.deepEqual(selection.rejected.map((entry) => entry.path), ["second.txt"]);
});

test("uses the configured per-file limit for each HEAD blob", () => {
  assert.equal(gitHeadBlobFitsConfiguredLimit(100 * 1024 * 1024, 100 * 1024 * 1024), true);
  assert.equal(gitHeadBlobFitsConfiguredLimit(100 * 1024 * 1024 + 1, 100 * 1024 * 1024), false);
  assert.equal(gitHeadBlobFitsConfiguredLimit(1025, 1024), false);
});

test("parses size-delimited cat-file batch output", () => {
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  const output = Buffer.concat([
    Buffer.from(`${first} blob 4\n`),
    Buffer.from([0x61, 0x0a, 0x62, 0x0a]),
    Buffer.from("\n"),
    Buffer.from(`${second} blob 3\nxyz\n`),
  ]);
  const parsed = parseGitBatchOutput(output, [first, second]);
  assert.deepEqual(
    parsed.map((value) => [...value]),
    [[0x61, 0x0a, 0x62, 0x0a], [0x78, 0x79, 0x7a]],
  );
  assert.equal(parsed[0]?.buffer, output.buffer);
});

test("parses staged renames without confusing copies and ordinary changes", () => {
  const parsed = parseStagedNameStatusOutput(Buffer.from(
    "R100\0old name.txt\0new name.txt\0C90\0source.txt\0copy.txt\0M\0same.txt\0T\0typed.txt\0",
  ));
  assert.equal(parsed.kind, "found");
  assert.deepEqual(
    parsed.kind === "found" ? [...parsed.headPathByCurrentPath] : [],
    [["new name.txt", "old name.txt"]],
  );
  assert.deepEqual(parsed.kind === "found" ? [...parsed.addedPaths] : [], []);
  assert.deepEqual(
    parsed.kind === "found" ? [...parsed.typeChangedPaths] : [],
    ["typed.txt"],
  );
  assert.equal(parsed.kind === "found" ? parsed.deletionCount : -1, 0);
});

test("fails closed for malformed, conflicted, and duplicate staged rename data", () => {
  for (const output of [
    Buffer.from("R100\0old.txt\0"),
    Buffer.from("R101\0old.txt\0new.txt\0"),
    Buffer.from("U\0conflict.txt\0"),
    Buffer.from("R100\0a.txt\0new.txt\0R90\0b.txt\0new.txt\0"),
    Buffer.from([0x4d, 0, 0xff, 0]),
  ]) {
    assert.deepEqual(parseStagedNameStatusOutput(output), { kind: "failed" });
  }
  assert.deepEqual(
    parseStagedNameStatusOutput(
      Buffer.from("A\0one.txt\0A\0two.txt\0D\0old.txt\0"),
      1,
    ),
    { kind: "failed" },
  );
});
