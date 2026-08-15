import * as vscode from "vscode";

// Real user feedback (2026-08-15), live multi-root testing: Activity log
// entries showing just a bare filename ("example2.ts") give no indication
// of WHICH folder that was in, once more than one is open. This is
// deliberately NOT the same variable that gets passed to
// DocumentationService methods (writeDoc/deleteRecord/etc.) -- those need
// a TRUE relative path with no folder prefix, since they join it directly
// onto repoPath to find the real file on disk; prefixing that would break
// every backend call. This is purely for what a human reads in a message.
//
// Mirrors vscode.workspace.asRelativePath's own "includeWorkspaceFolder"
// behavior (prefix only when there's genuinely more than one folder to
// tell apart) but works from repoPath/relativePath strings directly,
// rather than requiring a live vscode.Uri -- several callers (a pending
// drift-update/edit-record captured earlier, an archived entry) only ever
// have those two strings on hand, not a URI to re-derive them from.
export function formatDisplayPath(repoPath: string, relativePath: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return relativePath;
  const folder = folders.find((f) => f.uri.fsPath === repoPath);
  return folder ? `${folder.name}/${relativePath}` : relativePath;
}
