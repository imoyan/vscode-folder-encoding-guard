import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { parseGitAttributeOutput } from "./gitAttributeCore.js";
import {
  GitCheckoutConfig,
  GitPathAttributes,
  GitTreeEntry,
  effectiveEolRule,
  gitHeadBlobFitsConfiguredLimit,
  gitWouldTreatAsText,
  groupGitAttributes,
  headBlobEncodingHint,
  hasExternalGitFilter,
  parseGitBatchOutput,
  parseStagedNameStatusOutput,
  parseGitTreeOutput,
  projectCheckoutLineEndings,
  selectGitTreeEntriesWithinBudget,
} from "./gitInspectionCore.js";
import {
  CancellationTokenLike,
  GitCommandCancelledError,
  GitCommandError,
  runGitCommand,
} from "./gitProcess.js";
import {
  classifyLineEndings,
  LineEndingClassification,
} from "./scanCore.js";
import { gitPathComparisonKey } from "./gitPath.js";

const ATTRIBUTE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const ATTRIBUTE_PATH_CHUNK_SIZE = 200;
const GIT_ARGUMENT_LIMIT = 24_000;
const HEAD_BATCH_BYTES = 16 * 1024 * 1024;
const HEAD_CONTENT_BUDGET = 128 * 1024 * 1024;
const STAGED_STATUS_OUTPUT_LIMIT = 4 * 1024 * 1024;
const TREE_OUTPUT_LIMIT = 4 * 1024 * 1024;

export interface RepositoryInspectionTarget {
  readonly key: string;
  readonly currentPath: string;
  readonly headPath?: string;
  readonly expectedEncoding: string;
  readonly maxSize: number;
  readonly readCurrentAttributes: boolean;
  readonly inspectHistory: boolean;
  readonly baselineIdentity?: string;
  readonly baselineSource?: "git" | "baseline";
  readonly baselineDetailsKnown?: boolean;
  readonly historyRepositoryId: string;
  readonly historyPreconditionFailed?: boolean;
}

export interface RepositoryFileInspection {
  readonly expectedLineEnding?: "lf" | "crlf";
  readonly attributeLookupFailed: boolean;
  readonly head: HeadReadResult;
  readonly historyIdentity?: string;
}

export interface GitInspectionBudget {
  remainingHeadContentBytes: number;
}

export interface GitRepositoryInspectionOptions {
  readonly budget?: GitInspectionBudget;
  readonly historyPreconditionFailed?: boolean;
  readonly metadataOnly?: boolean;
  readonly verifyEncoding?: (
    bytes: Uint8Array,
    expectedEncoding: string,
  ) => Promise<boolean>;
}

export type StagedRenameSnapshot =
  | {
    readonly kind: "found";
    readonly fingerprint: string;
    readonly headPathByCurrentPath: ReadonlyMap<string, string>;
    readonly uncertainCurrentPaths: ReadonlySet<string>;
    readonly ignoreCase: boolean;
  }
  | { readonly kind: "failed" };

type HeadEncodingVerifier = NonNullable<
  GitRepositoryInspectionOptions["verifyEncoding"]
>;

export function createGitInspectionBudget(
  headContentBytes = HEAD_CONTENT_BUDGET,
): GitInspectionBudget {
  return { remainingHeadContentBytes: Math.max(0, headContentBytes) };
}

export type HeadReadResult =
  | { readonly kind: "found"; readonly lineEndings: LineEndingClassification }
  | { readonly kind: "absent" }
  | { readonly kind: "failed" }
  | { readonly kind: "notNeeded" };

export type RepositoryHeadResult =
  | { readonly kind: "found"; readonly commit: string }
  | { readonly kind: "unborn" }
  | { readonly kind: "failed" };

type HeadInspectionTarget = RepositoryInspectionTarget & {
  readonly headPath: string;
};

interface HeadInspectionResult {
  readonly head: HeadReadResult;
  readonly historyIdentity: string;
}

