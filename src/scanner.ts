import type { ScanScope } from "./scanScope.js";
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

export interface EncodingScanSnapshot {
  readonly completedAt: Date;
  readonly scopeLabel?: string;
  readonly scannedCount: number;
  readonly skippedCount: number;
  readonly skippedFiles?: readonly { uri: vscode.Uri; displayPath: string; reason: string }[];
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
  ): Promise<EncodingScanSnapshot | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => !scope || scope.targets.some(({ uri }) => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString()));
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(
        "文字コードを確認するワークスペースを開いてください。",
      );
      return undefined;
    }
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
          const seen = new Set<string>();
          for (const folder of folders) {
            if (token.isCancellationRequested || !isCurrent()) {
              return undefined;
            }
            const rules = this.patternsFor(folder);
            // Enumerate with VS Code syntax, then apply the shared minimatch rule matcher.
            const targets = scope?.targets.filter(({ uri }) => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString())
              ?? [{ uri: folder.uri, directory: true }];
            const config = this.configurationFor(folder.uri);
            const maxFiles = config.get<number>("maxScanFiles", 5000);
            const maxSize = configuredFileSizeLimit(
              config.get<number>("maxFileSizeKB", 5120),
            );
            const exclude = config.get<string>(
              "conversionExclude",
              DEFAULT_SCAN_EXCLUDE,
            );
            const folderResources = new Map<string, vscode.Uri>();
            for (const target of targets) {
              let uris: readonly vscode.Uri[];
              try {
                uris = target.directory ? await vscode.workspace.findFiles(
                  new vscode.RelativePattern(target.uri, "**/*"),
                  exclude,
                  maxFiles + 1,
                  token,
                ) : [target.uri];
              } catch (error) {
                if (token.isCancellationRequested || !isCurrent()) {
                  return undefined;
                }
                throw error;
              }
              if (token.isCancellationRequested || !isCurrent()) {
                return undefined;
              }
              if (uris.length > maxFiles) {
                void vscode.window.showErrorMessage(
                  `${folder.name} の検索候補が ${maxFiles} 件を超えました。` +
                    "入れ子のワークスペースを含む場合はフォルダーを絞るか maxScanFiles を変更してください。",
                );
                return undefined;
              }
              for (const uri of uris) {
                const owner = vscode.workspace.getWorkspaceFolder(uri);
                if (!owner || owner.uri.toString() !== folder.uri.toString()) {
                  continue;
                }
                if (!scope && rules.length > 0 && this.expectedEncodingFor(uri) === undefined) continue;
                folderResources.set(uri.toString(), uri);
                if (folderResources.size > maxFiles) {
                  void vscode.window.showErrorMessage(
                    `${folder.name} のルール対象が ${maxFiles} 件を超えました。` +
                      "フォルダーを絞るか maxScanFiles を変更してください。",
                  );
                  return undefined;
                }
              }
            }
            for (const [key, uri] of folderResources) {
              if (!seen.has(key)) {
                seen.add(key);
                resources.push({ uri, folder, maxSize });
              }
            }
          }
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
          const preparedResources: PreparedScanResource[] = [];
          const scanResources: PreparedScanResource[] = [];
          const skippedFiles: { uri: vscode.Uri; displayPath: string; reason: string }[] = [];
          const skip = (resource: ScanResource, reason: string): void => {
            const relative = path.relative(resource.folder.uri.fsPath, resource.uri.fsPath).replaceAll(path.sep, "/");
            skippedFiles.push({ uri: resource.uri, displayPath: folders.length === 1 ? relative : `${resource.folder.name}/${relative}`, reason });
          };
          for (const resource of resources) {
            if (token.isCancellationRequested || !isCurrent()) {
              return undefined;
            }
            const ruleEncoding = this.expectedEncodingFor(resource.uri);
            // UTF-8 is a probe hint, never an implicit rule for unconfigured files.
            const prepared = { ...resource, expectedEncoding: ruleEncoding ?? "utf8", hasRule: ruleEncoding !== undefined };
            preparedResources.push(prepared);
            if (isDirty(resource.uri)) {
              skip(resource, "未保存の変更があります");
              continue;
            }
            try {
              const stat = await vscode.workspace.fs.stat(resource.uri);
              if (stat.type !== vscode.FileType.File) {
                skip(resource, "通常ファイルではありません");
                continue;
              }
              if (stat.size > resource.maxSize) {
                skip(resource, "サイズ上限超過");
                continue;
              }
              scanResources.push(prepared);
            } catch {
              skip(resource, "ファイル情報を読み取れません");
            }
          }
          const comparisonResources = preparedResources.filter((resource) => resource.hasRule);
          const resourceKeys = new Set(
            comparisonResources.map((resource) => resource.uri.toString()),
          );
          const nextLineEndings = new Map(
            [...previousLineEndings].filter(([key]) => scope !== undefined || resourceKeys.has(key)),
          );
          const nextEncodings = new Map(
            [...previousEncodings].filter(([key]) => scope !== undefined || resourceKeys.has(key)),
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
                const relativePath = path
                  .relative(resource.folder.uri.fsPath, resource.uri.fsPath)
                  .replaceAll(path.sep, "/");
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
                  displayPath:
                    folders.length === 1
                      ? relativePath
                      : `${resource.folder.name}/${relativePath}`,
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
          return {
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
              comparisonResources,
              gitInspection,
              this.configurationFor,
            ),
          };
        },
      );
    } finally {
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
