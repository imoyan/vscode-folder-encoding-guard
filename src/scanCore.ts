import {
  bytesEqual,
  EncodingCodec,
  looksLikeBinary,
} from "./conversionCore.js";

export type EncodingClassificationKind =
  | "match"
  | "mismatch"
  | "ambiguous"
  | "ascii"
  | "skip";

export interface EncodingClassification {
  readonly kind: EncodingClassificationKind;
  readonly detectedEncoding?: string;
  readonly candidates?: readonly string[];
}

export interface EncodingClassificationOptions {
  readonly alternativeEncodings?: readonly string[];
  readonly isCancellationRequested?: () => boolean;
}

export class EncodingClassificationCancelledError extends Error {
  public constructor() {
    super("Encoding classification cancelled");
    this.name = "EncodingClassificationCancelledError";
  }
}

export type LineEndingKind = "lf" | "crlf" | "cr" | "mixed" | "none";
export type LineEndingStyle = Exclude<LineEndingKind, "mixed" | "none">;

export interface LineEndingClassification {
  readonly kind: LineEndingKind;
  readonly styles: readonly LineEndingStyle[];
}

export interface LineEndingSnapshot {
  readonly kind: LineEndingKind;
  readonly styles?: readonly LineEndingStyle[];
}

export interface LineEndingChange {
  readonly from: LineEndingKind;
  readonly to: LineEndingKind;
  readonly fromStyles?: readonly LineEndingStyle[];
  readonly toStyles: readonly LineEndingStyle[];
}

interface ProbeResult {
  readonly kind: "valid" | "invalid" | "binary";
}

const ASCII_COMPATIBLE_ENCODINGS = new Set([
  "utf8",
  "shiftjis",
  "eucjp",
  "windows1252",
  "iso88591",
]);

const FALLBACK_CANDIDATES = ["shiftjis", "eucjp", "utf16le", "utf16be"] as const;

export async function classifyEncoding(
  bytes: Uint8Array,
  expectedEncoding: string,
  codec: EncodingCodec,
  options: EncodingClassificationOptions = {},
): Promise<EncodingClassification> {
  const utf16Signal = detectBom(bytes) ?? detectLikelyUtf16(bytes);
  const hasEvidence = (encoding: string): boolean => !isUtf16Encoding(encoding) || encoding === utf16Signal;
  const alternativeEncodings = (options.alternativeEncodings ?? FALLBACK_CANDIDATES).filter(hasEvidence);
  const isCancellationRequested = options.isCancellationRequested ?? (() => false);
  throwIfClassificationCancelled(isCancellationRequested);
  const bomEncoding = detectBom(bytes);
  if (bomEncoding) {
    const bomLength = bomEncoding === "utf8bom" ? 3 : 2;
    const contentEncoding = bomEncoding === "utf8bom" ? "utf8" : bomEncoding;
    const bomProbe = await probeEncoding(
      bytes.subarray(bomLength),
      contentEncoding,
      codec,
      isCancellationRequested,
    );
    if (bomProbe.kind === "binary") {
      return { kind: "skip" };
    }
    if (bomProbe.kind === "valid") {
      return bomEncoding === expectedEncoding
        ? { kind: "match", detectedEncoding: bomEncoding }
        : { kind: "mismatch", detectedEncoding: bomEncoding };
    }
  }

  if (bytes.length === 0) {
    return { kind: "ascii" };
  }

  if (isAscii(bytes) && !isUtf16Encoding(expectedEncoding)) {
    if (looksLikeBinary(new TextDecoder("ascii").decode(bytes.subarray(0, 8192)))) return { kind: "skip" };
    return ASCII_COMPATIBLE_ENCODINGS.has(expectedEncoding)
      ? { kind: "ascii" }
      : { kind: "mismatch", detectedEncoding: "utf8" };
  }

  const likelyUtf16 = detectLikelyUtf16(bytes);
  if (likelyUtf16) {
    const utf16Probe = await probeEncoding(
      bytes,
      likelyUtf16,
      codec,
      isCancellationRequested,
    );
    if (utf16Probe.kind === "binary") {
      return { kind: "skip" };
    }
    if (utf16Probe.kind === "valid") {
      return likelyUtf16 === expectedEncoding
        ? { kind: "match", detectedEncoding: likelyUtf16 }
        : { kind: "mismatch", detectedEncoding: likelyUtf16 };
    }
  }

  const utf8Probe = await probeEncoding(
    bytes,
    "utf8",
    codec,
    isCancellationRequested,
  );
  const expectedProbe =
    expectedEncoding === "utf8"
      ? utf8Probe
      : await probeEncoding(bytes, expectedEncoding, codec, isCancellationRequested);

  if (utf8Probe.kind === "valid") {
    if (expectedEncoding === "utf8") {
      return { kind: "match", detectedEncoding: "utf8" };
    }
    if (expectedProbe.kind === "valid") {
      return {
        kind: "ambiguous",
        candidates: unique(["utf8", expectedEncoding]),
      };
    }
    return { kind: "mismatch", detectedEncoding: "utf8" };
  }

  if (expectedProbe.kind === "valid") {
    const alternatives = await validAlternatives(
      bytes,
      expectedEncoding,
      alternativeEncodings,
      codec,
      isCancellationRequested,
    );
    return alternatives.length === 0
      ? { kind: "match", detectedEncoding: expectedEncoding }
      : { kind: "ambiguous", candidates: [expectedEncoding, ...alternatives] };
  }
  const candidates: string[] = [];
  for (const encoding of unique([...alternativeEncodings, ...FALLBACK_CANDIDATES.filter(hasEvidence)])) {
    throwIfClassificationCancelled(isCancellationRequested);
    if (encoding === expectedEncoding) {
      continue;
    }
    const result = await probeEncoding(bytes, encoding, codec, isCancellationRequested);
    if (result.kind === "valid") {
      candidates.push(encoding);
    }
  }
  if (candidates.length === 1) {
    return { kind: "mismatch", detectedEncoding: candidates[0] };
  }
  if (candidates.length === 0 && expectedProbe.kind === "binary") {
    return { kind: "skip" };
  }
  return {
    kind: "ambiguous",
    candidates: candidates.length > 0 ? candidates : undefined,
  };
}