async function repositoryRootMatchesGit(
  gitPath: string,
  repositoryRoot: string,
  token: CancellationTokenLike,
): Promise<boolean> {
  try {
    const output = await runGitCommand(
      gitPath,
      ["-C", repositoryRoot, "rev-parse", "--show-toplevel"],
      { maxOutputBytes: 16 * 1024, token },
    );
    const reportedRoot = output.toString("utf8").trim();
    if (!reportedRoot) {
      return false;
    }
    const [expected, reported] = await Promise.all([
      realpath(repositoryRoot),
      realpath(reportedRoot),
    ]);
    return expected === reported;
  } catch {
    throwIfCancelled(token);
    return false;
  }
}

export async function readRepositoryHead(
  gitPath: string,
  repositoryRoot: string,
  token: CancellationTokenLike,
): Promise<RepositoryHeadResult> {
  if (!(await repositoryRootMatchesGit(gitPath, repositoryRoot, token))) {
    return { kind: "failed" };
  }
  let partialClone: boolean;
  try {
    partialClone = await isPartialCloneRepository(gitPath, repositoryRoot, token);
  } catch {
    throwIfCancelled(token);
    return { kind: "failed" };
  }
  if (partialClone) {
    return readRepositoryReference(gitPath, repositoryRoot, token);
  }
  try {
    const output = await runGitCommand(
      gitPath,
      ["-C", repositoryRoot, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      { maxOutputBytes: 1024, token },
    );
    const commit = output.toString("ascii").trim();
    return /^[0-9a-f]{40,64}$/.test(commit)
      ? { kind: "found", commit }
      : { kind: "failed" };
  } catch (error) {
    throwIfCancelled(token);
    if (!(error instanceof GitCommandError) || error.exitCode !== 1) {
      return { kind: "failed" };
    }
    try {
      await runGitCommand(
        gitPath,
        ["-C", repositoryRoot, "rev-parse", "--verify", "--quiet", "HEAD"],
        { maxOutputBytes: 1024, token },
      );
      return { kind: "failed" };
    } catch (headError) {
      throwIfCancelled(token);
      return headError instanceof GitCommandError && headError.exitCode === 1
        ? { kind: "unborn" }
        : { kind: "failed" };
    }
  }
}

async function readRepositoryReference(
  gitPath: string,
  repositoryRoot: string,
  token: CancellationTokenLike,
): Promise<RepositoryHeadResult> {
  try {
    const output = await runGitCommand(
      gitPath,
      ["-C", repositoryRoot, "rev-parse", "--verify", "--quiet", "HEAD"],
      { maxOutputBytes: 1024, token },
    );
    const commit = output.toString("ascii").trim();
    return /^[0-9a-f]{40,64}$/.test(commit)
      ? { kind: "found", commit }
      : { kind: "failed" };
  } catch (error) {
    throwIfCancelled(token);
    return error instanceof GitCommandError && error.exitCode === 1
      ? { kind: "unborn" }
      : { kind: "failed" };
  }
}

export async function readStagedRenameSnapshot(
  gitPath: string,
  repositoryRoot: string,
  headCommit: string,
  token: CancellationTokenLike,
): Promise<StagedRenameSnapshot> {
  try {
    const ignoreCaseValue = await readOptionalConfig(
      gitPath,
      repositoryRoot,
      "core.ignorecase",
      token,
    );
    const ignoreCase = ignoreCaseValue === undefined
      ? false
      : parseGitBoolean(ignoreCaseValue);
    if (ignoreCase === undefined) {
      return { kind: "failed" };
    }
    if (await isPartialCloneRepository(gitPath, repositoryRoot, token)) {
      return { kind: "failed" };
    }
    const output = await runGitCommand(
      gitPath,
      [
        "-C",
        repositoryRoot,
        "diff",
        "--cached",
        "--name-status",
        "-z",
        "--find-renames=100%",
        "-l1000",
        "--no-ext-diff",
        "--no-textconv",
        headCommit,
        "--",
      ],
      { maxOutputBytes: STAGED_STATUS_OUTPUT_LIMIT, token },
    );
    const parsed = parseStagedNameStatusOutput(output);
    if (parsed.kind === "failed") {
      return parsed;
    }
    const normalizedRenames = new Map<string, string>();
    const uncertainCurrentPaths = new Set<string>();
    for (const [currentPath, headPath] of parsed.headPathByCurrentPath) {
      const key = gitPathComparisonKey(currentPath, process.platform, ignoreCase);
      if (normalizedRenames.has(key)) {
        return { kind: "failed" };
      }
      normalizedRenames.set(key, headPath);
    }
    const renameIsAmbiguous = normalizedRenames.size > 0 && (
      normalizedRenames.size > 1 ||
      parsed.addedPaths.size > 0 ||
      parsed.deletionCount > 0
    );
    if (parsed.deletionCount > 0 || renameIsAmbiguous) {
      for (const addedPath of parsed.addedPaths) {
        uncertainCurrentPaths.add(
          gitPathComparisonKey(addedPath, process.platform, ignoreCase),
        );
      }
    }
    if (renameIsAmbiguous) {
      for (const currentPath of normalizedRenames.keys()) {
        uncertainCurrentPaths.add(currentPath);
      }
    }
    for (const typeChangedPath of parsed.typeChangedPaths) {
      uncertainCurrentPaths.add(
        gitPathComparisonKey(typeChangedPath, process.platform, ignoreCase),
      );
    }
    return {
      kind: "found",
      fingerprint: createHash("sha256").update(output).digest("hex"),
      headPathByCurrentPath: normalizedRenames,
      uncertainCurrentPaths,
      ignoreCase,
    };
  } catch {
    throwIfCancelled(token);
    return { kind: "failed" };
  }
}

async function readOptionalConfig(
  gitPath: string,
  repositoryRoot: string,
  key: string,
  token: CancellationTokenLike,
  localOnly = false,
): Promise<string | undefined> {
  try {
    const output = await runGitCommand(
      gitPath,
      [
        "-C",
        repositoryRoot,
        "config",
        ...(localOnly ? ["--local"] : []),
        "--get",
        key,
      ],
      { maxOutputBytes: 16 * 1024, token },
    );
    return output.toString("utf8").trim();
  } catch (error) {
    throwIfCancelled(token);
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return undefined;
    }
    throw error;
  }
}

