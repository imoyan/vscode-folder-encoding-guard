import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  didGitHistoryLookupFail,
  PromiseWaitCancelledError,
  prepareRepositoryTargets,
  resolveGitHistoryIdentity,
  waitForPromiseUnlessCancelled,
} from "../src/gitIntegrationCore.js";
import { CancellationTokenLike } from "../src/gitProcess.js";

const repositoryRoot = path.join(path.sep, "workspace", "repo");
const repositoryId = "file:///workspace/repo";

test("compares each tracked path directly instead of trusting cached Git status", () => {
  const filePath = path.join(repositoryRoot, "file.txt");
  const [prepared] = prepareRepositoryTargets(
    repositoryId,
    repositoryRoot,
    [resource(filePath)],
    new Set(),
  );

  assert.equal(prepared?.target.inspectHistory, true);
  assert.equal(prepared?.target.headPath, "file.txt");
});

test("uses a staged rename's original HEAD path", () => {
  const filePath = path.join(repositoryRoot, "new.txt");
  const [prepared] = prepareRepositoryTargets(
    repositoryId,
    repositoryRoot,
    [resource(filePath)],
    new Set(),
    new Map([["new.txt", "old.txt"]]),
  );

  assert.equal(prepared?.target.currentPath, "new.txt");
  assert.equal(prepared?.target.headPath, "old.txt");
});

test("fails history safely for an unresolved staged add-delete pair", () => {
  const filePath = path.join(repositoryRoot, "new.txt");
  const [prepared] = prepareRepositoryTargets(
    repositoryId,
    repositoryRoot,
    [resource(filePath)],
    new Set(),
    new Map(),
    new Set(["new.txt"]),
  );

  assert.equal(prepared?.target.historyPreconditionFailed, true);
});

test("keeps a local baseline when a new file becomes staged", () => {
  assert.equal(
    resolveGitHistoryIdentity(
      { head: { kind: "absent" }, historyIdentity: "git:head-policy" },
      repositoryId,
      "utf8",
    ),
    `git-untracked:${repositoryId}:utf8`,
  );
  assert.equal(
    resolveGitHistoryIdentity(
      {
        head: { kind: "found", lineEndings: { kind: "lf", styles: ["lf"] } },
        historyIdentity: "git:head-policy",
      },
      repositoryId,
      "utf8",
    ),
    "git:head-policy",
  );
  assert.equal(
    resolveGitHistoryIdentity(
      undefined,
      repositoryId,
      "utf8",
      "head-oid",
    ),
    `git-unavailable:${repositoryId}:head-oid:utf8`,
  );
  assert.equal(
    resolveGitHistoryIdentity(
      { head: { kind: "failed" }, historyIdentity: "git:new-head:policy" },
      repositoryId,
      "utf8",
      "new-head",
    ),
    "git:new-head:policy",
  );
});

test("fails closed when a supposedly clean file is absent from HEAD", () => {
  assert.equal(didGitHistoryLookupFail(true, { head: { kind: "absent" } }), false);
  assert.equal(didGitHistoryLookupFail(true, { head: { kind: "failed" } }), true);
});

test("stops waiting for a pending extension activation when cancelled", async () => {
  const token = new TestCancellationToken();
  const pending = new Promise<never>(() => undefined);
  const waiting = waitForPromiseUnlessCancelled(pending, token);

  token.cancel();

  await assert.rejects(waiting, PromiseWaitCancelledError);
});

test("observes a rejected operation even when cancellation was already requested", async () => {
  const token = new TestCancellationToken();
  token.cancel();

  await assert.rejects(
    waitForPromiseUnlessCancelled(Promise.reject(new Error("activation failed")), token),
    PromiseWaitCancelledError,
  );
});

function resource(absolutePath: string) {
  return {
    key: `file://${absolutePath}`,
    absolutePath,
    expectedEncoding: "utf8",
    maxSize: 1024,
    inspectHistory: true,
  } as const;
}

class TestCancellationToken implements CancellationTokenLike {
  public isCancellationRequested = false;
  private readonly listeners = new Set<() => void>();

  public onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