async function validAlternatives(
  bytes: Uint8Array,
  expectedEncoding: string,
  alternativeEncodings: readonly string[],
  codec: EncodingCodec,
  isCancellationRequested: () => boolean,
): Promise<string[]> {
  const candidates: string[] = [];
  for (const encoding of unique(alternativeEncodings)) {
    throwIfClassificationCancelled(isCancellationRequested);
    if (encoding === expectedEncoding || encoding === "utf8") {
      continue;
    }
    if (
      (await probeEncoding(
        bytes,
        encoding,
        codec,
        isCancellationRequested,
      )).kind === "valid"
    ) {
      candidates.push(encoding);
    }
  }
  return candidates;
}

export function classifyLineEndings(
  bytes: Uint8Array,
  encodingHint?: string,
): LineEndingClassification {
  const bomEncoding = detectBom(bytes);
  const utf16Encoding =
    bomEncoding === "utf16le" || bomEncoding === "utf16be"
      ? bomEncoding
      : encodingHint === "utf16le" || encodingHint === "utf16be"
        ? encodingHint
        : detectLikelyUtf16(bytes);
  const units = utf16Encoding ? utf16CodeUnits(bytes, utf16Encoding) : bytes;
  return classifyLineEndingUnits(units);
}

export function classifyTextLineEndings(text: string): LineEndingClassification {
  return classifyLineEndingUnits(text);
}

function classifyLineEndingUnits(units: ArrayLike<number> | string): LineEndingClassification {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (let index = 0; index < units.length; index += 1) {
    const current = typeof units === "string" ? units.charCodeAt(index) : units[index];
    const next = typeof units === "string" ? units.charCodeAt(index + 1) : units[index + 1];
    if (current === 0x0d && next === 0x0a) {
      crlf += 1;
      index += 1;
    } else if (current === 0x0d) {
      cr += 1;
    } else if (current === 0x0a) {
      lf += 1;
    }
  }
  const styles: Array<"lf" | "crlf" | "cr"> = [];
  if (lf > 0) {
    styles.push("lf");
  }
  if (crlf > 0) {
    styles.push("crlf");
  }
  if (cr > 0) {
    styles.push("cr");
  }
  return {
    kind: styles.length === 0 ? "none" : styles.length === 1 ? styles[0]! : "mixed",
    styles,
  };
}

export function classifyConsistentLineEndings(
  bytes: Uint8Array,
  classification: EncodingClassification,
  expectedEncoding: string,
): LineEndingClassification | undefined {
  if (classification.kind === "skip") return undefined;
  const encodings = classification.kind === "ambiguous"
    ? classification.candidates
    : [classification.detectedEncoding ?? expectedEncoding];
  if (!encodings || encodings.length === 0) {
    return undefined;
  }
  const candidates = unique(encodings).map((encoding) =>
    classifyLineEndings(bytes, encoding),
  );
  const first = candidates[0];
  return first && candidates.every((candidate) =>
    candidate.kind === first.kind &&
    candidate.styles.length === first.styles.length &&
    candidate.styles.every((style, index) => style === first.styles[index]),
  )
    ? first
    : undefined;
}

