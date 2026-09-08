import { escape, minimatch } from "minimatch";

export interface EncodingRule {
  readonly pattern: string;
  readonly encoding: string;
}

export interface MatchedRule {
  readonly rule: EncodingRule;
  readonly index: number;
}

export const ENCODINGS = [
  { id: "utf8", label: "UTF-8", badge: "U8" },
  { id: "utf8bom", label: "UTF-8 with BOM", badge: "UB" },
  { id: "shiftjis", label: "Shift JIS / CP932", badge: "SJ" },
  { id: "eucjp", label: "EUC-JP", badge: "EJ" },
  { id: "windows1252", label: "Windows-1252", badge: "W2" },
  { id: "iso88591", label: "ISO-8859-1", badge: "L1" },
  { id: "utf16le", label: "UTF-16 LE", badge: "16" },
  { id: "utf16be", label: "UTF-16 BE", badge: "16" },
] as const;

export function isSupportedEncoding(encoding: string): boolean {
  return ENCODINGS.some((candidate) => candidate.id === encoding);
}

export function isEncodingRule(value: unknown): value is EncodingRule {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.pattern === "string" &&
    candidate.pattern.length > 0 &&
    typeof candidate.encoding === "string" &&
    isSupportedEncoding(candidate.encoding)
  );
}

export function sanitizeRules(value: unknown): EncodingRule[] {
  return Array.isArray(value) ? value.filter(isEncodingRule) : [];
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function patternForFile(relativePath: string): string {
  return escape(normalizeRelativePath(relativePath)).replace(/^([!#])/, "\\$1");
}

export function patternForFolder(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.length === 0 ? "**" : `${patternForFile(normalized)}/**`;
}

// Existing entries are literal file paths. A trailing slash denotes a folder,
// not a glob, so names containing [] or * are never interpreted as patterns.
export function isMixedPathAllowed(entries: readonly string[], relativePath: string, denied: readonly string[] = []): boolean {
  return resolveMixedPathPolicy(entries, relativePath, denied)?.allowed ?? false;
}

export function resolveMixedPathPolicy(entries: readonly string[], relativePath: string, denied: readonly string[] = []): { entry: string; allowed: boolean } | undefined {
  const normalizedPath = normalizeRelativePath(relativePath);
  let result: { entry: string; allowed: boolean } | undefined;
  let specificity = -1;
  for (const [paths, allow] of [[entries, true], [denied, false]] as const) {
    for (const entry of paths) {
      const folder = entry.replaceAll("\\", "/").endsWith("/");
      const normalized = normalizeRelativePath(entry);
      const matches = folder ? normalized === "" || normalizedPath.startsWith(`${normalized}/`) || (relativePath.replaceAll("\\", "/").endsWith("/") && normalizedPath === normalized) : normalizedPath === normalized;
      if (matches && normalized.length >= specificity) {
        specificity = normalized.length;
        result = { entry, allowed: allow };
      }
    }
  }
  return result;
}

export function findMatchingRule(
  rules: readonly EncodingRule[],
  relativePath: string,
  nocase = process.platform !== "linux",
): MatchedRule | undefined {
  const normalized = normalizeRelativePath(relativePath);
  const index = rules.findIndex((rule) =>
    minimatch(normalized, rule.pattern, {
      dot: true,
      matchBase: false,
      nocase,
      windowsPathsNoEscape: false,
    }),
  );
  return index === -1 ? undefined : { rule: rules[index]!, index };
}

export function encodingInfo(encoding: string): {
  readonly id: string;
  readonly label: string;
  readonly badge: string;
} {
  return (
    ENCODINGS.find((candidate) => candidate.id === encoding) ?? {
      id: encoding,
      label: encoding,
      badge: "?",
    }
  );
}
