import { GitAttributeRecord } from "./gitAttributeCore.js";
import { LineEndingClassification, LineEndingKind } from "./scanCore.js";

export interface GitPathAttributes {
  readonly eol?: string;
  readonly text?: string;
  readonly crlf?: string;
  readonly workingTreeEncoding?: string;
  readonly filter?: string;
}

export interface GitCheckoutConfig {
  readonly autoCrlf: "false" | "true" | "input";
  readonly coreEol: "lf" | "crlf" | "native";
  readonly nativeEol: "lf" | "crlf";
  readonly checkoutFilterDrivers?: ReadonlySet<string>;
  readonly ignoreCase?: boolean;
}

export interface GitTreeEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly path: string;
  readonly size?: number;
}

export interface GitTreeBudgetSelection {
  readonly selected: readonly ReadableGitTreeEntry[];
  readonly rejected: readonly ReadableGitTreeEntry[];
}

type ReadableGitTreeEntry = GitTreeEntry & { readonly size: number };

export type StagedRenameParseResult =
  | {
    readonly kind: "found";
    readonly headPathByCurrentPath: ReadonlyMap<string, string>;
    readonly addedPaths: ReadonlySet<string>;
    readonly typeChangedPaths: ReadonlySet<string>;
    readonly deletionCount: number;
  }
  | { readonly kind: "failed" };

export function gitHeadBlobFitsConfiguredLimit(
  size: number,
  configuredMaxSize: number,
): boolean {
  return size <= configuredMaxSize;
}

export function groupGitAttributes(
  records: readonly GitAttributeRecord[],
): ReadonlyMap<string, GitPathAttributes> {
  const mutable = new Map<string, Record<string, string>>();
  for (const record of records) {
    const attributes = mutable.get(record.path) ?? {};
    attributes[record.attribute] = record.value;
    mutable.set(record.path, attributes);
  }
  return new Map(
    [...mutable].map(([filePath, attributes]) => [
      filePath,
      {
        eol: attributes.eol,
        text: attributes.text,
        crlf: attributes.crlf,
        workingTreeEncoding: attributes["working-tree-encoding"],
        filter: attributes.filter,
      },
    ]),
  );
}

export function parseGitTreeOutput(output: Uint8Array): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of Buffer.from(output).toString("utf8").split("\0")) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }
    const metadata = record.slice(0, separator).trim().split(/\s+/);
    const filePath = record.slice(separator + 1);
    if (
      metadata.length !== 4 ||
      !["blob", "tree", "commit"].includes(metadata[1]!) ||
      !/^[0-9a-f]{40,64}$/.test(metadata[2]!)
    ) {
      continue;
    }
    const size = /^\d+$/.test(metadata[3]!) ? Number(metadata[3]) : undefined;
    entries.push({
      mode: metadata[0]!,
      objectId: metadata[2]!,
      path: filePath,
      size: size !== undefined && Number.isSafeInteger(size) ? size : undefined,
    });
  }
  return entries;
}

export function selectGitTreeEntriesWithinBudget(
  entries: readonly ReadableGitTreeEntry[],
  maxTotalSize: number,
): GitTreeBudgetSelection {
  const selected: ReadableGitTreeEntry[] = [];
  const rejected: ReadableGitTreeEntry[] = [];
  const seen = new Set<string>();
  let remaining = maxTotalSize;
  for (const entry of entries) {
    if (seen.has(entry.objectId)) {
      continue;
    }
    seen.add(entry.objectId);
    if (entry.size <= remaining) {
      selected.push(entry);
      remaining -= entry.size;
    } else {
      rejected.push(entry);
    }
  }
  return { selected, rejected };
}

