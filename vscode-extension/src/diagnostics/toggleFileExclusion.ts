import * as vscode from "vscode";
import type { DocumentationService } from "../types";
import type { ActivityLog } from "../activity/activityLog";
import { formatDisplayPath } from "../editor-interactions/displayPath";
import { isExcluded, toggleExclusion } from "./fileExclusions";
import { refreshDiagnosticsForFile } from "./diagnosticsController";

// VSCode context key the Documented Sections title-bar icon's own
// visibility is bound to (package.json's view/title `when` clauses) -- see
// this module's own header below for why it has to be kept current from
// both places that can change the underlying state, not just one.
export const ACTIVE_FILE_EXCLUDED_CONTEXT_KEY = "rapidDocs.activeFileExcluded";

// The one real place BOTH UI entry points funnel through -- real
// requirement, 2026-10-10: the editor context menu's QuickPick toggle item
// and the Documented Sections title-bar icon must never be two independent
// implementations of "turn this off/on" that could quietly drift apart
// (one updates diagnostics but forgets the context key, say). Both call
// this one function, so there is exactly one place that knows everything a
// toggle has to do: persist the setting, repaint diagnostics, update the
// context key the title-bar icon's visibility reads, and log it. Neither
// caller reimplements any of this itself.
export async function toggleFileExclusionAndRefresh(
  context: vscode.ExtensionContext,
  diagnosticCollection: vscode.DiagnosticCollection,
  documentationService: DocumentationService,
  activityLog: ActivityLog,
  repoPath: string,
  relativePath: string,
  fileUri: vscode.Uri
): Promise<void> {
  const nowExcluded = await toggleExclusion(context.workspaceState, repoPath, relativePath);
  const displayPath = formatDisplayPath(repoPath, relativePath);

  if (nowExcluded) {
    // Cleared immediately, not left to the next live-watch tick -- the
    // whole point is a visibly instant "stop showing me this."
    diagnosticCollection.set(fileUri, []);
    activityLog.success(`Disabled rapid-docs for this file. (${displayPath})`);
  } else {
    // Repopulated immediately too, via the exact same
    // checkFile/generateMessages path the live-watch catch-up loop itself
    // uses -- re-enabling shouldn't mean waiting for the next edit before
    // squiggles come back.
    await refreshDiagnosticsForFile(diagnosticCollection, documentationService, repoPath, relativePath, (path) =>
      isExcluded(context.workspaceState, repoPath, path)
    );
    activityLog.success(`Enabled rapid-docs for this file. (${displayPath})`);
  }

  await vscode.commands.executeCommand("setContext", ACTIVE_FILE_EXCLUDED_CONTEXT_KEY, nowExcluded);
}

// Resolves and pushes the context key for whatever file this editor
// belongs to -- called once at activation and again on every active-editor
// change, so the title-bar icon's visibility never shows a stale file's
// state (e.g. still showing "disabled" after switching to a different,
// never-excluded file).
export async function syncActiveFileExclusionContext(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor | undefined
): Promise<void> {
  if (!editor) return;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) return;
  const repoPath = folder.uri.fsPath;
  const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
  const excluded = isExcluded(context.workspaceState, repoPath, relativePath);
  await vscode.commands.executeCommand("setContext", ACTIVE_FILE_EXCLUDED_CONTEXT_KEY, excluded);
}