export async function isPartialCloneRepository(
  gitPath: string,
  repositoryRoot: string,
  token: CancellationTokenLike,
): Promise<boolean> {
  const partialClone = await readOptionalConfig(
    gitPath,
    repositoryRoot,
    "extensions.partialClone",
    token,
    true,
  );
  if (partialClone !== undefined && partialClone.length > 0) {
    return true;
  }
  try {
    const output = await runGitCommand(
      gitPath,
      [
        "-C",
        repositoryRoot,
        "config",
        "--local",
        "--type=bool",
        "--null",
        "--get-regexp",
        "^remote\\..*\\.promisor$",
      ],
      { maxOutputBytes: 64 * 1024, token },
    );
    return output
      .toString("utf8")
      .split("\0")
      .some((record) => {
        const separator = record.indexOf("\n");
        if (separator < 0) {
          return record.trim().length > 0;
        }
        const value = record.slice(separator + 1).trim().toLowerCase();
        return value === "true";
      });
  } catch (error) {
    throwIfCancelled(token);
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return false;
    }
    throw error;
  }
}

export function chunkGitArguments(
  values: readonly string[],
  maximumBytes = GIT_ARGUMENT_LIMIT,
): readonly string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let size = 0;
  for (const value of values) {
    const valueSize = Buffer.byteLength(value) + 1;
    if (chunk.length > 0 && size + valueSize > maximumBytes) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(value);
    size += valueSize;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function parseGitBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "off"].includes(normalized)) {
    return false;
  }
  const numeric = /^([+-]?)(0x[0-9a-f]+|\d+)(?:[kmg])?$/i.exec(normalized);
  if (!numeric) {
    return undefined;
  }
  try {
    const magnitude = BigInt(numeric[2]!);
    return magnitude !== 0n;
  } catch {
    return undefined;
  }
}

function throwIfCancelled(token: CancellationTokenLike): void {
  if (token.isCancellationRequested) {
    throw new GitCommandCancelledError();
  }
}