export function parseGitBatchOutput(
  output: Uint8Array,
  expectedObjectIds: readonly string[],
): readonly Buffer[] {
  const source = Buffer.isBuffer(output)
    ? output
    : Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  const contents: Buffer[] = [];
  let offset = 0;
  for (const expectedObjectId of expectedObjectIds) {
    const headerEnd = source.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      throw new Error("Git batch output ended before its header");
    }
    const header = source.subarray(offset, headerEnd).toString("ascii");
    const fields = header.split(" ");
    const size = Number(fields[2]);
    if (
      fields.length !== 3 ||
      fields[0] !== expectedObjectId ||
      fields[1] !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(`Unexpected Git batch header: ${header}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= source.length || source[contentEnd] !== 0x0a) {
      throw new Error("Git batch output ended before its content");
    }
    contents.push(source.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }
  if (offset !== source.length) {
    throw new Error("Git batch output contained trailing data");
  }
  return contents;
}

export function parseStagedNameStatusOutput(
  output: Uint8Array,
  renameCandidateLimit = 1000,
): StagedRenameParseResult {
  const source = Buffer.isBuffer(output)
    ? output
    : Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  const fields: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  try {
    while (offset < source.length) {
      const end = source.indexOf(0, offset);
      if (end < 0) {
        return { kind: "failed" };
      }
      fields.push(decoder.decode(source.subarray(offset, end)));
      offset = end + 1;
    }
  } catch {
    return { kind: "failed" };
  }

  const headPathByCurrentPath = new Map<string, string>();
  const addedPaths = new Set<string>();
  const typeChangedPaths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      return { kind: "failed" };
    }
    if (/^[RC]\d{1,3}$/.test(status)) {
      const score = Number(status.slice(1));
      if (score > 100) {
        return { kind: "failed" };
      }
      const headPath = fields[index++];
      const currentPath = fields[index++];
      if (!headPath || !currentPath) {
        return { kind: "failed" };
      }
      if (status.startsWith("R")) {
        if (headPathByCurrentPath.has(currentPath)) {
          return { kind: "failed" };
        }
        headPathByCurrentPath.set(currentPath, headPath);
      }
      continue;
    }
    if (!/^[AMDT]$/.test(status)) {
      return { kind: "failed" };
    }
    const changedPath = fields[index++];
    if (!changedPath) {
      return { kind: "failed" };
    }
    additions += status === "A" ? 1 : 0;
    deletions += status === "D" ? 1 : 0;
    if (status === "A") {
      addedPaths.add(changedPath);
    } else if (status === "T") {
      typeChangedPaths.add(changedPath);
    }
  }
  if (
    (additions > renameCandidateLimit && deletions > 0) ||
    (deletions > renameCandidateLimit && additions > 0)
  ) {
    return { kind: "failed" };
  }
  return {
    kind: "found",
    headPathByCurrentPath,
    addedPaths,
    typeChangedPaths,
    deletionCount: deletions,
  };
}

export function projectCheckoutLineEnding(
  raw: LineEndingClassification,
  attributes: GitPathAttributes,
  config: GitCheckoutConfig,
  autoTextEligible = true,
  contentEncoding = "utf8",
): LineEndingKind | undefined {
  return projectCheckoutLineEndings(
    raw,
    attributes,
    config,
    autoTextEligible,
    contentEncoding,
  )?.kind;
}

export function projectCheckoutLineEndings(
  raw: LineEndingClassification,
  attributes: GitPathAttributes,
  config: GitCheckoutConfig,
  autoTextEligible = true,
  contentEncoding = "utf8",
): LineEndingClassification | undefined {
  if (hasExternalGitFilter(attributes, config)) {
    return undefined;
  }
  const actions = checkoutActions(attributes, config);
  const projected = actions.map((action) =>
    projectCheckoutAction(raw, action, autoTextEligible, contentEncoding),
  );
  const first = projected[0];
  return first !== undefined && projected.every((value) =>
    value !== undefined &&
    value.kind === first.kind &&
    value.styles.length === first.styles.length &&
    value.styles.every((style) => first.styles.includes(style))
  )
    ? first
    : undefined;
}

function projectCheckoutAction(
  raw: LineEndingClassification,
  action: CheckoutAction,
  autoTextEligible: boolean,
  contentEncoding: string,
): LineEndingClassification | undefined {
  if (action === "none") {
    return raw;
  }
  if (action === "autoCrlf" && !autoTextEligible) {
    return raw;
  }
  if (isMultiByteLineEndingEncoding(contentEncoding)) {
    return undefined;
  }
  if (raw.kind === "none" || raw.kind === "cr") {
    return raw;
  }
  if (action === "autoCrlf" && (raw.styles.includes("cr") || raw.styles.includes("crlf"))) {
    return raw;
  }
  const styles = [...new Set(raw.styles.map((style) =>
    style === "cr" ? "cr" as const : "crlf" as const,
  ))];
  return {
    kind: styles.length === 1 ? styles[0]! : "mixed",
    styles,
  };
}

export function headBlobEncodingHint(
  expectedEncoding: string,
  attributes: GitPathAttributes,
): string | undefined {
  const configured = attributes.workingTreeEncoding;
  if (configured === undefined || configured === "unspecified" || configured.length === 0) {
    return expectedEncoding;
  }
  return configured === "set" || configured === "unset"
    ? undefined
    : "utf8";
}

export function effectiveEolRule(
  attributes: GitPathAttributes,
): "lf" | "crlf" | undefined {
  if (attributes.eol !== "lf" && attributes.eol !== "crlf") {
    return undefined;
  }
  const actions = attributeCrlfActions(attributes);
  return actions.every((action) => action !== "binary")
    ? attributes.eol
    : undefined;
}

export function hasExternalGitFilter(
  attributes: GitPathAttributes,
  config?: Pick<GitCheckoutConfig, "checkoutFilterDrivers">,
): boolean {
  const value = attributes.filter;
  if (!value) {
    return false;
  }
  if (config?.checkoutFilterDrivers) {
    return config.checkoutFilterDrivers.has(value);
  }
  // Reserved-looking values can also name a literal driver.
  return true;
}

export function gitWouldTreatAsText(bytes: Uint8Array): boolean {
  let printable = 0;
  let nonPrintable = 0;
  let loneCarriageReturn = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0) {
      return false;
    }
    if (byte === 0x0d) {
      if (bytes[index + 1] === 0x0a) {
        index += 1;
      } else {
        loneCarriageReturn = true;
      }
      continue;
    }
    if (byte === 0x0a) {
      continue;
    }
    if (index === bytes.length - 1 && byte === 0x1a) {
      continue;
    }
    if (isPrintableForGit(byte)) {
      printable += 1;
    } else {
      nonPrintable += 1;
    }
  }
  return !loneCarriageReturn && (printable >> 7) >= nonPrintable;
}

function isPrintableForGit(byte: number): boolean {
  return (
    (byte >= 0x20 && byte !== 0x7f) ||
    byte === 0x08 ||
    byte === 0x09 ||
    byte === 0x0c ||
    byte === 0x1b
  );
}

type AttributeCrlfAction = "undefined" | "binary" | "text" | "textInput" | "auto";
type CheckoutAction = "none" | "autoCrlf" | "forcedCrlf";

function checkoutActions(
  attributes: GitPathAttributes,
  config: GitCheckoutConfig,
): readonly CheckoutAction[] {
  return [...new Set(
    attributeCrlfActions(attributes).map((action) =>
      resolveCheckoutAction(action, attributes.eol, config),
    ),
  )];
}

function attributeCrlfActions(
  attributes: GitPathAttributes,
): readonly AttributeCrlfAction[] {
  const textActions = attributeValueActions(attributes.text);
  const crlfActions = attributeValueActions(attributes.crlf);
  return [...new Set(textActions.flatMap((action) =>
    action === "undefined" ? crlfActions : [action],
  ))];
}

function attributeValueActions(value: string | undefined): readonly AttributeCrlfAction[] {
  if (!value || value === "unspecified") {
    return ["undefined"];
  }
  if (value === "set") {
    return ["text", "undefined"];
  }
  if (value === "unset") {
    return ["binary", "undefined"];
  }
  if (value === "input") {
    return ["textInput"];
  }
  if (value === "auto") {
    return ["auto"];
  }
  return ["undefined"];
}

function resolveCheckoutAction(
  initial: AttributeCrlfAction,
  eol: string | undefined,
  config: GitCheckoutConfig,
): CheckoutAction {
  let action = initial;
  if (action !== "binary") {
    if (eol === "lf") {
      action = "textInput";
    } else if (eol === "crlf") {
      return action === "auto" ? "autoCrlf" : "forcedCrlf";
    }
  }
  if (action === "binary" || action === "textInput") {
    return "none";
  }
  const outputIsCrlf = textOutputIsCrlf(config);
  if (action === "text") {
    return outputIsCrlf ? "forcedCrlf" : "none";
  }
  if (action === "auto") {
    return outputIsCrlf ? "autoCrlf" : "none";
  }
  return config.autoCrlf === "true" ? "autoCrlf" : "none";
}

function textOutputIsCrlf(config: GitCheckoutConfig): boolean {
  if (config.autoCrlf === "true") {
    return true;
  }
  if (config.autoCrlf === "input") {
    return false;
  }
  const configuredEol = config.coreEol === "native" ? config.nativeEol : config.coreEol;
  return configuredEol === "crlf";
}

function isMultiByteLineEndingEncoding(encoding: string): boolean {
  const normalized = encoding.toLowerCase().replaceAll(/[-_]/g, "");
  return normalized === "utf16" || normalized === "utf16le" || normalized === "utf16be";
}
