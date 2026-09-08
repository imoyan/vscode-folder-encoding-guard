import { DirectoryScanCursor } from "./directoryScanCursor.js";
import { Minimatch } from "minimatch";
import { scopeContains, type ScanScope } from "./scanScope.js";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  classifyEncoding,
  classifyConsistentLineEndings,
  detectLineEndingChange,
  EncodingClassificationKind,
  LineEndingChange,
  LineEndingKind,
} from "./scanCore.js";
import {
  GitInspectionResult,
  inspectGitFiles,
  verifyGitInspectionHeads,
} from "./gitIntegration.js";
import {
  LINE_ENDING_BASELINE_KEY,
  LineEndingBaseline,
  isPortableLocalBaseline,
  isUntrackedGitBaselineIdentity,
  parseLegacyLineEndingBaselines,
  parseLineEndingBaselines,
  planLineEndingComparison,
} from "./lineEndingBaseline.js";
import {
  readStableResource,
  resourceStillMatchesRead,
} from "./stableResourceRead.js";
import { ENCODINGS } from "./rules.js";
import { DEFAULT_SCAN_EXCLUDE, configuredFileSizeLimit } from "./fileLimits.js";
import { ENCODING_BASELINE_KEY, type ObservedEncodingChange, parseEncodingBaselines, planEncodingComparison } from "./encodingBaseline.js";
import { hashBytes } from "./conversionResources.js";

export interface EncodingIssue {
  readonly kind: Extract<EncodingClassificationKind, "mismatch" | "ambiguous">;
  readonly expectedEncoding?: string;
  readonly detectedEncoding?: string;
  readonly candidates?: readonly string[];
}

export interface ScanFinding {
  readonly localLineEndingChange?: { readonly baseline: LineEndingBaseline; readonly current: LineEndingBaseline; readonly contentHash: string; readonly expectedEncoding: string };
  readonly encodingChange?: ObservedEncodingChange;
  readonly uri: vscode.Uri;
  readonly displayPath: string;
  readonly encodingIssue?: EncodingIssue;
  readonly mixedLineEndings?: readonly Exclude<
    LineEndingKind,
    "mixed" | "none"
  >[];
  readonly lineEndingChange?: LineEndingChange;
  readonly lineEndingChangeSource?: "git" | "baseline";
  readonly expectedLineEnding?: "lf" | "crlf";
  readonly actualLineEnding?: LineEndingKind;
}

export interface EncodingSummary {
  readonly encoding: string;
  readonly count: number;
}

export interface ScanPageCursor {
  readonly key: string;
  readonly reader?: DirectoryScanCursor;
  readonly complete: boolean;
}

export interface ScannedFile {
  readonly uri: vscode.Uri;
  readonly displayPath: string;
  readonly encoding: string;
  readonly lineEnding: string;
}

export interface EncodingScanSnapshot {
  readonly pageCursors?: readonly ScanPageCursor[];
  readonly hasMore?: boolean;
  readonly files?: readonly ScannedFile[];
  readonly headVerifications?: GitInspectionResult["headVerifications"];
  readonly checkedUris?: readonly string[];
  readonly attemptedUris?: readonly string[];
  readonly unreadableDirectories?: readonly string[];
  readonly completedAt: Date;
  readonly scopeLabel?: string;
  readonly scannedCount: number;
  readonly skippedCount: number;
  readonly skippedFiles?: readonly { uri: vscode.Uri; displayPath: string; reason: string; directory?: boolean }[];
  readonly summaries: readonly EncodingSummary[];
  readonly lineEndingSummaries: readonly EncodingSummary[];
  readonly findings: readonly ScanFinding[];
  readonly gitStatuses: readonly GitInspectionStatus[];
}

export interface GitInspectionStatus {
  readonly folder: vscode.WorkspaceFolder;
  readonly kind:
    | "active"
    | "noEolRules"
    | "disabled"
    | "unavailable"
    | "notRepository"
    | "partlyNotRepository"
    | "readFailed";
  readonly matchedFileCount: number;
  readonly unmanagedFileCount: number;
}

interface ScanResource {
  readonly uri: vscode.Uri;
  readonly folder: vscode.WorkspaceFolder;
  readonly maxSize: number;
}

