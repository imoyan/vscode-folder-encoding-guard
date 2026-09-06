import * as vscode from "vscode";
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import {
  didGitHistoryLookupFail,
  gitInspectionPolicyFingerprint,
  prepareRepositoryTargets,
  resolveGitHistoryIdentity,
  waitForPromiseUnlessCancelled,
} from "./gitIntegrationCore.js";
import {
  createGitInspectionBudget,
  inspectGitRepository,
  readRepositoryHead,
  readStagedRenameSnapshot,
  RepositoryFileInspection,
  RepositoryInspectionTarget,
} from "./gitRepositoryInspection.js";
import {
  isExpectedEncodingForLineEndings,
  LineEndingClassification,
} from "./scanCore.js";
import { GitRepositoryLocator } from "./gitRepositoryLocator.js";

export interface GitInspectionResource {
  readonly uri: vscode.Uri;
  readonly expectedEncoding: string;
  readonly maxSize: number;
  readonly inspectHistory: boolean;
  readonly baselineIdentity?: string;
  readonly baselineSource?: "git" | "baseline";
  readonly baselineDetailsKnown?: boolean;
}

export interface GitFileInspection {
  readonly headLineEndings?: LineEndingClassification;
  readonly expectedLineEnding?: "lf" | "crlf";
  readonly attributeLookupFailed: boolean;
  readonly historyLookupFailed: boolean;
  readonly historyIdentity?: string;
}

export interface GitInspectionResult {
  readonly availability: "available" | "unavailable";
  readonly files: ReadonlyMap<string, GitFileInspection>;
  readonly headVerifications: readonly GitHeadVerification[];
}

interface GitHeadVerification {
  readonly gitPath: string;
  readonly repositoryRoot: string;
  readonly expectedCommit?: string;
  readonly stagedFingerprint?: string;
  readonly historyPreconditionFailed: boolean;
  readonly targets: readonly RepositoryInspectionTarget[];
  readonly expectedPolicyFingerprint: string;
}

