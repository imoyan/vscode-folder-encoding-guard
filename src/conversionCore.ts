export interface PreparedEncodingConversion {
  readonly text: string;
  readonly converted: Uint8Array;
}

export const MAX_CONVERSION_BACKUP_BYTES = 512 * 1024 * 1024;
export const MAX_STORED_BACKUP_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_STORED_CONVERTED_FILE_BYTES = 320 * 1024 * 1024;

export function protectedConversionSession(
  lastSession: unknown,
  protectedSession: unknown,
): string | undefined {
  return typeof lastSession === "string" &&
    lastSession.length > 0 &&
    lastSession === protectedSession
    ? lastSession
    : undefined;
}

export function conversionSelectionBackupBytes(
  sizes: readonly number[],
  maximum = MAX_CONVERSION_BACKUP_BYTES,
): number | undefined {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    return undefined;
  }
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum - total) {
      return undefined;
    }
    total += size;
  }
  return total;
}

export function validStoredConversionSizes(
  originalSize: unknown,
  convertedSize: unknown,
): boolean {
  if (originalSize === undefined && convertedSize === undefined) {
    return true;
  }
  return (
    Number.isSafeInteger(originalSize) &&
    (originalSize as number) >= 0 &&
    (originalSize as number) <= MAX_STORED_BACKUP_FILE_BYTES &&
    Number.isSafeInteger(convertedSize) &&
    (convertedSize as number) >= 0 &&
    (convertedSize as number) <= MAX_STORED_CONVERTED_FILE_BYTES
  );
}

export interface EncodingCodec {
  decode(bytes: Uint8Array, encoding: string): Promise<string>;
  encode(text: string, encoding: string): Promise<Uint8Array>;
}

export function conversionBackupReadLimit(
  originalSize: number | undefined,
  convertedSize: number | undefined,
  legacyLimit: number,
): number {
  return originalSize !== undefined && convertedSize !== undefined
    ? Math.max(originalSize, convertedSize)
    : legacyLimit;
}

export interface ConversionWriteSteps {
  readonly writeBackup: () => Promise<void>;
  readonly writeRecord: () => Promise<void>;
  readonly isCurrent: () => Promise<boolean>;
  readonly registerBackup: () => Promise<void>;
  readonly markTargetStarted?: () => Promise<void>;
  readonly writeTarget: () => Promise<void>;
  readonly markTargetCompleted?: () => Promise<void>;
  readonly recoverTarget: () => Promise<void>;
  readonly cleanupBackup: () => Promise<void>;
}

export class ConversionTargetWriteError extends Error {
  public constructor(
    cause: unknown,
    public readonly recoveryFailed: boolean,
  ) {
    super(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
    this.name = "ConversionTargetWriteError";
  }
}

export class ConversionOperationGate {
  private busy = false;

  public enter(): (() => void) | undefined {
    if (this.busy) {
      return undefined;
    }
    this.busy = true;
    return () => {
      this.busy = false;
    };
  }
}

export type ConversionBackupDisposition =
  | "keepNewAndDeletePrevious"
  | "keepNewForRecovery"
  | "restorePreviousAndDeleteNew"
  | "deleteUnusedNew";

export function conversionBackupDisposition(
  convertedCount: number,
  recoveryRequired: boolean,
  backupRegistered: boolean,
): ConversionBackupDisposition {
  if (convertedCount > 0) {
    return "keepNewAndDeletePrevious";
  }
  if (recoveryRequired) {
    return "keepNewForRecovery";
  }
  return backupRegistered
    ? "restorePreviousAndDeleteNew"
    : "deleteUnusedNew";
}

export async function writeConversionIfCurrent(
  steps: ConversionWriteSteps,
): Promise<boolean> {
  try {
    await steps.writeBackup();
    if (!(await steps.isCurrent())) {
      await steps.cleanupBackup();
      return false;
    }
    await steps.writeRecord();
    if (!(await steps.isCurrent())) {
      await steps.cleanupBackup();
      return false;
    }
    await steps.registerBackup();
  } catch (error) {
    await steps.cleanupBackup();
    throw error;
  }
  try {
    await steps.markTargetStarted?.();
    await steps.writeTarget();
    await steps.markTargetCompleted?.();
  } catch (error) {
    let recoveryFailed = false;
    try {
      await steps.recoverTarget();
      await steps.markTargetCompleted?.();
    } catch {
      // Keep the registered backup available when immediate recovery also fails.
      recoveryFailed = true;
    }
    throw new ConversionTargetWriteError(error, recoveryFailed);
  }
  return true;
}

export type ConversionSkipReason = "cancelled" | "binary" | "sourceMismatch" | "unchanged" | "targetMismatch";
export type ConversionAssessment =
  | { readonly kind: "ready"; readonly prepared: PreparedEncodingConversion }
  | { readonly kind: "skipped"; readonly reason: ConversionSkipReason; readonly error?: unknown };

export async function prepareEncodingConversion(
  original: Uint8Array,
  sourceEncoding: string,
  targetEncoding: string,
  codec: EncodingCodec,
  isCancellationRequested: () => boolean = () => false,
  targetLineEnding?: "lf" | "crlf",
): Promise<PreparedEncodingConversion | undefined> {
  const result = await assessEncodingConversion(original, sourceEncoding, targetEncoding, codec, isCancellationRequested, targetLineEnding);
  if (result.kind === "ready") return result.prepared;
  if ("error" in result) throw result.error;
  return undefined;
}

export async function assessEncodingConversion(
  original: Uint8Array,
  sourceEncoding: string,
  targetEncoding: string,
  codec: EncodingCodec,
  isCancellationRequested: () => boolean = () => false,
  targetLineEnding?: "lf" | "crlf",
): Promise<ConversionAssessment> {
  const skipped = (reason: ConversionSkipReason): ConversionAssessment => ({ kind: "skipped", reason });
  if (isCancellationRequested()) return skipped("cancelled");
  let text: string;
  try {
    text = await codec.decode(original, sourceEncoding);
    if (isCancellationRequested()) return skipped("cancelled");
    if (looksLikeBinary(text)) return skipped("binary");
    const sourceRoundTrip = await codec.encode(text, sourceEncoding);
    if (isCancellationRequested()) return skipped("cancelled");
    if (!bytesEqual(sourceRoundTrip, original)) return skipped("sourceMismatch");
  } catch (error) {
    return { kind: "skipped", reason: "sourceMismatch", error };
  }
  const targetText = targetLineEnding
    ? text.replace(/\r\n|\r|\n/g, targetLineEnding === "lf" ? "\n" : "\r\n") : text;
  try {
    const converted = await codec.encode(targetText, targetEncoding);
    if (isCancellationRequested()) return skipped("cancelled");
    if (bytesEqual(converted, original)) return skipped("unchanged");
    const targetRoundTrip = await codec.decode(converted, targetEncoding);
    if (isCancellationRequested()) return skipped("cancelled");
    return targetRoundTrip === targetText ? { kind: "ready", prepared: { text, converted } } : skipped("targetMismatch");
  } catch (error) {
    return { kind: "skipped", reason: "targetMismatch", error };
  }
}

export function looksLikeBinary(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  let controls = 0;
  const sampleLength = Math.min(text.length, 8192);
  for (let index = 0; index < sampleLength; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) {
      return true;
    }
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      controls += 1;
    }
  }
  return controls / sampleLength > 0.02;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
