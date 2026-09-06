import type { EncodingClassification } from "./scanCore.js";
import { isSupportedEncoding } from "./rules.js";

export const ENCODING_BASELINE_KEY = "encodingBaseline.v1";

export interface ObservedEncodingChange {
  readonly from: string;
  readonly to: string;
  readonly expectedEncoding: string;
  readonly contentHash: string;
}

export function acknowledgedEncodingBaseline(
  change: ObservedEncodingChange,
  stored: EncodingBaseline | undefined,
  currentHash: string,
  currentRule: string | undefined,
): EncodingBaseline | undefined {
  return stored?.encoding === change.from &&
    stored.expectedEncoding === change.expectedEncoding &&
    currentRule === change.expectedEncoding && currentHash === change.contentHash &&
    isSupportedEncoding(change.to)
    ? { encoding: change.to, expectedEncoding: change.expectedEncoding }
    : undefined;
}

export interface EncodingBaseline {
  readonly encoding: string;
  readonly expectedEncoding: string;
}

// ASCII and ambiguous bytes cannot establish an encoding or prove a change.
export function planEncodingComparison(
  current: EncodingClassification,
  expectedEncoding: string,
  stored?: EncodingBaseline,
): { baseline?: EncodingBaseline; change?: { from: string; to: string } } {
  const previous = stored?.expectedEncoding === expectedEncoding ? stored : undefined;
  const detected = current.kind === "match" || current.kind === "mismatch"
    ? current.detectedEncoding
    : undefined;
  return {
    baseline: previous ?? (detected ? { encoding: detected, expectedEncoding } : undefined),
    change: previous && detected && previous.encoding !== detected
      ? { from: previous.encoding, to: detected }
      : undefined,
  };
}

export function parseEncodingBaselines(value: unknown): Map<string, EncodingBaseline> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value).flatMap(([key, entry]) => {
    if (!entry || typeof entry !== "object" ||
      typeof entry.encoding !== "string" || !isSupportedEncoding(entry.encoding) ||
      typeof entry.expectedEncoding !== "string" || !isSupportedEncoding(entry.expectedEncoding)) {
      return [];
    }
    return [[key, { encoding: entry.encoding, expectedEncoding: entry.expectedEncoding }]];
  }));
}
