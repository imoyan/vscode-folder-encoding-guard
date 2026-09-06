export function gitPathComparisonKey(
  gitPath: string,
  platform: NodeJS.Platform = process.platform,
  ignoreCase = false,
): string {
  const normalized = platform === "darwin" ? gitPath.normalize("NFC") : gitPath;
  return ignoreCase
    ? normalized.replace(/[A-Z]/g, (character) => character.toLowerCase())
    : normalized;
}
