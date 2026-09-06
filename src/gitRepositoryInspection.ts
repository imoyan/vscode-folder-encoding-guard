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
    const reportedRoot = output.toString("utf8").replace(/\n$/, "");
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

export async function inspectGitRepository(
  gitPath: string,
  repositoryRoot: string,
  headCommit: string | undefined,
  targets: readonly RepositoryInspectionTarget[],
  token: CancellationTokenLike,
  options: GitRepositoryInspectionOptions = {},
): Promise<ReadonlyMap<string, RepositoryFileInspection>> {
  const budget = options.budget ?? createGitInspectionBudget();
  const config = await readCheckoutConfig(gitPath, repositoryRoot, token);
  const partialClone = await isPartialCloneRepository(gitPath, repositoryRoot, token);
  const attributeTargets = targets.filter((target) => target.readCurrentAttributes);
  const currentAttributes = partialClone
    ? { values: new Map<string, GitPathAttributes>(), failed: attributeTargets.length > 0 }
    : await readAttributes(
      gitPath,
      repositoryRoot,
      attributeTargets.map((target) => target.currentPath),
      ["text", "crlf", "eol", "filter"],
      undefined,
      token,
    );
  const headTargets = targets.filter(
    (target): target is RepositoryInspectionTarget & { readonly headPath: string } =>
      target.inspectHistory && target.headPath !== undefined,
  );
  const blockedHeadTargets = headTargets.filter(
    (target) => target.historyPreconditionFailed,
  );
  const readableHeadTargets = headTargets.filter(
    (target) => !headCommit || !target.historyPreconditionFailed,
  );
  const headResults = options.historyPreconditionFailed && headCommit
    ? failedHeadResults(headTargets, headCommit)
    : new Map([
      ...(headCommit ? failedHeadResults(blockedHeadTargets, headCommit) : new Map()),
      ...await readHeadLineEndings(
        gitPath,
        repositoryRoot,
        headCommit,
        readableHeadTargets,
        config,
        token,
        budget,
        partialClone,
        options.verifyEncoding,
        options.metadataOnly === true,
      ),
    ]);

  return new Map(
    targets.map((target) => {
      const attributes = currentAttributes.values.get(
        gitPathComparisonKey(target.currentPath),
      );
      const unsafeFilter = attributes && hasExternalGitFilter(attributes, config);
      return [
        target.key,
        {
          expectedLineEnding: unsafeFilter
            ? undefined
            : effectiveEolRule(attributes ?? {}),
          attributeLookupFailed:
            target.readCurrentAttributes && (currentAttributes.failed || unsafeFilter === true),
          head: headResults.get(target.key)?.head ?? { kind: "notNeeded" },
          historyIdentity: headResults.get(target.key)?.historyIdentity,
        },
      ];
    }),
  );
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

async function readHeadLineEndings(
  gitPath: string,
  repositoryRoot: string,
  headCommit: string | undefined,
  targets: readonly HeadInspectionTarget[],
  config: GitCheckoutConfig,
  token: CancellationTokenLike,
  budget: GitInspectionBudget,
  partialClone: boolean,
  verifyEncoding: HeadEncodingVerifier | undefined,
  metadataOnly: boolean,
): Promise<ReadonlyMap<string, HeadInspectionResult>> {
  const results = new Map<string, HeadInspectionResult>();
  if (targets.length === 0) {
    return results;
  }
  if (!headCommit) {
    return new Map(targets.map((target) => [
      target.key,
      {
        head: { kind: "absent" },
        historyIdentity: createHistoryIdentity(target, undefined, {}, config),
      },
    ]));
  }
  try {
    if (partialClone) {
      return failedHeadResults(targets, headCommit);
    }
    const paths = [...new Set(targets.map((target) => target.headPath))];
    const attributes = await readAttributes(
      gitPath,
      repositoryRoot,
      paths,
      ["text", "crlf", "eol", "working-tree-encoding", "filter"],
      headCommit,
      token,
    );
    if (attributes.failed) {
      return failedHeadResults(targets, headCommit);
    }
    const readTargets: HeadInspectionTarget[] = [];
    for (const target of targets) {
      const headAttributes = attributes.values.get(
        gitPathComparisonKey(target.headPath),
      ) ?? {};
      const historyIdentity = createHistoryIdentity(
        target,
        headCommit,
        headAttributes,
        config,
      );
      const shouldRead =
        target.baselineIdentity !== historyIdentity ||
        target.baselineSource !== "git" ||
        target.baselineDetailsKnown === false;
      if (shouldRead && !metadataOnly) {
        readTargets.push(target);
      } else {
        results.set(target.key, { head: { kind: "notNeeded" }, historyIdentity });
      }
    }
    if (readTargets.length === 0) {
      return results;
    }
    const treeEntries = await readTreeEntries(
      gitPath,
      repositoryRoot,
      headCommit,
      [...new Set(readTargets.map((target) => target.headPath))],
      config.ignoreCase === true,
      token,
    );
    const entriesByPath = new Map<string, GitTreeEntry>();
    const ambiguousTreePaths = new Set<string>();
    for (const entry of treeEntries) {
      const key = gitPathComparisonKey(entry.path, process.platform, config.ignoreCase === true);
      if (entriesByPath.has(key)) {
        entriesByPath.delete(key);
        ambiguousTreePaths.add(key);
      } else if (!ambiguousTreePaths.has(key)) {
        entriesByPath.set(key, entry);
      }
    }
    const entriesByObjectId = new Map<
      string,
      GitTreeEntry & { readonly size: number }
    >();
    const targetsByObjectId = new Map<string, HeadInspectionTarget[]>();
    for (const target of readTargets) {
      const historyIdentity = createHistoryIdentity(
        target,
        headCommit,
        attributes.values.get(gitPathComparisonKey(target.headPath)) ?? {},
        config,
      );
      const treePathKey = gitPathComparisonKey(
        target.headPath,
        process.platform,
        config.ignoreCase === true,
      );
      if (ambiguousTreePaths.has(treePathKey)) {
        results.set(target.key, { head: { kind: "failed" }, historyIdentity });
        continue;
      }
      const entry = entriesByPath.get(treePathKey);
      if (!entry) {
        results.set(target.key, { head: { kind: "absent" }, historyIdentity });
        continue;
      }
      const headAttributes = attributes.values.get(
        gitPathComparisonKey(target.headPath),
      ) ?? {};
      if (
        (entry.mode !== "100644" && entry.mode !== "100755") ||
        entry.size === undefined ||
        !gitHeadBlobFitsConfiguredLimit(entry.size, target.maxSize) ||
        hasExternalGitFilter(headAttributes, config)
      ) {
        results.set(target.key, { head: { kind: "failed" }, historyIdentity });
        continue;
      }
      entriesByObjectId.set(entry.objectId, { ...entry, size: entry.size });
      const objectTargets = targetsByObjectId.get(entry.objectId) ?? [];
      objectTargets.push(target);
      targetsByObjectId.set(entry.objectId, objectTargets);
    }
    const selection = selectGitTreeEntriesWithinBudget(
      [...entriesByObjectId.values()],
      budget.remainingHeadContentBytes,
    );
    budget.remainingHeadContentBytes -= selection.selected.reduce(
      (total, entry) => total + entry.size,
      0,
    );
    for (const entry of selection.rejected) {
      for (const target of targetsByObjectId.get(entry.objectId) ?? []) {
        results.set(target.key, {
          head: { kind: "failed" },
          historyIdentity: createHistoryIdentity(
            target,
            headCommit,
            attributes.values.get(gitPathComparisonKey(target.headPath)) ?? {},
            config,
          ),
        });
      }
    }
    await visitBlobs(
      gitPath,
      repositoryRoot,
      selection.selected,
      token,
      async (objectId, rawBlob) => {
        const autoTextEligible = gitWouldTreatAsText(rawBlob);
        const interpretations = new Map<
          string,
          {
            readonly encodingMatches: boolean;
            readonly lineEndings?: ReturnType<typeof classifyLineEndings>;
          }
        >();
        for (const target of targetsByObjectId.get(objectId) ?? []) {
          const headAttributes = attributes.values.get(
            gitPathComparisonKey(target.headPath),
          ) ?? {};
          const contentEncoding = headBlobEncodingHint(
            target.expectedEncoding,
            headAttributes,
          );
          if (!contentEncoding) {
            results.set(target.key, {
              head: { kind: "failed" },
              historyIdentity: createHistoryIdentity(
                target,
                headCommit,
                headAttributes,
                config,
              ),
            });
            continue;
          }
          let interpretation = interpretations.get(contentEncoding);
          if (!interpretation) {
            const encodingMatches = !verifyEncoding ||
              await verifyEncoding(rawBlob, contentEncoding);
            interpretation = {
              encodingMatches,
              lineEndings: encodingMatches
                ? classifyLineEndings(rawBlob, contentEncoding)
                : undefined,
            };
            interpretations.set(contentEncoding, interpretation);
          }
          if (!interpretation.encodingMatches || !interpretation.lineEndings) {
            results.set(target.key, {
              head: { kind: "failed" },
              historyIdentity: createHistoryIdentity(
                target,
                headCommit,
                headAttributes,
                config,
              ),
            });
            continue;
          }
          const projected = projectCheckoutLineEndings(
            interpretation.lineEndings,
            headAttributes,
            config,
            autoTextEligible,
            contentEncoding,
          );
          results.set(target.key, {
            head: projected === undefined
              ? { kind: "failed" }
              : { kind: "found", lineEndings: projected },
            historyIdentity: createHistoryIdentity(
              target,
              headCommit,
              headAttributes,
              config,
            ),
          });
        }
      },
    );
    return results;
  } catch {
    throwIfCancelled(token);
    return failedHeadResults(targets, headCommit, results);
  }
}

async function readAttributes(
  gitPath: string,
  repositoryRoot: string,
  paths: readonly string[],
  attributes: readonly string[],
  source: string | undefined,
  token: CancellationTokenLike,
): Promise<{
  readonly values: ReadonlyMap<string, GitPathAttributes>;
  readonly failed: boolean;
}> {
  if (paths.length === 0) {
    return { values: new Map(), failed: false };
  }
  const values = new Map<string, GitPathAttributes>();
  const rawPathByKey = new Map<string, string>();
  try {
    const sourceArguments = source ? [`--source=${source}`] : [];
    const uniquePaths = [...new Set(paths)];
    for (let index = 0; index < uniquePaths.length; index += ATTRIBUTE_PATH_CHUNK_SIZE) {
      throwIfCancelled(token);
      const chunk = uniquePaths.slice(index, index + ATTRIBUTE_PATH_CHUNK_SIZE);
      const output = await runGitCommand(
        gitPath,
        [
          "-C",
          repositoryRoot,
          "check-attr",
          "-z",
          "--stdin",
          ...sourceArguments,
          ...attributes,
        ],
        {
          input: Buffer.from(`${chunk.join("\0")}\0`),
          maxOutputBytes: ATTRIBUTE_OUTPUT_LIMIT,
          token,
        },
      );
      for (const [filePath, fileAttributes] of groupGitAttributes(
        parseGitAttributeOutput(output),
      )) {
        const key = gitPathComparisonKey(filePath);
        const existingPath = rawPathByKey.get(key);
        if (existingPath !== undefined && existingPath !== filePath) {
          return { values, failed: true };
        }
        rawPathByKey.set(key, filePath);
        values.set(key, fileAttributes);
      }
    }
    return { values, failed: false };
  } catch {
    throwIfCancelled(token);
    return { values, failed: true };
  }
}

async function readTreeEntries(
  gitPath: string,
  repositoryRoot: string,
  headCommit: string,
  paths: readonly string[],
  ignoreCase: boolean,
  token: CancellationTokenLike,
): Promise<readonly GitTreeEntry[]> {
  const entries: GitTreeEntry[] = [];
  const treePaths = ignoreCase
    ? await resolveCaseInsensitiveTreePaths(
      gitPath,
      repositoryRoot,
      headCommit,
      paths,
      token,
    )
    : paths;
  for (const chunk of chunkGitArguments(treePaths)) {
    const output = await runGitCommand(
      gitPath,
      [
        "--literal-pathspecs",
        "-C",
        repositoryRoot,
        "ls-tree",
        "-rz",
        "-l",
        "--full-tree",
        headCommit,
        "--",
        ...chunk,
      ],
      { maxOutputBytes: TREE_OUTPUT_LIMIT, token },
    );
    entries.push(...parseGitTreeOutput(output));
  }
  return entries;
}

async function resolveCaseInsensitiveTreePaths(
  gitPath: string,
  repositoryRoot: string,
  headCommit: string,
  paths: readonly string[],
  token: CancellationTokenLike,
): Promise<readonly string[]> {
  const canonicalByKey = new Map<string, string>();
  const pathspecPrefix = ":(top,literal,icase)";
  for (const pathspecChunk of chunkGitArguments(
    paths.map((filePath) => `${pathspecPrefix}${filePath}`),
  )) {
    const requestedPaths = pathspecChunk.map((pathspec) =>
      pathspec.slice(pathspecPrefix.length),
    );
    const output = await runGitCommand(
      gitPath,
      [
        "-C",
        repositoryRoot,
        "ls-files",
        "-z",
        `--with-tree=${headCommit}`,
        "--",
        ...pathspecChunk,
      ],
      { maxOutputBytes: TREE_OUTPUT_LIMIT, token },
    );
    const candidates = parseNullGitPaths(output);
    const candidatesByKey = new Map<string, string[]>();
    for (const candidate of candidates) {
      const key = gitPathComparisonKey(candidate, process.platform, true);
      const matches = candidatesByKey.get(key) ?? [];
      matches.push(candidate);
      candidatesByKey.set(key, matches);
    }
    for (const requestedPath of requestedPaths) {
      const key = gitPathComparisonKey(requestedPath, process.platform, true);
      const matches = [...new Set(candidatesByKey.get(key) ?? [])];
      if (matches.length === 0) {
        continue;
      }
      const exact = matches.find((candidate) => candidate === requestedPath);
      const selected = exact ?? (matches.length === 1 ? matches[0] : undefined);
      if (!selected) {
        throw new Error("Case-insensitive Git path matched multiple tree entries");
      }
      const existing = canonicalByKey.get(key);
      if (existing !== undefined && existing !== selected) {
        throw new Error("Case-insensitive Git path matched multiple requested paths");
      }
      canonicalByKey.set(key, selected);
    }
  }
  return [...canonicalByKey.values()];
}

function parseNullGitPaths(output: Uint8Array): string[] {
  const source = Buffer.from(output);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const end = source.indexOf(0, offset);
    if (end < 0) {
      throw new Error("Git path output was not null terminated");
    }
    const filePath = decoder.decode(source.subarray(offset, end));
    if (!filePath) {
      throw new Error("Git path output contained an empty path");
    }
    paths.push(filePath);
    offset = end + 1;
  }
  return paths;
}

