import { retainGitVerifications } from "./gitPolicySnapshot.js";
import type { EncodingScanSnapshot, EncodingSummary, GitInspectionStatus } from "./scanner.js";

/** Batches contain disjoint successfully checked files; skipped files remain retryable. */
export function appendScanSnapshot(previous: EncodingScanSnapshot, next: EncodingScanSnapshot): EncodingScanSnapshot {
  const attempted = new Set(next.attemptedUris);
  const skippedFiles = [...(previous.skippedFiles ?? []).filter(({ uri }) => !attempted.has(uri.toString())), ...(next.skippedFiles ?? [])];
  const summarize = (left: readonly EncodingSummary[], right: readonly EncodingSummary[]): EncodingSummary[] => {
    const counts = new Map<string, number>();
    for (const item of [...left, ...right]) counts.set(item.encoding, (counts.get(item.encoding) ?? 0) + item.count);
    return [...counts].map(([encoding, count]) => ({ encoding, count })).sort((a, b) => b.count - a.count || a.encoding.localeCompare(b.encoding));
  };
  const statuses = new Map<string, GitInspectionStatus>();
  for (const status of [...previous.gitStatuses, ...next.gitStatuses]) {
    const key = status.folder.uri.toString();
    const old = statuses.get(key);
    const kinds = [old?.kind, status.kind];
    const kind = kinds.includes("readFailed") ? "readFailed" : kinds.includes("unavailable") ? "unavailable"
      : kinds.includes("partlyNotRepository") || (kinds.includes("notRepository") && kinds.some((value) => value && value !== "notRepository")) ? "partlyNotRepository"
      : kinds.includes("active") ? "active" : status.kind;
    statuses.set(key, { ...status, kind, matchedFileCount: status.matchedFileCount + (old?.matchedFileCount ?? 0), unmanagedFileCount: status.unmanagedFileCount + (old?.unmanagedFileCount ?? 0) });
  }
  const pageCursors = [...new Map([...(previous.pageCursors ?? []), ...(next.pageCursors ?? [])].map((cursor) => [cursor.key, cursor])).values()];
  return {
    ...next,
    pageCursors, hasMore: pageCursors.some((cursor) => !cursor.complete),
    files: [...(previous.files ?? []), ...(next.files ?? [])],
    headVerifications: retainGitVerifications([...(previous.headVerifications ?? []), ...(next.headVerifications ?? [])]),
    checkedUris: [...(previous.checkedUris ?? []), ...(next.checkedUris ?? [])],
    attemptedUris: [...new Set([...(previous.attemptedUris ?? []), ...(next.attemptedUris ?? [])])],
    scannedCount: previous.scannedCount + next.scannedCount,
    skippedCount: skippedFiles.length, skippedFiles,
    summaries: summarize(previous.summaries, next.summaries),
    lineEndingSummaries: summarize(previous.lineEndingSummaries, next.lineEndingSummaries),
    findings: [...previous.findings, ...next.findings].sort((a, b) => a.displayPath.localeCompare(b.displayPath)),
    gitStatuses: [...statuses.values()],
  };
}
