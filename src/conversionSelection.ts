import * as path from "node:path";
import * as vscode from "vscode";
import { protectedConversionSession, conversionSelectionBackupBytes, assessEncodingConversion } from "./conversionCore.js";
import { LAST_BACKUP_KEY, PROTECTED_BACKUP_KEY } from "./conversionBackup.js";
import { isDirty, hashBytes } from "./conversionResources.js";
import { ENCODINGS, encodingInfo } from "./rules.js";
import { readStableResource } from "./stableResourceRead.js";
import { resolveRealDirectory, resolveRealPathWithin } from "./localPathSafety.js";
import { DEFAULT_SCAN_EXCLUDE, configuredFileSizeLimit } from "./fileLimits.js";
import { classifyEncoding, classifyLineEndings } from "./scanCore.js";

export interface ConversionCandidate extends vscode.QuickPickItem {
  readonly needsConfirmation: boolean;
  readonly uri: vscode.Uri;
  readonly writeUri: vscode.Uri;
  readonly relativePath: string;
  readonly originalHash: string;
  readonly originalSize: number;
  readonly maxSize: number;
  readonly conversionRootRealPath: string;
  readonly workspaceRootRealPath: string;
}

export interface ConversionSelection {
  readonly selected: readonly ConversionCandidate[];
  readonly sourceEncoding: string;
  readonly targetEncoding: string;
  readonly targetLineEnding?: "lf" | "crlf";
}

