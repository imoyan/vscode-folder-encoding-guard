import * as path from "node:path";
import { createHash } from "node:crypto";
import type { RepositoryInspectionTarget } from "./gitRepositoryInspection.js";
import type { RepositoryFileInspection } from "./gitRepositoryInspection.js";
import { gitPathComparisonKey } from "./gitPath.js";

interface CancellationSignal {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export class PromiseWaitCancelledError extends Error {
  public constructor() {
    super("Promise wait cancelled");
    this.name = "PromiseWaitCancelledError";
  }
}

export function waitForPromiseUnlessCancelled<T>(
  operation: PromiseLike<T>,
  token: CancellationSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cancellation: { subscription?: { dispose(): void } } = {};
    const finish = (complete: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancellation.subscription?.dispose();
      complete();
    };
    cancellation.subscription = token.onCancellationRequested(() => {
      finish(() => reject(new PromiseWaitCancelledError()));
    });
    if (settled) {
      cancellation.subscription.dispose();
    } else if (token.isCancellationRequested) {
      finish(() => reject(new PromiseWaitCancelledError()));
    }
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export interface GitIntegrationResource {
  readonly key: string;
  readonly absolutePath: string;
  readonly expectedEncoding: string;
  readonly maxSize: number;
  readonly inspectHistory: boolean;
  readonly baselineIdentity?: string;
  readonly baselineSource?: "git" | "baseline";
  readonly baselineDetailsKnown?: boolean;
}

export interface PreparedRepositoryTarget {
  readonly resourceKey: string;
  readonly historyRequested: boolean;
  readonly target: RepositoryInspectionTarget;
}

export function prepareRepositoryTargets(
  repositoryId: string,
  repositoryRoot: string,
  resources: readonly GitIntegrationResource[],
  attributeResources: ReadonlySet<string>,
  headPathByCurrentPath: ReadonlyMap<string, string> = new Map(),
  uncertainCurrentPaths: ReadonlySet<string> = new Set(),
  ignoreCase = false,
): PreparedRepositoryTarget[] {
  return resources.map((resource) => {
    const currentPath = repositoryRelativePath(
      repositoryRoot,
      resource.absolutePath,
    );
    return {
      resourceKey: resource.key,
      historyRequested: resource.inspectHistory,
      target: {
        key: resource.key,
        currentPath,
        headPath: resource.inspectHistory
          ? (headPathByCurrentPath.get(
              gitPathComparisonKey(currentPath, process.platform, ignoreCase),
            ) ?? currentPath)
          : undefined,
        expectedEncoding: resource.expectedEncoding,
        maxSize: resource.maxSize,
        readCurrentAttributes: attributeResources.has(resource.key),
        inspectHistory: resource.inspectHistory,
        baselineIdentity: resource.baselineIdentity,
        baselineSource: resource.baselineSource,
        baselineDetailsKnown: resource.baselineDetailsKnown,
        historyRepositoryId: repositoryId,
        historyPreconditionFailed:
          resource.inspectHistory &&
          uncertainCurrentPaths.has(
            gitPathComparisonKey(currentPath, process.platform, ignoreCase),
          ),
      },
    };
  });
}

export function resolveGitHistoryIdentity(
  inspection:
    | Pick<RepositoryFileInspection, "head" | "historyIdentity">
    | undefined,
  repositoryId: string,
  expectedEncoding: string,
  headCommit?: string,
): string | undefined {
  if (inspection?.head.kind === "absent") {
    return `git-untracked:${repositoryId}:${expectedEncoding}`;
  }
  return (
    inspection?.historyIdentity ??
    (headCommit
      ? `git-unavailable:${repositoryId}:${headCommit}:${expectedEncoding}`
      : undefined)
  );
}

export function didGitHistoryLookupFail(
  historyRequested: boolean,
  inspection: Pick<RepositoryFileInspection, "head"> | undefined,
): boolean {
  return (
    historyRequested &&
    (inspection === undefined || inspection.head.kind === "failed")
  );
}

export function gitInspectionPolicyFingerprint(
  targets: readonly RepositoryInspectionTarget[],
  inspections: ReadonlyMap<string, RepositoryFileInspection>,
): string {
  const state = targets
    .map((target) => {
      const inspection = inspections.get(target.key);
      return {
        key: target.key,
        expectedLineEnding: inspection?.expectedLineEnding,
        attributeLookupFailed: inspection?.attributeLookupFailed,
        historyIdentity: inspection?.historyIdentity,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function repositoryRelativePath(
  repositoryRoot: string,
  absolutePath: string,
): string {
  return path.relative(repositoryRoot, absolutePath).replaceAll(path.sep, "/");
}
