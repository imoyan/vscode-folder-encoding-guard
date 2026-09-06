export const DEFAULT_SCAN_EXCLUDE = "**/{.git,.hg,.svn,.vscode,.idea,node_modules,.next,dist,build,.dart_tool}/**";

export const MAX_IN_MEMORY_FILE_BYTES = 32 * 1024 * 1024;

export function configuredFileSizeLimit(
  configuredKilobytes: number | undefined,
): number {
  const kilobytes = Number.isFinite(configuredKilobytes)
    ? Math.max(1, Math.floor(configuredKilobytes!))
    : 5120;
  return Math.min(kilobytes * 1024, MAX_IN_MEMORY_FILE_BYTES);
}
