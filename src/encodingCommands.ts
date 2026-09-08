import { readMixedPolicy, writeMixedPolicy } from "./mixedPolicy.js";
import { LINE_ENDING_BASELINE_KEY, parseLineEndingBaselines } from "./lineEndingBaseline.js";
import * as vscode from "vscode";
import type { SerialTaskQueue } from "./coalescingTask.js";
import type { FindingItem, MixedAllowanceItem } from "./encodingView.js";
import { ENCODING_BASELINE_KEY, acknowledgedEncodingBaseline, parseEncodingBaselines } from "./encodingBaseline.js";
import { hashBytes, isDirty } from "./conversionResources.js";
import { configuredFileSizeLimit } from "./fileLimits.js";
import { readStableResource, resourceStillMatchesRead } from "./stableResourceRead.js";
import { configurationFor, resolveRule } from "./workspaceRules.js";

export async function acknowledgeEncodingChange(
  item: FindingItem | undefined,
  state: vscode.Memento,
  baselineQueue: SerialTaskQueue,
  refresh: () => Promise<void>,
  kind: "encoding" | "lineEnding" = "encoding",
): Promise<void> {
  const change = item?.finding.encodingChange;
  const eol = kind === "lineEnding" ? item?.finding.localLineEndingChange : undefined;
  if (!item || (kind === "lineEnding" ? !eol : !change)) return;
  const label = kind === "lineEnding" ? "改行" : "文字コード";
  const selected = await vscode.window.showWarningMessage(
    `${item.finding.displayPath} の${label}変更を確認済みにしますか？`,
    { modal: true, detail: `ローカルの${label}比較基準だけを更新します。ファイル、別の比較基準、Git HEADとの差、ルール不一致、混在の注意は変更しません。` },
    "確認済みにする",
  );
  if (selected !== "確認済みにする") return;
  const updated = await baselineQueue.run(async () => {
    const uri = item.finding.uri;
    const match = resolveRule(uri);
    if (uri.scheme !== "file" || !match || isDirty(uri)) return false;
    const maxSize = configuredFileSizeLimit(configurationFor(match.folder.uri).get("maxFileSizeKB", 5120));
    const read = await readStableResource(uri, maxSize, () => isDirty(uri));
    if (!read) return false;
    if (eol) {
      const baselines = new Map(parseLineEndingBaselines(state.get(LINE_ENDING_BASELINE_KEY)));
      if (eol.baseline.source !== "baseline" || eol.current.source !== "baseline" ||
          JSON.stringify(baselines.get(uri.toString())) !== JSON.stringify(eol.baseline) ||
          hashBytes(read.bytes) !== eol.contentHash || resolveRule(uri)?.rule.encoding !== eol.expectedEncoding ||
          !(await resourceStillMatchesRead(uri, maxSize, read, () => isDirty(uri)))) return false;
      if (resolveRule(uri)?.rule.encoding !== eol.expectedEncoding || isDirty(uri)) return false;
      baselines.set(uri.toString(), eol.current);
      await state.update(LINE_ENDING_BASELINE_KEY, Object.fromEntries(baselines));
      return true;
    }
    if (!change) return false;
    const baselines = parseEncodingBaselines(state.get(ENCODING_BASELINE_KEY));
    const baseline = acknowledgedEncodingBaseline(
      change, baselines.get(uri.toString()), hashBytes(read.bytes), resolveRule(uri)?.rule.encoding,
    );
    if (!baseline || !(await resourceStillMatchesRead(uri, maxSize, read, () => isDirty(uri)))) return false;
    if (resolveRule(uri)?.rule.encoding !== change.expectedEncoding || isDirty(uri)) return false;
    baselines.set(uri.toString(), baseline);
    await state.update(ENCODING_BASELINE_KEY, Object.fromEntries(baselines));
    return true;
  });
  if (!updated) {
    void vscode.window.showWarningMessage("ファイル・設定・比較基準が変わっています。未保存の変更を保存し、一覧を更新してから再確認してください。");
    return;
  }
  await refresh();
}

export async function removeMixedAllowance(
  item: MixedAllowanceItem | undefined,
  settingsQueue: SerialTaskQueue,
  refresh: () => Promise<void>,
): Promise<void> {
  if (!item) return;
  await settingsQueue.run(async () => {
    if (readMixedPolicy(item.folder, item.entry) !== item.allowed) return;
    await writeMixedPolicy(item.folder, item.entry, undefined);
  });
  await refresh();
}
