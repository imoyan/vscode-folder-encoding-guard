import { spawn } from "node:child_process";

const FORCE_KILL_DELAY_MS = 1000;

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface GitCommandOptions {
  readonly input?: Uint8Array;
  readonly maxOutputBytes: number;
  readonly token: CancellationTokenLike;
}

export class GitCommandError extends Error {
  public constructor(
    message: string,
    public readonly exitCode?: number,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export class GitCommandCancelledError extends Error {
  public constructor() {
    super("Git command cancelled");
    this.name = "GitCommandCancelledError";
  }
}

export async function runGitCommand(
  gitPath: string,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<Buffer> {
  return runCommand(
    gitPath,
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      ...args,
    ],
    options,
  );
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<Buffer> {
  if (options.token.isCancellationRequested) {
    throw new GitCommandCancelledError();
  }
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    let cancellation: { dispose(): void } | undefined = undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const child = spawn(executable, [...args], {
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (error?: Error, output?: Buffer): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancellation?.dispose();
      if (error) {
        reject(error);
      } else {
        resolve(output ?? Buffer.alloc(0));
      }
    };

    const terminate = (error: Error): void => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
      }
      finish(error);
    };

    cancellation = options.token.onCancellationRequested(() => {
      terminate(new GitCommandCancelledError());
    });
    if (options.token.isCancellationRequested) {
      terminate(new GitCommandCancelledError());
      return;
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      stdoutSize += chunk.length;
      if (stdoutSize > options.maxOutputBytes) {
        terminate(new GitCommandError("Git command output exceeded the configured limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = 64 * 1024 - stderrSize;
      if (remaining <= 0) {
        return;
      }
      const captured = chunk.subarray(0, remaining);
      stderr.push(captured);
      stderrSize += captured.length;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      }
      if (code === 0) {
        finish(undefined, Buffer.concat(stdout));
      } else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(
          new GitCommandError(
            detail || `Git command exited with status ${code ?? "unknown"}`,
            code ?? undefined,
          ),
        );
      }
    });
    child.stdin.on("error", (error) => terminate(error));
    child.stdin.end(options.input);
  });
}

export function gitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...source,
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const removed = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ATTR_SOURCE",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_ICASE_PATHSPECS",
    "GIT_GLOB_PATHSPECS",
    "GIT_LITERAL_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]);
  const enforced = new Set(["GIT_ALLOW_PROTOCOL", "GIT_NO_LAZY_FETCH", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT"]);
  for (const key of Object.keys(environment)) {
    const normalized = platform === "win32" ? key.toUpperCase() : key;
    if (removed.has(normalized) || (key !== normalized && enforced.has(normalized))) delete environment[key];
  }
  return environment;
}
