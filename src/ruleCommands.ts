import * as path from "node:path";
import * as vscode from "vscode";
import type { SerialTaskQueue } from "./coalescingTask.js";
import { ENCODINGS, EncodingRule, patternForFolder, patternForFile } from "./rules.js";
import type { RuleItem, RulesProvider, EncodingDecorationProvider } from "./encodingView.js";
import { RULES_SETTING, configurationFor, getRules, relativePathFor } from "./workspaceRules.js";

let configuring = false;

export async function configureFolder(
  uri: vscode.Uri | undefined, rules: RulesProvider, decorations: EncodingDecorationProvider, queue: SerialTaskQueue, fileOnly = false,
): Promise<void> {
  if (configuring) return;
  configuring = true;
  try { await configureTarget(uri, rules, decorations, queue, fileOnly); } finally { configuring = false; }
}

async function configureTarget(
  suppliedUri: vscode.Uri | undefined,
  rulesProvider: RulesProvider,
  decorationProvider: EncodingDecorationProvider,
  settingsQueue: SerialTaskQueue,
  fileOnly = false,
): Promise<void> {
  let uri = suppliedUri;
  if (!uri) {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: fileOnly,
      canSelectFolders: !fileOnly,
      canSelectMany: false,
      openLabel: "文字コードを設定",
      title: fileOnly ? "設定するファイルを選択" : "対象フォルダーを選択",
    });
    uri = selected?.[0];
  }
  if (!uri) {
    return;
  }

  if (fileOnly) {
    try {
      if ((await vscode.workspace.fs.stat(uri)).type !== vscode.FileType.File) throw new Error();
    } catch {
      void vscode.window.showErrorMessage("通常のファイルを選択してください。");
      return;
    }
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    void vscode.window.showErrorMessage("開いているワークスペース内のフォルダーを選択してください。");
    return;
  }
  const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
  const normalizedRelativePath = relativePathFor(uri, folder);
  if (
    normalizedRelativePath === ".." ||
    normalizedRelativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    void vscode.window.showErrorMessage("ワークスペース外のフォルダーには設定できません。");
    return;
  }

  const choice = await vscode.window.showQuickPick(
    ENCODINGS.map((encoding) => ({
      label: encoding.label,
      description: encoding.id,
      encoding: encoding.id,
    })),
    {
      title: `${relativePath || folder.name} の文字コード`,
      placeHolder: fileOnly ? "このファイルだけに適用する文字コードを選択" : "このフォルダー以下で使う文字コードを選択",
    },
  );
  if (!choice) {
    return;
  }

  const pattern = fileOnly ? patternForFile(relativePath) : patternForFolder(relativePath);
  await settingsQueue.run(async () => {
    const currentRules = getRules(folder);
    const nextRules = [...currentRules];
    const existing = nextRules.findIndex((rule) => rule.pattern === pattern);
    if (existing < 0) nextRules.unshift({ pattern, encoding: choice.encoding });
    else nextRules[existing] = { pattern, encoding: choice.encoding };
    await configurationFor(folder.uri).update(
      RULES_SETTING,
      nextRules,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  });
  rulesProvider.refresh();
  decorationProvider.refresh();
  void vscode.window.showInformationMessage(
    `${relativePath || folder.name}${fileOnly ? " だけ" : " 以下"}を ${choice.label} として登録しました。`,
  );
}

export async function removeRule(
  item: RuleItem | undefined,
  rulesProvider: RulesProvider,
  decorationProvider: EncodingDecorationProvider,
  settingsQueue: SerialTaskQueue,
): Promise<void> {
  if (!item) {
    return;
  }
  await withRuleOperation(item, async () => {
    await updateRule(item, settingsQueue, (rules) => { rules.splice(item.ruleIndex, 1); });
    rulesProvider.refresh();
    decorationProvider.refresh();
  });
}

const activeRuleOperations = new Set<string>();
async function withRuleOperation(item: RuleItem, operation: () => Promise<void>): Promise<void> {
  const key = item.folder.uri.toString();
  if (activeRuleOperations.has(key)) return;
  activeRuleOperations.add(key);
  try { await operation(); } finally { activeRuleOperations.delete(key); }
}

async function updateRule(
  item: RuleItem,
  queue: SerialTaskQueue,
  change: (rules: EncodingRule[]) => void,
  expectedRules?: string,
): Promise<void> {
  const updated = await queue.run(async () => {
    const rules = getRules(item.folder);
    const current = rules[item.ruleIndex];
    if (current?.pattern !== item.rule.pattern || current.encoding !== item.rule.encoding ||
      (expectedRules !== undefined && JSON.stringify(rules) !== expectedRules)) return false;
    const before = JSON.stringify(rules);
    change(rules);
    if (JSON.stringify(rules) === before) return true;
    await configurationFor(item.folder.uri).update(RULES_SETTING, rules, vscode.ConfigurationTarget.WorkspaceFolder);
    return true;
  });
  if (!updated) void vscode.window.showWarningMessage("設定が更新されています。ルール一覧を更新して再試行してください。");
}

export async function editRule(item: RuleItem | undefined, queue: SerialTaskQueue): Promise<void> {
  if (!item) return;
  await withRuleOperation(item, async () => {
    const expectedRules = JSON.stringify(getRules(item.folder));
    const choice = await vscode.window.showQuickPick(
      ENCODINGS.map((encoding) => ({ label: encoding.label, encoding: encoding.id,
        description: encoding.id === item.rule.encoding ? "現在の文字コード" : encoding.id })),
      { title: `${item.rule.pattern} の文字コードを変更`, placeHolder: "優先順位と対象パターンは維持します" },
    );
    if (!choice) return;
    await updateRule(item, queue, (rules) => {
      rules[item.ruleIndex] = { ...item.rule, encoding: choice.encoding };
    }, expectedRules);
  });
}

export async function moveRule(item: RuleItem | undefined, direction: -1 | 1, queue: SerialTaskQueue): Promise<void> {
  if (!item) return;
  await withRuleOperation(item, async () => {
    await updateRule(item, queue, (rules) => {
      const target = item.ruleIndex + direction;
      if (target < 0 || target >= rules.length) return;
      [rules[item.ruleIndex], rules[target]] = [rules[target]!, rules[item.ruleIndex]!];
    });
  });
}
