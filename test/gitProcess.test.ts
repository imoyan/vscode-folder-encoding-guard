import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CancellationTokenLike,
  GitCommandCancelledError,
  GitCommandError,
  gitEnvironment,
  runCommand,
  runGitCommand,
} from "../src/gitProcess.js";

test("removes Git environment overrides that change repository and pathspec semantics", () => {
  const environment = gitEnvironment({
    PATH: "/bin",
    GIT_CONFIG: "/tmp/alternate-config",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_GLOB_PATHSPECS: "1",
    GIT_NOGLOB_PATHSPECS: "1",
    GIT_ICASE_PATHSPECS: "1",
  });
  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.GIT_CONFIG, undefined);
  assert.equal(environment.GIT_LITERAL_PATHSPECS, undefined);
  assert.equal(environment.GIT_GLOB_PATHSPECS, undefined);
  assert.equal(environment.GIT_NOGLOB_PATHSPECS, undefined);
  assert.equal(environment.GIT_ICASE_PATHSPECS, undefined);
});

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

test("passes input to a command and returns its bytes", async () => {
  const token = new TestCancellationToken();
  const output = await runCommand(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    {
      input: Buffer.from([0x61, 0x00, 0x62]),
      maxOutputBytes: 16,
      token,
    },
  );
  assert.deepEqual([...output], [0x61, 0x00, 0x62]);
});

test("rejects immediately when a running command is cancelled", async () => {
  const token = new TestCancellationToken();
  const startedAt = Date.now();
  const command = runCommand(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { maxOutputBytes: 16, token },
  );
  setImmediate(() => token.cancel());
  await assert.rejects(command, GitCommandCancelledError);
  assert.ok(Date.now() - startedAt < 500);
});

test("stops a command whose output exceeds the limit", async () => {
  const token = new TestCancellationToken();
  await assert.rejects(
    runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100))"],
      { maxOutputBytes: 10, token },
    ),
    GitCommandError,
  );
});

test("blocks every Git transport as a defense against lazy fetches", async () => {
  const token = new TestCancellationToken();
  await assert.rejects(
    runGitCommand(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "ls-remote",
        "file:///does-not-need-to-exist",
      ],
      { maxOutputBytes: 1024, token },
    ),
    (error: unknown) =>
      error instanceof GitCommandError && /transport .* not allowed/i.test(error.message),
  );
});

test("stops a command that closes stdin before consuming input", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "folder-encoding-guard-stdin-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ready = path.join(directory, "ready");
  const token = new TestCancellationToken();
  const command = assert.rejects(
    runCommand(
      process.execPath,
      [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));require("node:fs").closeSync(0);setInterval(()=>{},1000)`,
      ],
      {
        input: Buffer.alloc(8 * 1024 * 1024),
        maxOutputBytes: 16,
        token,
      },
    ),
  );
  await waitForFile(ready);
  const childPid = Number(readFileSync(ready, "utf8"));
  try {
    await command;
    await waitForProcessExit(childPid);
  } finally {
    if (isProcessRunning(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
  }
});

test(
  "force-kills a cancelled command that ignores SIGTERM",
  { skip: process.platform === "win32" ? "Unix signal escalation test" : false },
  async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "folder-encoding-guard-process-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const ready = path.join(directory, "ready");
    const sigtermHandled = path.join(directory, "sigterm-handled");
    const token = new TestCancellationToken();
    const command = runCommand(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM",()=>require("node:fs").writeFileSync(${JSON.stringify(sigtermHandled)},"yes"));require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`,
      ],
      { maxOutputBytes: 16, token },
    );
    await waitForFile(ready);
    const childPid = Number(readFileSync(ready, "utf8"));
    try {
      token.cancel();
      await assert.rejects(command, GitCommandCancelledError);
      await waitForFile(sigtermHandled);
      await waitForProcessExit(childPid);
    } finally {
      if (isProcessRunning(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  },
);

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error("Child process did not become ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) {
      throw new Error("Child process was not force-killed");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