/** 候補の検査と確認のみ。書き込み前の再検査と実行はConversionManagerが担当します。 */
export async function selectConversion(
  context: vscode.ExtensionContext,
  expectedEncodingFor: (uri: vscode.Uri) => string | undefined,
  configurationFor: (scope: vscode.ConfigurationScope) => vscode.WorkspaceConfiguration,
  suppliedUri?: vscode.Uri,
  suppliedTargetEncoding?: string,
): Promise<ConversionSelection | undefined> {
  const folderUri = await pickFolder(suppliedUri);
  if (!folderUri) {
    return undefined;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri);
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage("開いているワークスペース内のフォルダーを選択してください。");
    return undefined;
  }
  if (folderUri.scheme !== "file" || workspaceFolder.uri.scheme !== "file") {
    void vscode.window.showErrorMessage("既存ファイルの変換はローカルワークスペースでのみ利用できます。");
    return undefined;
  }
  const workspaceRootRealPath = await resolveRealDirectory(workspaceFolder.uri.fsPath);
  const folderRealPath = workspaceRootRealPath
    ? await resolveRealPathWithin(workspaceRootRealPath, folderUri.fsPath)
    : undefined;
  if (!workspaceRootRealPath || !folderRealPath) {
    void vscode.window.showErrorMessage(
      "選択したフォルダーの実体がワークスペース外にあるため変換できません。",
    );
    return undefined;
  }
  const previousSession = protectedConversionSession(
    context.workspaceState.get<unknown>(LAST_BACKUP_KEY),
    context.workspaceState.get<unknown>(PROTECTED_BACKUP_KEY),
  );
  if (previousSession) {
    const protectedUri = vscode.Uri.parse(previousSession);
    const proceed = await vscode.window.showWarningMessage(
      "前回の復元が未完了です。新しい変換の自動復元対象にはなりませんが、" +
        `退避データ ${protectedUri.fsPath} を残して変換を続けますか？`,
      { modal: true },
      "退避データを残して続ける",
    );
    if (proceed !== "退避データを残して続ける") {
      return undefined;
    }
  }

  const mode = await vscode.window.showQuickPick([
    { label: "文字コードのみ", encoding: true, eol: false },
    { label: "改行コードのみ", encoding: false, eol: true },
    { label: "文字コードと改行コード", encoding: true, eol: true },
  ], { title: "変換する項目を選択" });
  if (!mode) return undefined;
  const lineEnding = mode.eol ? await vscode.window.showQuickPick([
    { label: "LF", value: "lf" as const },
    { label: "CRLF", value: "crlf" as const },
  ], { title: "変換先の改行コード" }) : undefined;
  if (mode.eol && !lineEnding) return undefined;
  const targetLineEnding = lineEnding?.value;
  const probeUri = vscode.Uri.joinPath(folderUri, "__folder_encoding_guard_probe__.txt");
  const ruleTarget = suppliedTargetEncoding ?? expectedEncodingFor(probeUri);
  const requestedTarget = mode.encoding
    ? ruleTarget ?? (await pickEncoding("変換先の文字コードを選択"))
    : undefined;
  if (mode.encoding && !requestedTarget) {
    return undefined;
  }
  const sourceEncoding = await pickEncoding(
    "現在の文字コードを選択",
    mode.eol ? undefined : requestedTarget,
    "読み込みに使う文字コードです。候補のプレビューを確認してください。",
  );
  if (!sourceEncoding) {
    return undefined;
  }
  const targetEncoding = requestedTarget ?? sourceEncoding;
  const conversionDescription = `${encodingInfo(sourceEncoding).label} → ${encodingInfo(targetEncoding).label}` +
    (targetLineEnding ? ` / 改行 → ${targetLineEnding.toUpperCase()}` : " / 改行は維持");

  const config = configurationFor(workspaceFolder.uri);
  const maxFiles = config.get<number>("maxScanFiles", 5000);
  const maxFileSize = configuredFileSizeLimit(
    config.get<number>("maxFileSizeKB", 5120),
  );
  const exclude = config.get<string>(
    "conversionExclude",
    DEFAULT_SCAN_EXCLUDE,
  );
  const excluded: vscode.QuickPickItem[] = [];
  const recordExcluded = (uri: vscode.Uri, reason: string): void => {
    excluded.push({ label: path.relative(folderUri.fsPath, uri.fsPath).replaceAll(path.sep, "/"), description: reason });
  };
  const scanResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${encodingInfo(sourceEncoding).label} のファイルを確認中`,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: "対象ファイルを列挙中" });
      let uris: readonly vscode.Uri[];
      try {
        uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folderUri, "**/*"),
          exclude,
          maxFiles + 1,
          token,
        );
      } catch (error) {
        if (token.isCancellationRequested) {
          return { candidates: [], cancelled: true, exceededLimit: false };
        }
        throw error;
      }
      if (token.isCancellationRequested) {
        return { candidates: [], cancelled: true, exceededLimit: false };
      }
      if (uris.length > maxFiles) {
        return { candidates: [], cancelled: false, exceededLimit: true };
      }
      const found: ConversionCandidate[] = [];
      for (const [index, uri] of uris.entries()) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({
          increment: uris.length === 0 ? 100 : 100 / uris.length,
          message: `${index + 1}/${uris.length}`,
        });
        const resolvedPath = await resolveRealPathWithin(
          folderRealPath,
          uri.fsPath,
        );
        if (!resolvedPath) {
          recordExcluded(uri, "対象範囲外・パスを確認できません");
          continue;
        }
        const writeUri = vscode.Uri.file(resolvedPath);
        if (isDirty(uri, writeUri)) {
          recordExcluded(uri, "未保存の変更があります");
          continue;
        }
        const fileRuleEncoding = expectedEncodingFor(uri);
        if (mode.encoding && fileRuleEncoding && fileRuleEncoding !== targetEncoding) {
          recordExcluded(uri, "別の文字コードルールが適用されています");
          continue;
        }
        try {
          const info = await vscode.workspace.fs.stat(writeUri);
          if (info.size > maxFileSize) {
            recordExcluded(uri, "ファイルサイズ上限を超えています");
            continue;
          }
          const read = await readStableResource(
            writeUri,
            maxFileSize,
            () => isDirty(uri, writeUri),
            () => token.isCancellationRequested,
          );
          if (!read) {
            recordExcluded(uri, "変更中・読み取り不可のため未確認");
            continue;
          }
          const original = read.bytes;
          const assessment = await assessEncodingConversion(original, sourceEncoding, targetEncoding, {
            decode: async (bytes, encoding) => vscode.workspace.decode(bytes, { encoding }),
            encode: async (text, encoding) => vscode.workspace.encode(text, { encoding }),
          }, () => token.isCancellationRequested, targetLineEnding);
          if (assessment.kind === "skipped") {
            const reasons = {
              cancelled: "キャンセル", binary: "バイナリとして除外", unchanged: "変換不要（変更なし）",
              sourceMismatch: "読み込み文字コードが不一致・未対応",
              targetMismatch: "変換先で表現できない文字・変換失敗",
            };
            recordExcluded(uri, reasons[assessment.reason]);
            continue;
          }
          const prepared = assessment.prepared;
          const classification = await classifyEncoding(original, sourceEncoding, {
            decode: async (bytes, encoding) => vscode.workspace.decode(bytes, { encoding }),
            encode: async (text, encoding) => vscode.workspace.encode(text, { encoding }),
          }, { isCancellationRequested: () => token.isCancellationRequested,
            alternativeEncodings: ENCODINGS.map((encoding) => encoding.id).filter((encoding) => encoding !== sourceEncoding) });
          const needsConfirmation = classification.kind !== "match" && classification.kind !== "ascii";
          const beforeEol = classifyLineEndings(original, sourceEncoding);
          const eolLabel = beforeEol.kind === "mixed"
            ? beforeEol.styles.join("+").toUpperCase()
            : beforeEol.kind === "none" ? "改行なし" : beforeEol.kind.toUpperCase();
          const relativePath = path
            .relative(folderUri.fsPath, uri.fsPath)
            .replaceAll(path.sep, "/");
          found.push({
            uri,
            writeUri,
            relativePath,
            originalHash: hashBytes(original),
            originalSize: original.byteLength,
            maxSize: maxFileSize,
            conversionRootRealPath: folderRealPath,
            workspaceRootRealPath,
            needsConfirmation,
            label: relativePath,
            description: `${needsConfirmation ? "要確認（文字コード判定不確実） · " : ""}${encodingInfo(sourceEncoding).label} → ${encodingInfo(targetEncoding).label} / ${eolLabel} → ${targetLineEnding?.toUpperCase() ?? eolLabel}`,
            detail: previewText(prepared.text),
            picked: !needsConfirmation,
          });
        } catch {
          recordExcluded(uri, "読み取り・検査に失敗しました");
        }
      }
      return {
        candidates: found,
        cancelled: token.isCancellationRequested,
        exceededLimit: false,
      };
    },
  );

  if (scanResult.cancelled) {
    return undefined;
  }
  if (scanResult.exceededLimit) {
    void vscode.window.showErrorMessage(
      `対象が ${maxFiles} 件を超えました。フォルダーを絞るか maxScanFiles を変更してください。`,
    );
    return undefined;
  }
  const candidates = scanResult.candidates;

  if (excluded.length > 0) {
    const action = "対象外の理由を見る";
    const choice = await vscode.window.showInformationMessage(
      `変換候補 ${candidates.length} 件 / 検査した対象のうち候補外 ${excluded.length} 件。除外globに一致するファイルは列挙対象外です。`, action,
    );
    if (choice === action) {
      await vscode.window.showQuickPick(excluded, {
        title: "変換候補外のファイルと理由（確認のみ）", matchOnDescription: true,
        placeHolder: "この一覧からは変換しません。閉じると候補の選択へ進みます",
      });
    }
  }
  if (candidates.length === 0) {
    if (excluded.length === 0) void vscode.window.showInformationMessage("確認対象がありませんでした。フォルダーと除外設定を確認してください。");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(candidates, {
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: "変換するファイルだけを選択してください",
    title: `変換候補 ${candidates.length} 件（要確認 ${candidates.filter((candidate) => candidate.needsConfirmation).length} 件は未選択）`,
  });
  if (!selected || selected.length === 0) {
    return undefined;
  }

  const backupBytes = conversionSelectionBackupBytes(
    selected.map((candidate) => candidate.originalSize),
  );
  if (backupBytes === undefined) {
    void vscode.window.showErrorMessage(
      "選択したファイルの退避量が512 MiBを超えます。フォルダーまたは選択を分けて変換してください。",
    );
    return undefined;
  }

  const storedBackup = context.workspaceState.get<unknown>(LAST_BACKUP_KEY);
  const replacingBackup = typeof storedBackup === "string" && storedBackup.length > 0 &&
    storedBackup !== context.workspaceState.get<unknown>(PROTECTED_BACKUP_KEY);
  const backupNotice = replacingBackup
    ? " 新しい変換が成功すると前回の復元データは削除され、前回の変換は元に戻せなくなります。"
    : "";
  const confirm = await vscode.window.showWarningMessage(
    `${selected.length} 件を変換します。${conversionDescription}。` +
      `判定不確実な選択 ${selected.filter((candidate) => candidate.needsConfirmation).length} 件。` +
      `変換前データ ${formatByteSize(backupBytes)} はローカルへ退避されます。${backupNotice}`,
    { modal: true },
    "変換する",
  );
  if (confirm !== "変換する") {
    return undefined;
  }
  return { selected, sourceEncoding, targetEncoding, targetLineEnding };
}

async function pickFolder(suppliedUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (suppliedUri) {
    return suppliedUri;
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "既存ファイルを変換",
    title: "変換対象のフォルダーを選択",
  });
  return selected?.[0];
}

async function pickEncoding(
  title: string,
  excludedEncoding?: string,
  placeHolder?: string,
): Promise<string | undefined> {
  const choice = await vscode.window.showQuickPick(
    ENCODINGS.filter((encoding) => encoding.id !== excludedEncoding).map((encoding) => ({
      label: encoding.label,
      description: encoding.id,
      encoding: encoding.id,
    })),
    { title, placeHolder },
  );
  return choice?.encoding;
}

function previewText(text: string): string {
  const sample = text.slice(0, 4096);
  const sanitized = Array.from(sample, (character) => {
    const code = character.charCodeAt(0);
    const control = (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    return control ? "�" : character;
  }).join("");
  const compact = sanitized
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact || "（空のテキスト）";
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
