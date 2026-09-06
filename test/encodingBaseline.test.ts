import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgedEncodingBaseline, parseEncodingBaselines, planEncodingComparison } from "../src/encodingBaseline.js";
import { isMixedPathAllowed } from "../src/rules.js";

const baseline = { encoding: "utf8", expectedEncoding: "shiftjis" };

test("acknowledgement requires the displayed bytes, rule and baseline to remain current", () => {
  const change = { from: "utf8", to: "utf8bom", expectedEncoding: "shiftjis", contentHash: "observed" };
  assert.deepEqual(acknowledgedEncodingBaseline(change, baseline, "observed", "shiftjis"), { encoding: "utf8bom", expectedEncoding: "shiftjis" });
  assert.equal(acknowledgedEncodingBaseline(change, baseline, "edited", "shiftjis"), undefined);
  assert.equal(acknowledgedEncodingBaseline(change, baseline, "observed", "utf8"), undefined);
  assert.equal(acknowledgedEncodingBaseline(change, undefined, "observed", "shiftjis"), undefined);
  assert.equal(acknowledgedEncodingBaseline(change, { ...baseline, encoding: "utf8bom" }, "observed", "shiftjis"), undefined);
  assert.equal(acknowledgedEncodingBaseline({ ...change, to: "invalid" }, baseline, "observed", "shiftjis"), undefined);
});

test("initial scan establishes a baseline, not a change", () => {
  assert.deepEqual(planEncodingComparison({ kind: "mismatch", detectedEncoding: "utf8" }, "shiftjis"),
    { baseline, change: undefined });
});
test("change persists until bytes return to the original encoding", () => {
  const current = { kind: "match" as const, detectedEncoding: "shiftjis" };
  const first = planEncodingComparison(current, "shiftjis", baseline);
  assert.deepEqual(first.change, { from: "utf8", to: "shiftjis" });
  assert.deepEqual(planEncodingComparison(current, "shiftjis", first.baseline), first);
  assert.equal(planEncodingComparison({ kind: "mismatch", detectedEncoding: "utf8" }, "shiftjis", baseline).change, undefined);
});
test("ASCII and ambiguous bytes neither establish nor replace a baseline", () => {
  for (const kind of ["ascii", "ambiguous", "skip"] as const) {
    assert.equal(planEncodingComparison({ kind }, "shiftjis").baseline, undefined);
    assert.deepEqual(planEncodingComparison({ kind }, "shiftjis", baseline), { baseline, change: undefined });
  }
});
test("changing the rule resets the encoding comparison", () => {
  assert.deepEqual(planEncodingComparison({ kind: "match", detectedEncoding: "utf8" }, "utf8", baseline),
    { baseline: { encoding: "utf8", expectedEncoding: "utf8" }, change: undefined });
});
test("only validated baselines are restored", () => {
  assert.equal(parseEncodingBaselines(null).size, 0);
  assert.deepEqual([...parseEncodingBaselines({ good: baseline, bad: { encoding: "fake" }, empty: null })], [["good", baseline]]);
});
test("mixed allowances distinguish literal files and folder boundaries", () => {
  assert.equal(isMixedPathAllowed(["legacy/"], "legacy/deep/a.txt"), true);
  assert.equal(isMixedPathAllowed(["legacy/"], "legacy-other/a.txt"), false);
  assert.equal(isMixedPathAllowed(["a.txt"], "a.txt/child"), false);
  assert.equal(isMixedPathAllowed(["[test]/"], "[test]/a.txt"), true);
  assert.equal(isMixedPathAllowed(["[test]/"], "t/a.txt"), false);
  assert.equal(isMixedPathAllowed(["./"], "a.txt"), true);
});