interface GitApi {
  readonly git: { readonly path: string };
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

interface RepositoryGroup {
  readonly rootUri: vscode.Uri;
  readonly resources: Array<{
    readonly resource: GitInspectionResource;
    readonly absolutePath: string;
  }>;
}

export async function inspectGitFiles(
  resources: readonly GitInspectionResource[],
  attributeResources: ReadonlySet<string>,
  token: vscode.CancellationToken,
): Promise<GitInspectionResult> {
  const git = await getGitApi(token);
  if (!git) {
    return {
      availability: "unavailable",
      files: new Map(),
      headVerifications: [],
    };
  }

  const groups = await groupResourcesByRepository(git, resources, token);
  const files = new Map<string, GitFileInspection>();
  const headVerifications: GitHeadVerification[] = [];
  const inspectionBudget = createGitInspectionBudget();
  for (const group of groups.values()) {
    throwIfCancelled(token);
    const head = await readRepositoryHead(
      git.git.path,
      group.rootUri.fsPath,
      token,
    );
    const stagedRenames = head.kind === "found" &&
      group.resources.some(({ resource }) => resource.inspectHistory)
      ? await readStagedRenameSnapshot(
        git.git.path,
        group.rootUri.fsPath,
        head.commit,
        token,
      )
      : undefined;
    const prepared = prepareRepositoryTargets(
      group.rootUri.toString(),
      group.rootUri.fsPath,
      group.resources.map(({ resource, absolutePath }) => ({
        key: resource.uri.toString(),
        absolutePath,
        expectedEncoding: resource.expectedEncoding,
        maxSize: resource.maxSize,
        inspectHistory: resource.inspectHistory,
        baselineIdentity: resource.baselineIdentity,
        baselineSource: resource.baselineSource,
        baselineDetailsKnown: resource.baselineDetailsKnown,
      })),
      attributeResources,
      stagedRenames?.kind === "found"
        ? stagedRenames.headPathByCurrentPath
        : new Map(),
      stagedRenames?.kind === "found"
        ? stagedRenames.uncertainCurrentPaths
        : new Set(),
      stagedRenames?.kind === "found" ? stagedRenames.ignoreCase : false,
    );
    let repositoryInspections: ReadonlyMap<string, RepositoryFileInspection> = new Map();
    let inspectionSucceeded = false;
    if (head.kind !== "failed") {
      try {
        repositoryInspections = await inspectGitRepository(
          git.git.path,
          group.rootUri.fsPath,
          head.kind === "found" ? head.commit : undefined,
          prepared.map((entry) => entry.target),
          token,
          {
            budget: inspectionBudget,
            historyPreconditionFailed: stagedRenames?.kind === "failed",
            verifyEncoding: (bytes, encoding) =>
              isExpectedEncodingForLineEndings(
                bytes,
                encoding,
                {
                  decode: async (content, name) =>
                    vscode.workspace.decode(content, { encoding: name }),
                  encode: async (text, name) =>
                    vscode.workspace.encode(text, { encoding: name }),
                },
                () => token.isCancellationRequested,
              ),
          },
        );
        inspectionSucceeded = true;
      } catch {
        throwIfCancelled(token);
      }
    }
    const verificationTargets = prepared.map((entry) => entry.target);
    if (head.kind !== "failed" && inspectionSucceeded) {
      headVerifications.push({
        gitPath: git.git.path,
        repositoryRoot: group.rootUri.fsPath,
        expectedCommit: head.kind === "found" ? head.commit : undefined,
        stagedFingerprint: stagedRenames?.kind === "found"
          ? stagedRenames.fingerprint
          : undefined,
        historyPreconditionFailed: stagedRenames?.kind === "failed",
        targets: verificationTargets,
        expectedPolicyFingerprint: gitInspectionPolicyFingerprint(
          verificationTargets,
          repositoryInspections,
        ),
      });
    }
    for (const entry of prepared) {
      const key = entry.resourceKey;
      const inspection = repositoryInspections.get(key);
      const headReadFailed = didGitHistoryLookupFail(
        entry.historyRequested,
        inspection,
      );
      files.set(key, {
        headLineEndings:
          inspection?.head.kind === "found"
            ? inspection.head.lineEndings
            : undefined,
        expectedLineEnding: inspection?.expectedLineEnding,
        attributeLookupFailed:
          inspection?.attributeLookupFailed ?? entry.target.readCurrentAttributes,
        historyLookupFailed: headReadFailed,
        historyIdentity: entry.historyRequested ? resolveGitHistoryIdentity(
          inspection,
          entry.target.historyRepositoryId,
          entry.target.expectedEncoding,
          head.kind === "found" ? head.commit : undefined,
        ) : undefined,
      });
    }
  }
  return { availability: "available", files, headVerifications };
}

export async function verifyGitInspectionHeads(
  inspection: GitInspectionResult,
  token: vscode.CancellationToken,
): Promise<boolean> {
  for (const verification of inspection.headVerifications) {
    throwIfCancelled(token);
    const current = await readRepositoryHead(
      verification.gitPath,
      verification.repositoryRoot,
      token,
    );
    if (
      (verification.expectedCommit === undefined && current.kind !== "unborn") ||
      (verification.expectedCommit !== undefined &&
        (current.kind !== "found" || current.commit !== verification.expectedCommit))
    ) {
      return false;
    }
    if (verification.stagedFingerprint && verification.expectedCommit) {
      const staged = await readStagedRenameSnapshot(
        verification.gitPath,
        verification.repositoryRoot,
        verification.expectedCommit,
        token,
      );
      if (
        staged.kind !== "found" ||
        staged.fingerprint !== verification.stagedFingerprint
      ) {
        return false;
      }
    }
    let currentPolicy: ReadonlyMap<string, RepositoryFileInspection>;
    try {
      currentPolicy = await inspectGitRepository(
        verification.gitPath,
        verification.repositoryRoot,
        verification.expectedCommit,
        verification.targets,
        token,
        {
          historyPreconditionFailed: verification.historyPreconditionFailed,
          metadataOnly: true,
        },
      );
    } catch {
      throwIfCancelled(token);
      return false;
    }
    if (
      gitInspectionPolicyFingerprint(verification.targets, currentPolicy) !==
      verification.expectedPolicyFingerprint
    ) {
      return false;
    }
  }
  return true;
}

async function groupResourcesByRepository(
  _git: GitApi,
  resources: readonly GitInspectionResource[],
  token: vscode.CancellationToken,
): Promise<ReadonlyMap<string, RepositoryGroup>> {
  const groups = new Map<string, RepositoryGroup>();
  const locator = new GitRepositoryLocator();
  for (const resource of resources) {
    throwIfCancelled(token);
    if (resource.uri.scheme !== "file") {
      continue;
    }
    const absolutePath = await waitForPromiseUnlessCancelled(
      realpath(resource.uri.fsPath),
      token,
    ).catch(() => undefined);
    throwIfCancelled(token);
    if (!absolutePath) {
      continue;
    }
    const repositoryRoot = await waitForPromiseUnlessCancelled(
      locator.findNearestRoot(path.dirname(absolutePath)),
      token,
    );
    if (!repositoryRoot) {
      continue;
    }
    const rootUri = vscode.Uri.file(repositoryRoot);
    const key = rootUri.toString();
    const existing = groups.get(key);
    if (existing) {
      existing.resources.push({ resource, absolutePath });
    } else {
      groups.set(key, { rootUri, resources: [{ resource, absolutePath }] });
    }
  }
  return groups;
}

async function getGitApi(token: vscode.CancellationToken): Promise<GitApi | undefined> {
  try {
    throwIfCancelled(token);
    const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!extension) {
      return undefined;
    }
    const exports = extension.isActive
      ? extension.exports
      : await waitForPromiseUnlessCancelled(extension.activate(), token);
    return exports.enabled ? exports.getAPI(1) : undefined;
  } catch {
    throwIfCancelled(token);
    return undefined;
  }
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}