async function visitBlobs(
  gitPath: string,
  repositoryRoot: string,
  entries: readonly { readonly objectId: string; readonly size: number }[],
  token: CancellationTokenLike,
  visit: (objectId: string, content: Buffer) => Promise<void>,
): Promise<void> {
  const uniqueEntries = [
    ...new Map(entries.map((entry) => [entry.objectId, entry])).values(),
  ];
  for (const batch of chunkBlobEntries(uniqueEntries)) {
    const objectIds = batch.map((entry) => entry.objectId);
    const expectedSize = batch.reduce((total, entry) => total + entry.size, 0);
    const output = await runGitCommand(
      gitPath,
      ["-C", repositoryRoot, "cat-file", "--batch"],
      {
        input: Buffer.from(`${objectIds.join("\n")}\n`),
        maxOutputBytes: expectedSize + objectIds.length * 128,
        token,
      },
    );
    const contents = parseGitBatchOutput(output, objectIds);
    for (const [index, objectId] of objectIds.entries()) {
      await visit(objectId, contents[index]!);
    }
  }
}

async function readCheckoutConfig(
  gitPath: string,
  repositoryRoot: string,
  token: CancellationTokenLike,
): Promise<GitCheckoutConfig> {
  const autoCrlfValue = await readOptionalConfig(
    gitPath,
    repositoryRoot,
    "core.autocrlf",
    token,
  );
  const coreEolValue = await readOptionalConfig(
    gitPath,
    repositoryRoot,
    "core.eol",
    token,
  );
  const ignoreCaseValue = await readOptionalConfig(
    gitPath,
    repositoryRoot,
    "core.ignorecase",
    token,
  );
  const autoCrlf = normalizeAutoCrlf(autoCrlfValue);
  const coreEol = (coreEolValue ?? "native").toLowerCase();
  const ignoreCase = ignoreCaseValue === undefined
    ? false
    : parseGitBoolean(ignoreCaseValue);
  const checkoutFilterDrivers = await readCheckoutFilterDrivers(
    gitPath,
    repositoryRoot,
    token,
  );
  if (autoCrlf === undefined || !isCoreEol(coreEol) || ignoreCase === undefined) {
    throw new Error("Unsupported Git line-ending configuration");
  }
  return {
    autoCrlf,
    coreEol,
    nativeEol: process.platform === "win32" ? "crlf" : "lf",
    checkoutFilterDrivers,
    ignoreCase,
  };
}

