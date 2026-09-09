import * as vscode from "vscode";
import assert from "node:assert/strict";

interface PickResponse { title: string; label?: string; all?: boolean; cancel?: boolean }
export const picks: PickResponse[] = [];
export const confirmations: string[] = [];
export const nonModalResponses: string[] = [];
export const errors: string[] = [];
export const expectedErrors: string[] = [];
export const notices: string[] = [];
export const statusItems: vscode.StatusBarItem[] = [];
export const inventoryPanels: vscode.WebviewPanel[] = [];
export const providers = new Map<string, vscode.TreeDataProvider<unknown>>();

// Only human input is substituted. Files, Git, settings, command registration,
// tree items and Extension Host execution remain the actual VS Code APIs.
const windowOverrides: Partial<typeof vscode.window> = {
  createWebviewPanel: ((...args: Parameters<typeof vscode.window.createWebviewPanel>) => {
    const panel = vscode.window.createWebviewPanel(...args); inventoryPanels.push(panel); return panel;
  }) as typeof vscode.window.createWebviewPanel,
  createStatusBarItem: ((alignment: vscode.StatusBarAlignment, priority?: number) => {
    const status = vscode.window.createStatusBarItem(alignment, priority);
    statusItems.push(status);
    return status;
  }) as typeof vscode.window.createStatusBarItem,
  showQuickPick: (async (
    offered: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>,
    options: vscode.QuickPickOptions,
  ) => {
    const response = picks.shift();
    assert.ok(response, `Unexpected picker: ${options.title}`);
    assert.ok(options.title?.includes(response.title), `${options.title} != ${response.title}`);
    const items = await offered;
    if (response.cancel) return undefined;
    if (response.all) return items;
    const item = items.find((item) => item.label === response.label);
    assert.ok(item, `Missing choice: ${response.label}`);
    return item;
  }) as unknown as typeof vscode.window.showQuickPick,
  showWarningMessage: (async (_message: string, ...args: unknown[]) => {
    notices.push(_message);
    const options = args[0];
    if (options && typeof options === "object" && "modal" in options && options.modal) {
      const response = confirmations.shift();
      assert.ok(response, `Unexpected confirmation: ${_message}`);
      if (response === "キャンセル") return undefined;
      assert.ok(args.includes(response), `Missing confirmation: ${response}`);
      return response;
    }
    if (nonModalResponses[0] && args.includes(nonModalResponses[0])) return nonModalResponses.shift();
    return undefined;
  }) as typeof vscode.window.showWarningMessage,
  showInformationMessage: (async (message: string) => { notices.push(message); return undefined; }) as typeof vscode.window.showInformationMessage,
  showErrorMessage: (async (message: string) => {
    if (message === expectedErrors[0]) expectedErrors.shift();
    else errors.push(message);
    return undefined;
  }) as typeof vscode.window.showErrorMessage,
  registerTreeDataProvider: (id, provider) => {
    providers.set(id, provider as vscode.TreeDataProvider<unknown>);
    return vscode.window.registerTreeDataProvider(id, provider);
  },
};

export const vscodeProxy = {
  ...vscode,
  window: new Proxy(vscode.window, {
    get(target, key: keyof typeof vscode.window) {
      return key in windowOverrides ? windowOverrides[key] : target[key];
    },
  }),
};
