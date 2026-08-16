import * as vscode from "vscode";
import type { DocumentationService } from "../../types";
import type { HighlightController } from "../../highlighting/highlightController";
import type { ActiveEditorTracker } from "../../editor-interactions/activeEditorTracker";
import type { ActivityLog } from "../../activity/activityLog";
import { ComposePanel } from "./composePanel";

export interface ComposeCommandsDeps {
  documentationService: DocumentationService;
  highlightController: HighlightController;
  refreshDocumentedSections: () => Promise<void>;
  activeEditorTracker: ActiveEditorTracker;
  activityLog: ActivityLog;
}

export function registerComposeCommands(context: vscode.ExtensionContext, deps: ComposeCommandsDeps): void {
  // Real feature command -- 7.4's "Document selection" QuickPick item calls
  // this same open/reveal path, not a separate one.
  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.openCompose", async () => {
      const panel = ComposePanel.openOrReveal(context, deps.documentationService, deps.highlightController, deps.refreshDocumentedSections, deps.activeEditorTracker, deps.activityLog);

      // Same capture-at-open fix as the context menu's own "Document
      // selection" item -- if there's already a real, non-empty selection
      // at the moment this command runs (the common case: select code,
      // then run this from the Command Palette), capture it now rather
      // than leaving submit to re-read whatever's selected later. Only
      // falls back to the untargeted reset when nothing's selected yet,
      // preserving "open blank, then select, then submit".
      const editor = vscode.window.activeTextEditor;
      const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
      if (editor && folder && !editor.selection.isEmpty) {
        const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
        const start = editor.document.offsetAt(editor.selection.start);
        const end = editor.document.offsetAt(editor.selection.end);
        await panel.beginFreshWrite(folder.uri.fsPath, relativePath, start, end);
      } else {
        // resetToFresh() matters here too, not just from the context menu's
        // own redirect path -- reusing an existing panel that was still
        // showing leftover drift-update state (button/text from an earlier,
        // unrelated action) must not carry that state into a new, unrelated
        // "document selection" session.
        await panel.resetToFresh();
      }
    })
  );

  // rapidDocs.testBeginDriftUpdate was a deliberately temporary stand-in for
  // 7.4's real "Update documentation (code changed)" trigger, removed
  // 2026-08-11 now that registerEditorContextMenu.ts's QuickPick calls
  // beginDriftUpdate() directly for real.

  // Real bug found via manual testing (2026-08-15): reloading the window
  // while Compose was open left an empty tab behind -- VSCode remembers a
  // panel WAS open there and shows its shell again, but has no way to
  // regenerate the HTML content itself; that only ever happens through our
  // own code, which never re-ran for a revived tab without a registered
  // serializer telling VSCode how to do it.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("rapidDocsCompose", {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel): Promise<void> {
        ComposePanel.revive(webviewPanel, context, deps.documentationService, deps.highlightController, deps.refreshDocumentedSections, deps.activeEditorTracker, deps.activityLog);
      },
    })
  );
}
