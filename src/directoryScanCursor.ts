import * as path from "node:path";
import { opendir, lstat } from "node:fs/promises";
import type { Dirent } from "node:fs";

type Directory = { read(): Promise<Dirent | null>; close(): Promise<void> };
type OpenDirectory = (directory: string) => Promise<Directory>;

/** One open directory, a queue of subdirectories, and one uncommitted page.
 * Cancelling a scan leaves that page buffered for retry, without rewinding I/O. */
export class DirectoryScanCursor {
  private readonly directories: string[];
  private current: Directory | undefined;
  private currentPath = "";
  private readonly buffered: string[] = [];
  private exhausted = false;
  private closed = false;
  private active: Promise<void> | undefined;

  public constructor(
    root: string,
    private readonly skip: (entry: string, directory: boolean) => boolean,
    private readonly open: OpenDirectory = async (directory) => {
      if (!(await lstat(directory)).isDirectory()) throw Object.assign(new Error("通常のディレクトリではありません"), { code: "ENOTDIR" });
      return opendir(directory, { bufferSize: 32 });
    },
  ) { this.directories = [root]; }

  public async peek(limit: number, cancelled: () => boolean): Promise<{ paths: readonly string[]; complete: boolean }> {
    if (this.active || this.closed) throw new Error("ディレクトリの解析状態が変更されました");
    const active = this.fill(limit, cancelled);
    this.active = active;
    try { await active; }
    finally { if (this.active === active) this.active = undefined; }
    return { paths: this.buffered.slice(0, limit), complete: this.exhausted && this.buffered.length <= limit };
  }

  public commit(count: number): void { this.buffered.splice(0, count); }

  private async fill(limit: number, cancelled: () => boolean): Promise<void> {
    // Bound metadata work too, even in a tree containing only directories/exclusions.
    let entries = 0;
    while (!this.closed && !cancelled() && !this.exhausted && this.buffered.length <= limit && entries < 1000) {
      if (!this.current) {
        const directory = this.directories.pop();
        if (!directory) { this.exhausted = true; break; }
        entries++;
        try { this.current = await this.open(directory); this.currentPath = directory; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          this.directories.push(directory);
          throw error;
        }
      }
      const entry = await this.current.read();
      entries++;
      if (!entry) { await this.closeCurrent(); continue; }
      const candidate = path.join(this.currentPath, entry.name);
      if (this.skip(candidate, entry.isDirectory())) continue;
      if (entry.isDirectory()) this.directories.push(candidate);
      else if (entry.isFile() || entry.isSymbolicLink()) this.buffered.push(candidate);
    }
  }

  private async closeCurrent(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    await current?.close();
  }

  public async dispose(): Promise<void> {
    this.closed = true;
    await this.active?.catch(() => undefined);
    await this.closeCurrent();
    this.directories.length = 0;
    this.buffered.length = 0;
  }
}