interface PreparedScanResource extends ScanResource {
  readonly expectedEncoding: string;
  readonly hasRule: boolean;
}

export class WorkspaceEncodingScanner {
  private readonly readers = new Set<DirectoryScanCursor>();

  public dispose(): void {
    for (const reader of this.readers) void reader.dispose().catch(() => undefined);
    this.readers.clear();
  }

  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly expectedEncodingFor: (
      uri: vscode.Uri,
    ) => string | undefined,
    private readonly configurationFor: (
      scope: vscode.ConfigurationScope,
    ) => vscode.WorkspaceConfiguration,
    private readonly patternsFor: (
      folder: vscode.WorkspaceFolder,
    ) => readonly string[],
    private readonly candidateEncodings: () => readonly string[],
    private readonly isMixedLineEndingAllowed: (uri: vscode.Uri) => boolean,
  ) {}

  public async scan(
    isCurrent: () => boolean = () => true,
    cancellationToken?: vscode.CancellationToken,
    onUserCancellation: () => void = () => undefined,
    scope?: ScanScope,
    alreadyChecked: ReadonlySet<string> = new Set(),
    previousPage?: EncodingScanSnapshot,
  ): Promise<EncodingScanSnapshot | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => !scope || scope.targets.some(({ uri }) => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString()) || scopeContains(scope, folder.uri)).sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length);
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(
        "文字コードを確認するワークスペースを開いてください。",
      );
      return undefined;
    }
    const createdReaders = new Set<DirectoryScanCursor>();
    let committed = false;
    const linkedCancellation = new vscode.CancellationTokenSource();
    const externalCancellation = cancellationToken?.onCancellationRequested(
      () => {
        linkedCancellation.cancel();
      },
    );
    if (cancellationToken?.isCancellationRequested) {
      linkedCancellation.cancel();
    }
    let progressCancellation: vscode.Disposable | undefined;
    try {
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "文字コード・改行をスキャン中",
          cancellable: true,
        },
        async (progress, progressToken) => {
          progressCancellation = progressToken.onCancellationRequested(() => {
            onUserCancellation();
            linkedCancellation.cancel();
          });
          if (progressToken.isCancellationRequested) {
            onUserCancellation();
            linkedCancellation.cancel();
          }
          const token = linkedCancellation.token;
          if (!isCurrent()) {
            return undefined;
          }
          const alternativeEncodings = this.candidateEncodings();
          const unconfiguredCandidates = ENCODINGS.map((encoding) => encoding.id);
          const resources: ScanResource[] = [];
          const attemptedDirectories = new Set<string>();
          const unreadableResources: ScanResource[] = [];
          const unreadableDirectories = new Set(previousPage?.unreadableDirectories);
          const seen = new Set<string>();
          const cursors = new Map<string, ScanPageCursor>();
          const commits: Array<{ reader: DirectoryScanCursor; count: number }> = [];
          const previousCursors = new Map(previousPage?.pageCursors?.map((cursor) => [cursor.key, cursor]));
          // Bound candidate work across all roots, including candidates without matching rules.
          let remaining = Math.min(100, ...folders.map((folder) => {
            const value = this.configurationFor(folder.uri).get<number>("maxScanFiles", 5000);
            return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 100;
          }));
          for (const folder of folders) {
            const rules = this.patternsFor(folder);
            const targets = scope?.targets.flatMap((target) => {
              if (vscode.workspace.getWorkspaceFolder(target.uri)?.uri.toString() === folder.uri.toString()) return [target];
              return target.directory && scopeContains({ label: scope.label, targets: [target] }, folder.uri)
                ? [{ ...target, uri: folder.uri }] : [];
            }) ?? [{ uri: folder.uri, directory: true, rulesOnly: true }];
            const config = this.configurationFor(folder.uri);
            const maxSize = configuredFileSizeLimit(config.get<number>("maxFileSizeKB", 5120));
            const exclude = config.get<string>("conversionExclude", DEFAULT_SCAN_EXCLUDE);
            for (const target of targets) {
              if (token.isCancellationRequested || !isCurrent()) return undefined;
              const key = JSON.stringify([folder.uri.toString(), target.uri.toString(), !!target.rulesOnly]);
              if (cursors.has(key)) continue;
              const previous = previousCursors.get(key);
              if (previous?.complete) { cursors.set(key, previous); continue; }
              if (remaining === 0) {
                cursors.set(key, previous ?? { key, complete: false });
                continue;
              }
              progress.report({ message: "候補を検索中（今回は最大100件）" });
              let reader = previous?.reader;
              let page: readonly vscode.Uri[];
              let complete: boolean;
              if (target.directory) {
                if (!reader) {
                  const matcher = new Minimatch(exclude, { dot: true });
                  reader = new DirectoryScanCursor(target.uri.fsPath, (candidate, directory) => {
                    const relative = path.relative(folder.uri.fsPath, candidate).replaceAll(path.sep, "/");
                    return matcher.match(relative) || (directory && matcher.match(`${relative}/`)) ||
                      (directory && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(candidate))?.uri.toString() !== folder.uri.toString());
                  });
                  this.readers.add(reader);
                  createdReaders.add(reader);
                }
                const result = await reader.peek(remaining, () => token.isCancellationRequested || !isCurrent());
                for (const directory of result.attemptedDirectories) attemptedDirectories.add(vscode.Uri.file(directory).toString());
                for (const directory of result.unreadable) {
                  const uri = vscode.Uri.file(directory);
                  unreadableResources.push({ uri, folder, maxSize });
                  unreadableDirectories.add(uri.toString());
                }
                page = result.paths.map((entry) => vscode.Uri.file(entry));
                complete = result.complete;
                commits.push({ reader, count: page.length });
              } else { page = [target.uri]; complete = true; }
              if (token.isCancellationRequested || !isCurrent()) return undefined;
              remaining -= page.length;
              for (const uri of page) {
                const uriKey = uri.toString();
                const owner = vscode.workspace.getWorkspaceFolder(uri);
                if (!owner || owner.uri.toString() !== folder.uri.toString() || seen.has(uriKey) || alreadyChecked.has(uriKey)) continue;
                if (target.rulesOnly && rules.length > 0 && this.expectedEncodingFor(uri) === undefined) continue;
                seen.add(uriKey);
                resources.push({ uri, folder, maxSize });
              }
              cursors.set(key, { key, reader, complete });
            }
          }
          const pageCursors = [...cursors.values()];
          const hasMore = pageCursors.some((cursor) => !cursor.complete);
          const previousBaselineState = this.workspaceState.get<unknown>(
            LINE_ENDING_BASELINE_KEY,
          );
          const previousEncodingState = this.workspaceState.get<unknown>(ENCODING_BASELINE_KEY);
          const previousEncodings = parseEncodingBaselines(previousEncodingState);
          const previousLegacyBaselineState = this.workspaceState.get<unknown>(
            LEGACY_LINE_ENDING_BASELINE_KEY,
          );
          const previousLineEndings = readLineEndingBaseline(
            previousBaselineState,
            previousLegacyBaselineState,
          );
          const missingKeys = new Set<string>();
          const preparedResources: PreparedScanResource[] = [];
          const scanResources: PreparedScanResource[] = [];
          const skippedFiles: { uri: vscode.Uri; displayPath: string; reason: string; directory?: boolean }[] = [];
          const skip = (resource: ScanResource, reason: string, directory = false): void => {
            skippedFiles.push({ uri: resource.uri, displayPath: scanDisplayPath(resource), reason, directory });
          };
          for (const resource of unreadableResources) skip(resource, "フォルダーを読み取れません（配下は未確認）", true);
          for (const resource of resources) {
            if (token.isCancellationRequested || !isCurrent()) {
              return undefined;
            }
            const ruleEncoding = this.expectedEncodingFor(resource.uri);
            // UTF-8 is a probe hint, never an implicit rule for unconfigured files.
            const prepared = { ...resource, expectedEncoding: ruleEncoding ?? "utf8", hasRule: ruleEncoding !== undefined };
            preparedResources.push(prepared);
            try {
              const stat = await vscode.workspace.fs.stat(resource.uri);
              if (stat.type !== vscode.FileType.File) {
                skip(resource, "通常ファイルではありません");
                continue;
              }
              if (isDirty(resource.uri)) {
                skip(resource, "未保存の変更があります");
                continue;
              }
              if (stat.size > resource.maxSize) {
                skip(resource, "サイズ上限超過");
                continue;
              }
              scanResources.push(prepared);
            } catch (error) {
              const code = (error as { code?: string }).code;
              if (code === "ENOENT" || code === "FileNotFound") missingKeys.add(resource.uri.toString());
              skip(resource, missingKeys.has(resource.uri.toString()) ? "ファイルがありません" : "ファイル情報を読み取れません");
            }
          }
          const comparisonResources = preparedResources.filter((resource) => resource.hasRule && !missingKeys.has(resource.uri.toString()));
          const resourceKeys = new Set(
            comparisonResources.map((resource) => resource.uri.toString()),
          );
          const priorResources = new Set(previousPage?.attemptedUris);
          const unreadableScope: ScanScope = { label: "", targets: [...unreadableDirectories].map(directory => ({ uri: vscode.Uri.parse(directory), directory: true })) };
          const retainBaseline = (key: string): boolean => {
            if (missingKeys.has(key)) return false;
            try {
              if (scopeContains(unreadableScope, vscode.Uri.parse(key))) return true;
            } catch { /* Preserve the existing handling of malformed baseline keys below. */ }
            if (hasMore || resourceKeys.has(key) || alreadyChecked.has(key) || priorResources.has(key)) return true;
            if (!scope) return false;
            try { return !scopeContains(scope, vscode.Uri.parse(key)); }
            catch { return false; }
          };
          const nextLineEndings = new Map(
            [...previousLineEndings].filter(([key]) => retainBaseline(key)),
          );
          const nextEncodings = new Map(
            [...previousEncodings].filter(([key]) => retainBaseline(key)),
          );
          const scanResourceKeys = new Set(
            scanResources.map((resource) => resource.uri.toString()),
          );
          const attributeResources = new Set(
            preparedResources
              .filter((resource) =>
                this.configurationFor(resource.folder.uri).get(
                  "useGitAttributes",
                  true,
                ),
              )
              .map((resource) => resource.uri.toString()),
          );
          let gitInspection: GitInspectionResult;
          try {
            gitInspection = await inspectGitFiles(
              comparisonResources.map((resource) => {
                const baseline = previousLineEndings.get(
                  resource.uri.toString(),
                );
                return {
                  uri: resource.uri,
                  expectedEncoding: resource.expectedEncoding,
                  maxSize: resource.maxSize,
                  inspectHistory: scanResourceKeys.has(resource.uri.toString()),
                  baselineIdentity: baseline?.identity,
                  baselineSource: baseline?.source,
                  baselineDetailsKnown: baseline
                    ? baseline.kind !== "mixed" || baseline.styles !== undefined
                    : undefined,
                };
              }),
              attributeResources,
              token,
            );
          } catch (error) {
            if (token.isCancellationRequested || !isCurrent()) {
              return undefined;
            }
            throw error;
          }
          const summaryCounts = new Map<string, number>();
          const lineEndingCounts = new Map<string, number>();
          const findings: ScanFinding[] = [];
          let scannedCount = 0;
          const checkedUris: string[] = [];
          const files: ScannedFile[] = [];

          for (const [index, resource] of scanResources.entries()) {
            if (token.isCancellationRequested || !isCurrent()) {
              return undefined;
            }
            progress.report({
              increment:
                scanResources.length === 0 ? 100 : 100 / scanResources.length,
              message: `${index + 1}/${scanResources.length}`,
            });
            try {
              const read = await readStableResource(
                resource.uri,
                resource.maxSize,
                () => isDirty(resource.uri),
                () => token.isCancellationRequested || !isCurrent(),
              );
              if (!read) {
                skip(resource, "変更中・読み取り不可");
                continue;
              }
              const classification = await classifyEncoding(
                read.bytes,
                resource.expectedEncoding,
                {
                  decode: async (content, encoding) =>
                    vscode.workspace.decode(content, { encoding }),
                  encode: async (text, encoding) =>
                    vscode.workspace.encode(text, { encoding }),
                },
                {
                  alternativeEncodings: resource.hasRule ? alternativeEncodings : unconfiguredCandidates,
                  isCancellationRequested: () =>
                    token.isCancellationRequested || !isCurrent(),
                },
              );
              if (
                !(await resourceStillMatchesRead(
                  resource.uri,
                  resource.maxSize,
                  read,
                  () => isDirty(resource.uri),
                ))
              ) {
                skip(resource, "検査中にファイルが変更されました");
                continue;
              }
              if (classification.kind === "skip") {
                skip(resource, "バイナリなど検査対象外");
                continue;
              }

              scannedCount += 1;
              checkedUris.push(resource.uri.toString());
              const summaryEncoding =
                classification.kind === "ascii"
                  ? "ascii"
                  : classification.kind === "ambiguous"
                    ? "unknown"
                    : (classification.detectedEncoding ??
                      resource.expectedEncoding);
              summaryCounts.set(
                summaryEncoding,
                (summaryCounts.get(summaryEncoding) ?? 0) + 1,
              );

              const lineEndings = classifyConsistentLineEndings(
                read.bytes,
                classification,
                resource.expectedEncoding,
              );
              const displayPath = scanDisplayPath(resource);
              files.push({ uri: resource.uri, displayPath, encoding: summaryEncoding, lineEnding: lineEndings?.kind ?? "unknown" });
              const resourceKey = resource.uri.toString();
              const encodingComparison = resource.hasRule ? planEncodingComparison(
                classification, resource.expectedEncoding, previousEncodings.get(resourceKey),
              ) : {};
              if (encodingComparison.baseline) nextEncodings.set(resourceKey, encodingComparison.baseline);
              else nextEncodings.delete(resourceKey);
              const fileGitInspection = gitInspection.files.get(resourceKey);
              const historyIdentity = fileGitInspection
                ? fileGitInspection.historyIdentity
                : gitInspection.availability === "available"
                  ? `non-git:${resource.expectedEncoding}`
                  : undefined;
              const nonGitFallbackIdentity = `unavailable:${resource.expectedEncoding}`;
              const storedBaseline = previousLineEndings.get(resourceKey);
              const canCarryLocalBaseline =
                (fileGitInspection === undefined ||
                  isUntrackedGitBaselineIdentity(
                    historyIdentity,
                    resource.expectedEncoding,
                  )) &&
                isPortableLocalBaseline(
                  storedBaseline,
                  resource.expectedEncoding,
                );
              const compatibleStoredIdentities = [
                ...(canCarryLocalBaseline && storedBaseline
                  ? [storedBaseline.identity]
                  : []),
              ];
              const comparisonPlan = lineEndings && resource.hasRule
                ? planLineEndingComparison({
                    current: lineEndings,
                    head: fileGitInspection?.headLineEndings,
                    historyIdentity,
                    historyUnavailable: fileGitInspection
                      ? fileGitInspection.historyLookupFailed
                      : gitInspection.availability === "unavailable",
                    fallbackIdentity: nonGitFallbackIdentity,
                    compatibleStoredIdentities,
                    stored: storedBaseline,
                  })
                : undefined;
              if (comparisonPlan?.nextBaseline) {
                nextLineEndings.set(resourceKey, comparisonPlan.nextBaseline);
              }
              if (lineEndings) {
                lineEndingCounts.set(
                  lineEndings.kind,
                  (lineEndingCounts.get(lineEndings.kind) ?? 0) + 1,
                );
              }

              const hasEncodingIssue =
                classification.kind === "ambiguous" ||
                (resource.hasRule && classification.kind === "mismatch");
              const lineEndingChange =
                lineEndings && comparisonPlan
                  ? detectLineEndingChange(
                      comparisonPlan.reference.previous,
                      lineEndings,
                    )
                  : undefined;
              const expectedLineEnding = fileGitInspection?.expectedLineEnding;
              const lineEndingRuleMismatch =
                expectedLineEnding !== undefined &&
                lineEndings !== undefined &&
                lineEndings.kind !== "none" &&
                lineEndings.kind !== expectedLineEnding;
              const mixedLineEndings =
                lineEndings?.kind === "mixed" &&
                !this.isMixedLineEndingAllowed(resource.uri)
                  ? lineEndings.styles
                  : undefined;
              if (
                hasEncodingIssue ||
                encodingComparison.change ||
                mixedLineEndings ||
                lineEndingChange ||
                lineEndingRuleMismatch
              ) {
                findings.push({
                  localLineEndingChange: lineEndingChange && lineEndings && comparisonPlan?.nextBaseline?.source === "baseline"
                    ? { baseline: comparisonPlan.nextBaseline,
                        current: { ...comparisonPlan.nextBaseline, kind: lineEndings.kind, styles: lineEndings.styles },
                        contentHash: hashBytes(read.bytes), expectedEncoding: resource.expectedEncoding } : undefined,
                  encodingChange: encodingComparison.change ? {
                    ...encodingComparison.change,
                    expectedEncoding: resource.expectedEncoding,
                    contentHash: hashBytes(read.bytes),
                  } : undefined,
                  uri: resource.uri,
                  displayPath,
                  encodingIssue: hasEncodingIssue
                    ? {
                        expectedEncoding: resource.hasRule ? resource.expectedEncoding : undefined,
                        detectedEncoding: classification.detectedEncoding,
                        candidates: classification.candidates,
                        kind: classification.kind,
                      }
                    : undefined,
                  mixedLineEndings,
                  lineEndingChange,
                  lineEndingChangeSource: lineEndingChange
                    ? comparisonPlan?.reference.source
                    : undefined,
                  expectedLineEnding: lineEndingRuleMismatch
                    ? expectedLineEnding
                    : undefined,
                  actualLineEnding: lineEndingRuleMismatch
                    ? lineEndings?.kind
                    : undefined,
                });
              }
            } catch {
              if (token.isCancellationRequested || !isCurrent()) {
                return undefined;
              }
              skip(resource, "読み取り・検査に失敗しました");
            }
          }

          if (
            !(await inspectionHeadsAreCurrent(gitInspection, token, isCurrent))
          ) {
            return undefined;
          }
          try {
            await this.workspaceState.update(ENCODING_BASELINE_KEY, Object.fromEntries(nextEncodings));
            await this.workspaceState.update(
              LINE_ENDING_BASELINE_KEY,
              Object.fromEntries(nextLineEndings),
            );
            await this.workspaceState.update(
              LEGACY_LINE_ENDING_BASELINE_KEY,
              undefined,
            );
          } catch (error) {
            await restoreScanBaselineState(
              this.workspaceState,
              previousBaselineState,
              previousLegacyBaselineState,
              previousEncodingState,
            );
            if (token.isCancellationRequested) {
              return undefined;
            }
            throw error;
          }
          if (
            !(await inspectionHeadsAreCurrent(gitInspection, token, isCurrent))
          ) {
            await restoreScanBaselineState(
              this.workspaceState,
              previousBaselineState,
              previousLegacyBaselineState,
              previousEncodingState,
            );
            return undefined;
          }
          for (const { reader, count } of commits) reader.commit(count);
          committed = true;
          const checkedSet = new Set(checkedUris);
          return {
            pageCursors, hasMore, files, unreadableDirectories: [...unreadableDirectories],
            headVerifications: gitInspection.headVerifications,
            checkedUris,
            attemptedUris: [...new Set([...resources, ...unreadableResources].map(({ uri }) => uri.toString()).concat([...attemptedDirectories]))],
            completedAt: new Date(),
            scopeLabel: scope?.label,
            scannedCount,
            skippedCount: skippedFiles.length,
            skippedFiles,
            summaries: [...summaryCounts.entries()]
              .map(([encoding, count]) => ({ encoding, count }))
              .sort(
                (left, right) =>
                  right.count - left.count ||
                  left.encoding.localeCompare(right.encoding),
              ),
            lineEndingSummaries: [...lineEndingCounts.entries()]
              .map(([encoding, count]) => ({ encoding, count }))
              .sort(
                (left, right) =>
                  right.count - left.count ||
                  left.encoding.localeCompare(right.encoding),
              ),
            findings: findings.sort((left, right) =>
              left.displayPath.localeCompare(right.displayPath),
            ),
            gitStatuses: buildGitStatuses(
              folders,
              comparisonResources.filter(({ uri }) => checkedSet.has(uri.toString())),
              gitInspection,
              this.configurationFor,
            ),
          };
        },
      );
    } finally {
      if (!committed) for (const reader of createdReaders) {
        this.readers.delete(reader);
        await reader.dispose().catch(() => undefined);
      }
      progressCancellation?.dispose();
      externalCancellation?.dispose();
      linkedCancellation.dispose();
    }
  }
}

