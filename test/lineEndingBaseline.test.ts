import assert from "node:assert/strict";
import test from "node:test";
import {
  isPortableLocalBaseline,
  parseLegacyLineEndingBaselines,
  parseLineEndingBaselines,
  planLineEndingComparison,
} from "../src/lineEndingBaseline.js";
import { LineEndingClassification, LineEndingKind } from "../src/scanCore.js";

function lineEndings(kind: Exclude<LineEndingKind, "mixed">): LineEndingClassification {
  return { kind, styles: kind === "none" ? [] : [kind] };
}

test("reuses only a baseline for the current HEAD identity", () => {
  const stored = { kind: "lf", identity: "head-a", source: "git" } as const;
  assert.deepEqual(
    planLineEndingComparison({
      current: lineEndings("crlf"),
      historyIdentity: "head-a",
      historyUnavailable: false,
      fallbackIdentity: "fallback",
      stored,
    }),
    {
      reference: { previous: { kind: "lf" }, source: "git" },
      nextBaseline: stored,
    },
  );
});

test("replaces a stale baseline with the current HEAD reference", () => {
  assert.deepEqual(
    planLineEndingComparison({
      current: lineEndings("crlf"),
      head: lineEndings("crlf"),
      historyIdentity: "head-b",
      historyUnavailable: false,
      fallbackIdentity: "fallback",
      stored: { kind: "lf", identity: "head-a", source: "git" },
    }),
    {
      reference: { previous: lineEndings("crlf"), source: "git" },
      nextBaseline: {
        kind: "crlf",
        styles: ["crlf"],
        identity: "head-b",
        source: "git",
      },
    },
  );
});

test("upgrades a fallback baseline when the same HEAD becomes readable", () => {
  assert.deepEqual(
    planLineEndingComparison({
      current: lineEndings("crlf"),
      head: lineEndings("lf"),
      historyIdentity: "head-a",
      historyUnavailable: false,
      fallbackIdentity: "fallback",
      stored: { kind: "crlf", identity: "head-a", source: "baseline" },
    }),
    {
      reference: { previous: lineEndings("lf"), source: "git" },
      nextBaseline: { kind: "lf", styles: ["lf"], identity: "head-a", source: "git" },
    },
  );
});

test("starts a local baseline when the identified new HEAD cannot be read", () => {
  assert.deepEqual(
    planLineEndingComparison({
      current: lineEndings("crlf"),
      historyIdentity: "head-b",
      historyUnavailable: true,
      fallbackIdentity: "fallback",
      stored: { kind: "lf", identity: "head-a", source: "git" },
    }),
    {
      reference: {},
      nextBaseline: {
        kind: "crlf",
        styles: ["crlf"],
        identity: "head-b",
        source: "baseline",
      },
    },
  );
});

test("seeds a fallback baseline when history is unavailable initially", () => {
  assert.deepEqual(
    planLineEndingComparison({
      current: lineEndings("crlf"),
      historyUnavailable: true,
      fallbackIdentity: "fallback:utf8",
    }),
    {
      reference: {},
      nextBaseline: {
        kind: "crlf",
        styles: ["crlf"],
        identity: "fallback:utf8",
        source: "baseline",
      },
    },
  );
});

test("compares against a fallback baseline during a continuing outage", () => {
  const stored = {
    kind: "crlf",
    identity: "unavailable:utf8",
    source: "baseline",
  } as const;
  assert.deepEqual(
    planLineEndingComparison({
      current: lineEndings("lf"),
      historyUnavailable: true,
      fallbackIdentity: "unavailable:utf8",
      stored,
    }),
    {
      reference: { previous: { kind: "crlf" }, source: "baseline" },
      nextBaseline: stored,
    },
  );
});

test("keeps comparing when an unavailable folder is confirmed as non-Git", () => {
  assert.deepEqual(
    planLineEndingComparison({
      current: lineEndings("crlf"),
      historyIdentity: "non-git:utf8",
      historyUnavailable: false,
      fallbackIdentity: "unavailable:utf8",
      compatibleStoredIdentities: ["unavailable:utf8"],
      stored: {
        kind: "lf",
        identity: "unavailable:utf8",
        source: "baseline",
      },
    }),
    {
      reference: { previous: { kind: "lf" }, source: "baseline" },
      nextBaseline: {
        kind: "lf",
        identity: "non-git:utf8",
        source: "baseline",
      },
    },
  );
});

test("preserves but does not compare a Git baseline when status is unavailable", () => {
  const stored = { kind: "lf", identity: "head-a", source: "git" } as const;
  assert.deepEqual(
    planLineEndingComparison({
      current: lineEndings("crlf"),
      historyUnavailable: true,
      fallbackIdentity: "unavailable:utf8",
      stored,
    }),
    { reference: {}, nextBaseline: stored },
  );
});

test("learns the style set of a legacy local mixed baseline without a false change", () => {
  assert.deepEqual(
    planLineEndingComparison({
      current: { kind: "mixed", styles: ["lf", "crlf"] },
      historyIdentity: "non-git:utf8",
      historyUnavailable: false,
      fallbackIdentity: "unavailable:utf8",
      stored: {
        kind: "mixed",
        identity: "non-git:utf8",
        source: "baseline",
      },
    }),
    {
      reference: {
        previous: { kind: "mixed" },
        source: "baseline",
      },
      nextBaseline: {
        kind: "mixed",
        styles: ["lf", "crlf"],
        identity: "non-git:utf8",
        source: "baseline",
      },
    },
  );
});

test("does not learn Git mixed details from the working tree during a history outage", () => {
  const stored = { kind: "mixed", identity: "head-a", source: "git" } as const;
  assert.deepEqual(
    planLineEndingComparison({
      current: { kind: "mixed", styles: ["lf", "cr"] },
      historyIdentity: "head-a",
      historyUnavailable: true,
      fallbackIdentity: "unavailable:utf8",
      stored,
    }),
    {
      reference: {
        previous: { kind: "mixed" },
        source: "git",
      },
      nextBaseline: stored,
    },
  );
});

test("drops malformed persisted baselines", () => {
  assert.deepEqual(
    [...parseLineEndingBaselines({
      valid: { kind: "lf", identity: "head", source: "git" },
      invalidKind: { kind: "other", identity: "head", source: "git" },
      invalidSource: { kind: "lf", identity: "head", source: "other" },
      invalidStyles: {
        kind: "mixed",
        styles: ["crlf", "lf"],
        identity: "head",
        source: "git",
      },
      primitive: "lf",
    })],
    [["valid", { kind: "lf", styles: ["lf"], identity: "head", source: "git" }]],
  );
});

test("reads v1 values as local baselines for a one-time migration", () => {
  assert.deepEqual(
    [...parseLegacyLineEndingBaselines({ valid: "lf", invalid: "other" })],
    [["valid", {
      kind: "lf",
      styles: ["lf"],
      identity: "legacy:v1",
      source: "baseline",
    }]],
  );
});

test("carries only local baselines across Git availability changes", () => {
  assert.equal(
    isPortableLocalBaseline(
      { kind: "lf", identity: "non-git:utf8", source: "baseline" },
      "utf8",
    ),
    true,
  );
  assert.equal(
    isPortableLocalBaseline(
      { kind: "lf", identity: "git-untracked:file:///repo:utf8", source: "baseline" },
      "utf8",
    ),
    true,
  );
  assert.equal(
    isPortableLocalBaseline(
      { kind: "lf", identity: "git:file:///repo:head", source: "git" },
      "utf8",
    ),
    false,
  );
});
