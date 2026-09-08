import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readGitPolicySnapshot, retainGitVerifications, sameGitPolicySnapshot } from "../src/gitPolicySnapshot.js";
import type { GitHeadVerification } from "../src/gitIntegration.js";

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const supported = spawnSync("git", ["var", "GIT_ATTR_GLOBAL"]).status === 0;

test("500 retained pages keep one repository verification and no old file targets", () => {
  let retained: GitHeadVerification[] = [];
  for (let page = 0; page < 500; page++) {
    const verification: GitHeadVerification = {
      gitPath: "git", repositoryRoot: "/repo", expectedCommit: "same-head", stagedFingerprint: "same-index",
      historyPreconditionFailed: false, expectedPolicyFingerprint: "page-policy",
      targets: Array.from({ length: 100 }, (_, index) => ({ key: String(page * 100 + index), currentPath: `${page * 100 + index}.txt`, historyRepositoryId: "/repo", expectedEncoding: "utf8", maxSize: 1024, inspectHistory: true, readCurrentAttributes: true })),
      policyInputs: { configuration: "same-config", files: new Map([["/repo/.gitattributes", "same-attributes"]]) },
    };
    retained = retainGitVerifications([...retained, verification]);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.targets.length, 0);
    assert.equal(retained[0]?.policyInputs?.files.size, 1);
  }
  const first = retained[0]!;
  const changed = { ...first, policyInputs: { configuration: "same-config", files: new Map([["/repo/.gitattributes", "changed"]]) } };
  assert.equal(retainGitVerifications([first, changed]).length, 2);
  assert.equal(retainGitVerifications([first, { ...first, expectedCommit: "different" }]).length, 2);
  const fallback = { ...first, policyInputs: undefined };
  assert.deepEqual(retainGitVerifications([fallback]), [fallback]);
});

test("policy snapshots detect attribute creation, content, index and config changes", { skip: !supported }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "git-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init");
  const globalAttributes = path.join(root, "global-attributes");
  git("config", "core.attributesFile", globalAttributes);
  mkdirSync(path.join(root, "sub"));
  const baseline = await readGitPolicySnapshot("git", root, ["sub/a.txt", "sub/b.txt"], token);
  assert.ok(baseline);
  const refresh = () => readGitPolicySnapshot("git", root, [], token, baseline.files.keys());
  assert.ok(sameGitPolicySnapshot(baseline, (await refresh())!));
  for (const attribute of [".gitattributes", "sub/.gitattributes", ".git/info/attributes", "global-attributes"]) {
    writeFileSync(path.join(root, attribute), "*.txt text eol=crlf\n");
    assert.equal(sameGitPolicySnapshot(baseline, (await refresh())!), false, attribute);
    rmSync(path.join(root, attribute));
  }
  writeFileSync(path.join(root, ".gitattributes"), "*.txt text eol=lf\n");
  git("add", ".gitattributes");
  rmSync(path.join(root, ".gitattributes"));
  assert.equal(sameGitPolicySnapshot(baseline, (await refresh())!), false, "index fallback");
  git("rm", "--cached", "-f", ".gitattributes");
  git("config", "core.autocrlf", "true");
  assert.equal(sameGitPolicySnapshot(baseline, (await refresh())!), false, "config");
  assert.equal(await readGitPolicySnapshot("nonexistent-git-for-test", root, [], token), undefined);
});
