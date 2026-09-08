import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { readStableLocalFile } from "./boundedFileRead.js";
import { runGitCommand, type CancellationTokenLike } from "./gitProcess.js";
import type { GitHeadVerification } from "./gitIntegration.js";

export interface GitPolicySnapshot {
  readonly configuration: string;
  readonly files: ReadonlyMap<string, string>;
}

/** Observe policy inputs, not every previously inspected file. Missing attribute
 * files are dependencies too: creating one must invalidate the retained result. */
export async function readGitPolicySnapshot(
  gitPath: string, root: string, currentPaths: readonly string[], token: CancellationTokenLike,
  previousFiles: Iterable<string> = [],
): Promise<GitPolicySnapshot | undefined> {
  try {
    const command = (args: string[]) => runGitCommand(gitPath, ["-C", root, ...args], { token, maxOutputBytes: 4 * 1024 * 1024 });
    const config = await command(["config", "--null", "--list"]);
    const indexAttributes = await command(["ls-files", "--stage", "-z", "--", ".gitattributes", ":(glob)**/.gitattributes"]);
    const files = new Set(previousFiles);
    for (const args of [["var", "GIT_ATTR_GLOBAL"], ["var", "GIT_ATTR_SYSTEM"], ["rev-parse", "--git-path", "info/attributes"]]) {
      const name = (await command(args)).toString("utf8").replace(/\r?\n$/, "");
      if (name) files.add(path.resolve(root, name));
    }
    for (const name of currentPaths) {
      let directory = path.dirname(path.resolve(root, name));
      while (directory === root || directory.startsWith(root + path.sep)) {
        files.add(path.join(directory, ".gitattributes"));
        if (directory === root) break;
        directory = path.dirname(directory);
      }
    }
    const fingerprints = new Map<string, string>();
    for (const file of files) {
      if (token.isCancellationRequested) return undefined;
      try { await lstat(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { fingerprints.set(file, "missing"); continue; }
        return undefined;
      }
      const content = await readStableLocalFile(file, 4 * 1024 * 1024, () => token.isCancellationRequested);
      if (!content) return undefined;
      fingerprints.set(file, content.contentHash);
    }
    return { configuration: createHash("sha256").update(config).update(indexAttributes).digest("hex"), files: fingerprints };
  } catch { return undefined; }
}

export function sameGitPolicySnapshot(left: GitPolicySnapshot, right: GitPolicySnapshot): boolean {
  return left.configuration === right.configuration && left.files.size === right.files.size &&
    [...left.files].every(([file, hash]) => right.files.get(file) === hash);
}

/** Incompatible observations stay separate and fail verification; never overwrite
 * an older baseline merely because a newer page observed different policy. */
export function retainGitVerifications(items: readonly GitHeadVerification[]): GitHeadVerification[] {
  const retained = new Map<string, GitHeadVerification>();
  const fallback: GitHeadVerification[] = [];
  for (const item of items) {
    if (!item.policyInputs) { fallback.push(item); continue; }
    const key = JSON.stringify([item.gitPath, item.repositoryRoot, item.expectedCommit, item.stagedFingerprint, item.historyPreconditionFailed, item.policyInputs.configuration]);
    const old = retained.get(key);
    if (old?.policyInputs && [...item.policyInputs.files].some(([file, hash]) => old.policyInputs!.files.has(file) && old.policyInputs!.files.get(file) !== hash)) {
      fallback.push({ ...item, targets: [] });
      continue;
    }
    retained.set(key, { ...item, targets: [], policyInputs: { configuration: item.policyInputs.configuration, files: new Map([...(old?.policyInputs?.files ?? []), ...item.policyInputs.files]) } });
  }
  return [...retained.values(), ...fallback];
}