async function restoreScanBaselineState(
  state: vscode.Memento,
  currentState: unknown,
  legacyState: unknown,
  encodingState: unknown,
): Promise<void> {
  await Promise.all([
    state.update(LINE_ENDING_BASELINE_KEY, currentState),
    state.update(LEGACY_LINE_ENDING_BASELINE_KEY, legacyState),
    state.update(ENCODING_BASELINE_KEY, encodingState),
  ]);
}

async function inspectionHeadsAreCurrent(
  inspection: GitInspectionResult,
  token: vscode.CancellationToken,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (token.isCancellationRequested || !isCurrent()) {
    return false;
  }
  try {
    const headsAreCurrent = await verifyGitInspectionHeads(inspection, token);
    return headsAreCurrent && !token.isCancellationRequested && isCurrent();
  } catch (error) {
    if (token.isCancellationRequested) {
      return false;
    }
    throw error;
  }
}


const LEGACY_LINE_ENDING_BASELINE_KEY = "lineEndingBaseline.v1";

function readLineEndingBaseline(
  currentState: unknown,
  legacyState: unknown,
): Map<string, LineEndingBaseline> {
  const current = new Map(parseLineEndingBaselines(currentState));
  for (const [key, baseline] of parseLegacyLineEndingBaselines(legacyState)) {
    if (!current.has(key)) {
      current.set(key, baseline);
    }
  }
  return current;
}

