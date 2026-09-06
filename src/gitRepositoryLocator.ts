import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";

export class GitRepositoryLocator {
  private readonly rootsByDirectory = new Map<string, string | undefined>();

  /** Call before a new inspection when repository markers may have changed. */
  public clear(): void { this.rootsByDirectory.clear(); }

  public async findNearestRoot(startDirectory: string): Promise<string | undefined> {
    const visited: string[] = [];
    let directory: string;
    try { directory = await realpath(startDirectory); } catch { return undefined; }
    while (true) {
      if (this.rootsByDirectory.has(directory)) {
        return this.remember(visited, this.rootsByDirectory.get(directory));
      }
      if (await hasGitMarker(directory)) {
        this.rootsByDirectory.set(directory, directory);
        return this.remember(visited, directory);
      }
      visited.push(directory);
      const parent = path.dirname(directory);
      if (parent === directory) {
        return this.remember(visited, undefined);
      }
      directory = parent;
    }
  }

  private remember(
    directories: readonly string[],
    root: string | undefined,
  ): string | undefined {
    for (const directory of directories) {
      this.rootsByDirectory.set(directory, root);
    }
    return root;
  }
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    const marker = await lstat(path.join(directory, ".git"));
    return marker.isDirectory() || marker.isFile() || marker.isSymbolicLink();
  } catch {
    return false;
  }
}