async function readCheckoutFilterDrivers(
  gitPath: string,
  repositoryRoot: string,
  token: CancellationTokenLike,
): Promise<ReadonlySet<string>> {
  const commandDrivers = await readFilterCommandDrivers(
    gitPath,
    repositoryRoot,
    token,
  );
  const requiredDrivers = await readRequiredFilterDrivers(
    gitPath,
    repositoryRoot,
    token,
  );
  return new Set([...commandDrivers, ...requiredDrivers]);
}

async function readFilterCommandDrivers(
  gitPath: string,
  repositoryRoot: string,
  token: CancellationTokenLike,
): Promise<ReadonlySet<string>> {
  try {
    const output = await runGitCommand(
      gitPath,
      [
        "-C",
        repositoryRoot,
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(smudge|process)$",
      ],
      { maxOutputBytes: 1024 * 1024, token },
    );
    const commandDrivers = output
      .toString("utf8")
      .split("\0")
      .flatMap((key) => {
        const match = /^filter\.(.*)\.(?:smudge|process)$/.exec(key);
        return match ? [match[1]!] : [];
      });
    return new Set(commandDrivers);
  } catch (error) {
    throwIfCancelled(token);
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return new Set();
    }
    throw error;
  }
}

async function readRequiredFilterDrivers(
  gitPath: string,
  repositoryRoot: string,
  token: CancellationTokenLike,
): Promise<ReadonlySet<string>> {
  try {
    const output = await runGitCommand(
      gitPath,
      [
        "-C",
        repositoryRoot,
        "config",
        "--type=bool",
        "--null",
        "--get-regexp",
        "^filter\\..*\\.required$",
      ],
      { maxOutputBytes: 1024 * 1024, token },
    );
    const drivers = output
      .toString("utf8")
      .split("\0")
      .flatMap((record) => {
        const separator = record.indexOf("\n");
        if (separator < 0 || record.slice(separator + 1) !== "true") {
          return [];
        }
        const match = /^filter\.(.*)\.required$/.exec(record.slice(0, separator));
        return match ? [match[1]!] : [];
      });
    return new Set(drivers);
  } catch (error) {
    throwIfCancelled(token);
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return new Set();
    }
    throw error;
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

function chunkBlobEntries<T extends { readonly size: number }>(
  values: readonly T[],
): readonly T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let size = 0;
  for (const value of values) {
    if (chunk.length > 0 && size + value.size > HEAD_BATCH_BYTES) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(value);
    size += value.size;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function failedHeadResults(
  targets: readonly HeadInspectionTarget[],
  headCommit: string,
  completed: ReadonlyMap<string, HeadInspectionResult> = new Map(),
): ReadonlyMap<string, HeadInspectionResult> {
  const results = new Map(completed);
  for (const target of targets) {
    if (!results.has(target.key)) {
      results.set(target.key, {
        head: { kind: "failed" },
        historyIdentity: createUnavailableHistoryIdentity(target, headCommit),
      });
    }
  }
  return results;
}

function createHistoryIdentity(
  target: HeadInspectionTarget,
  headCommit: string | undefined,
  attributes: GitPathAttributes,
  config: GitCheckoutConfig,
): string {
  return createIdentity(target, headCommit, {
    attributes,
    autoCrlf: config.autoCrlf,
    coreEol: config.coreEol,
    nativeEol: config.nativeEol,
    ignoreCase: config.ignoreCase === true,
    externalFilter: hasExternalGitFilter(attributes, config),
  });
}

function createUnavailableHistoryIdentity(
  target: HeadInspectionTarget,
  headCommit: string,
): string {
  return createIdentity(target, headCommit, { unavailable: true });
}

function createIdentity(
  target: HeadInspectionTarget,
  headCommit: string | undefined,
  policy: object,
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      version: 3,
      headPath: target.headPath,
      expectedEncoding: target.expectedEncoding,
      policy,
    }))
    .digest("hex");
  return `git:${target.historyRepositoryId}:${headCommit ?? "unborn"}:${fingerprint}`;
}

function normalizeAutoCrlf(
  value: string | undefined,
): GitCheckoutConfig["autoCrlf"] | undefined {
  const normalized = (value ?? "false").toLowerCase();
  if (normalized === "input") {
    return "input";
  }
  const boolean = parseGitBoolean(normalized);
  return boolean === undefined ? undefined : boolean ? "true" : "false";
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

function isCoreEol(value: string): value is GitCheckoutConfig["coreEol"] {
  return value === "lf" || value === "crlf" || value === "native";
}

function throwIfCancelled(token: CancellationTokenLike): void {
  if (token.isCancellationRequested) {
    throw new GitCommandCancelledError();
  }
}