export async function isExpectedEncodingForLineEndings(
  bytes: Uint8Array,
  expectedEncoding: string,
  codec: EncodingCodec,
  isCancellationRequested: () => boolean = () => false,
): Promise<boolean> {
  const normalized = expectedEncoding.toLowerCase().replaceAll("-", "");
  if (normalized !== "utf16le" && normalized !== "utf16be") {
    return true;
  }
  const classification = await classifyEncoding(bytes, expectedEncoding, codec, {
    alternativeEncodings: [],
    isCancellationRequested,
  });
  return (
    classification.kind === "match" ||
    classification.kind === "ascii" ||
    (classification.kind === "ambiguous" &&
      classifyConsistentLineEndings(bytes, classification, expectedEncoding) !== undefined)
  );
}

export function detectLineEndingChange(
  previous: LineEndingSnapshot | undefined,
  current: LineEndingClassification,
): LineEndingChange | undefined {
  if (!previous) {
    return undefined;
  }
  const changed = previous.kind !== current.kind || (
    previous.styles !== undefined &&
    !sameLineEndingStyles(previous.styles, current.styles)
  );
  return changed
    ? {
      from: previous.kind,
      to: current.kind,
      fromStyles: previous.styles,
      toStyles: current.styles,
    }
    : undefined;
}

function sameLineEndingStyles(
  left: readonly LineEndingStyle[],
  right: readonly LineEndingStyle[],
): boolean {
  return left.length === right.length && left.every((style) => right.includes(style));
}

async function probeEncoding(
  bytes: Uint8Array,
  encoding: string,
  codec: EncodingCodec,
  isCancellationRequested: () => boolean,
): Promise<ProbeResult> {
  throwIfClassificationCancelled(isCancellationRequested);
  let text: string;
  try {
    text = await codec.decode(bytes, encoding);
  } catch {
    throwIfClassificationCancelled(isCancellationRequested);
    return { kind: "invalid" };
  }
  throwIfClassificationCancelled(isCancellationRequested);
  if (looksLikeBinary(text)) {
    return { kind: "binary" };
  }
  let roundTrip: Uint8Array;
  try {
    roundTrip = await codec.encode(text, encoding);
  } catch {
    throwIfClassificationCancelled(isCancellationRequested);
    return { kind: "invalid" };
  }
  throwIfClassificationCancelled(isCancellationRequested);
  return bytesEqual(bytes, roundTrip)
    ? { kind: "valid" }
    : { kind: "invalid" };
}

function throwIfClassificationCancelled(
  isCancellationRequested: () => boolean,
): void {
  if (isCancellationRequested()) {
    throw new EncodingClassificationCancelledError();
  }
}

function detectBom(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf8bom";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf16le";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf16be";
  }
  return undefined;
}

function isAscii(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte > 0 && byte < 0x80);
}

function detectLikelyUtf16(bytes: Uint8Array): "utf16le" | "utf16be" | undefined {
  const pairCount = Math.floor(Math.min(bytes.length, 8192) / 2);
  if (pairCount < 2) {
    return undefined;
  }
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < pairCount * 2; index += 2) {
    if (bytes[index] === 0) {
      evenZeros += 1;
    }
    if (bytes[index + 1] === 0) {
      oddZeros += 1;
    }
  }
  const evenRatio = evenZeros / pairCount;
  const oddRatio = oddZeros / pairCount;
  if (oddRatio >= 0.3 && evenRatio <= 0.1) {
    return "utf16le";
  }
  if (evenRatio >= 0.3 && oddRatio <= 0.1) {
    return "utf16be";
  }
  return undefined;
}

function isUtf16Encoding(encoding: string): boolean {
  const normalized = encoding.toLowerCase().replaceAll(/[-_]/g, "");
  return normalized === "utf16" || normalized === "utf16le" || normalized === "utf16be";
}

function utf16CodeUnits(
  bytes: Uint8Array,
  encoding: "utf16le" | "utf16be",
): Uint16Array {
  const offset = detectBom(bytes) === encoding ? 2 : 0;
  const length = Math.floor((bytes.length - offset) / 2);
  const units = new Uint16Array(length);
  for (let index = 0; index < length; index += 1) {
    const first = bytes[offset + index * 2]!;
    const second = bytes[offset + index * 2 + 1]!;
    units[index] = encoding === "utf16le" ? first | (second << 8) : (first << 8) | second;
  }
  return units;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
