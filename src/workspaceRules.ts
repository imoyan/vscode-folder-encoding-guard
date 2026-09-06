import * as path from "node:path";
import * as vscode from "vscode";
import { EncodingRule, findMatchingRule, sanitizeRules, isMixedPathAllowed } from "./rules.js";

export const CONFIGURATION_SECTION = "folderEncodingGuard";
export const RULES_SETTING = "rules";
export const ALLOWED_MIXED_LINE_ENDINGS_SETTING = "allowedMixedLineEndings";

export interface RuleMatch {
  readonly folder: vscode.WorkspaceFolder;
  readonly relativePath: string;
  readonly rule: EncodingRule;
  readonly index: number;
}

export function configurationFor(scope: vscode.ConfigurationScope): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION, scope);
}

export function getRules(folder: vscode.WorkspaceFolder): EncodingRule[] {
  return sanitizeRules(configurationFor(folder.uri).get<unknown>(RULES_SETTING));
}

export function getAllowedMixedLineEndings(folder: vscode.WorkspaceFolder): string[] {
  const value = configurationFor(folder.uri).get<unknown>(ALLOWED_MIXED_LINE_ENDINGS_SETTING);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function relativePathFor(uri: vscode.Uri, folder: vscode.WorkspaceFolder): string {
  return path.relative(folder.uri.fsPath, uri.fsPath).replaceAll(path.sep, "/");
}

export function isMixedLineEndingAllowed(uri: vscode.Uri): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder
    ? isMixedPathAllowed(getAllowedMixedLineEndings(folder), relativePathFor(uri, folder))
    : false;
}

export function fileUriForResource(uri: vscode.Uri): vscode.Uri {
  return uri.scheme !== "git"
    ? uri
    : vscode.Uri.file(uri.fsPath || uri.path).with({ fragment: "", query: "" });
}

export function resolveRule(uri: vscode.Uri): RuleMatch | undefined {
  if (uri.scheme === "untitled" || uri.path.length === 0) {
    return undefined;
  }
  const fileUri = fileUriForResource(uri);
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  if (!folder) {
    return undefined;
  }
  const relativePath = relativePathFor(fileUri, folder);
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    return undefined;
  }
  const matched = findMatchingRule(getRules(folder), relativePath);
  return matched ? { folder, relativePath, ...matched } : undefined;
}