function isDirty(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return vscode.workspace.textDocuments.some(
    (document) => document.uri.toString() === key && document.isDirty,
  );
}

function buildGitStatuses(
  folders: readonly vscode.WorkspaceFolder[],
  resources: readonly {
    readonly uri: vscode.Uri;
    readonly folder: vscode.WorkspaceFolder;
  }[],
  inspection: GitInspectionResult,
  configurationFor: (
    scope: vscode.ConfigurationScope,
  ) => vscode.WorkspaceConfiguration,
): GitInspectionStatus[] {
  const statuses: GitInspectionStatus[] = [];
  for (const folder of folders) {
    const folderResources = resources.filter(
      (resource) => resource.folder.uri.toString() === folder.uri.toString(),
    );
    if (folderResources.length === 0) {
      continue;
    }
    if (inspection.availability === "unavailable") {
      statuses.push({
        folder,
        kind: "unavailable",
        matchedFileCount: 0,
        unmanagedFileCount: 0,
      });
      continue;
    }
    const folderInspections = folderResources
      .map((resource) => inspection.files.get(resource.uri.toString()))
      .filter((value) => value !== undefined);
    const unmanagedFileCount =
      folderResources.length - folderInspections.length;
    if (folderInspections.length === 0) {
      statuses.push({
        folder,
        kind: "notRepository",
        matchedFileCount: 0,
        unmanagedFileCount,
      });
      continue;
    }
    if (folderInspections.some((value) => value.historyLookupFailed)) {
      statuses.push({
        folder,
        kind: "readFailed",
        matchedFileCount: 0,
        unmanagedFileCount,
      });
      continue;
    }
    if (unmanagedFileCount > 0) {
      statuses.push({
        folder,
        kind: "partlyNotRepository",
        matchedFileCount: 0,
        unmanagedFileCount,
      });
      continue;
    }
    if (!configurationFor(folder.uri).get("useGitAttributes", true)) {
      statuses.push({
        folder,
        kind: "disabled",
        matchedFileCount: 0,
        unmanagedFileCount: 0,
      });
      continue;
    }
    if (folderInspections.some((value) => value.attributeLookupFailed)) {
      statuses.push({
        folder,
        kind: "readFailed",
        matchedFileCount: 0,
        unmanagedFileCount: 0,
      });
      continue;
    }
    const matchedFileCount = folderInspections.filter(
      (value) => value.expectedLineEnding !== undefined,
    ).length;
    statuses.push({
      folder,
      kind: matchedFileCount > 0 ? "active" : "noEolRules",
      matchedFileCount,
      unmanagedFileCount: 0,
    });
  }
  return statuses;
}


function scanDisplayPath(resource: ScanResource): string {
  const relative = path.relative(resource.folder.uri.fsPath, resource.uri.fsPath).replaceAll(path.sep, "/");
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `${resource.folder.name}/${relative}` : relative;
}
