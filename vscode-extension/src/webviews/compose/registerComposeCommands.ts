import * as vscode from "vscode";
import type { DocumentationService } from "../../types";
import type { HighlightController } from "../../highlighting/highlightController";
import type { ActiveEditorTracker } from "../../editor-interactions/activeEditorTracker";
import { ComposePanel } from "./composePanel";

export interface ComposeCommandsDeps {
  documentationService: DocumentationService;
  highlightController: HighlightController;
  refreshDocumentedSections: () => Promise<void>;
  activeEditorTracker: ActiveEditorTracker;
}

export function registerComposeCommands(context: vscode.ExtensionContext, deps: ComposeCommandsDeps): void {
  // Real feature command -- 7.4's "Document selection" context menu item
  // will call this same open/reveal path, not a separate one.
  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.openCompose", () => {
      ComposePanel.openOrReveal(context, deps.documentationService, deps.highlightController, deps.refreshDocumentedSections, deps.activeEditorTracker);
    })
  );

  // Temporary: 7.4's real trigger is "Update documentation (code changed)"
  // on the editor's right-click menu, not built yet. This exercises the
  // exact same beginDriftUpdate() path in the meantime, so 7.3 can be fully
  // verified now rather than left half-tested until 7.4 exists; 7.4 will
  // call beginDriftUpdate() directly instead of adding its own logic.
  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.testBeginDriftUpdate", () => {
      const editor = deps.activeEditorTracker.getEditor();
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!editor || !folder) {
        vscode.window.showWarningMessage("rapid-docs: open a file first.");
        return;
      }
      if (editor.selection.isEmpty) {
        vscode.window.showWarningMessage("rapid-docs: select some code first.");
        return;
      }
      const repoPath = folder.uri.fsPath;
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      const start = editor.document.offsetAt(editor.selection.start);
      const end = editor.document.offsetAt(editor.selection.end);

      const staleRecord = deps.documentationService.findStaleRecordForSelection(repoPath, relativePath, start, end);
      if (!staleRecord) {
        vscode.window.showWarningMessage("rapid-docs: no partially-stale record found for this selection.");
        return;
      }

      const storage = deps.documentationService.loadStorage(repoPath, relativePath);
      const existingDocText = storage.records[staleRecord.recordId]?.docText ?? "";

      const panel = ComposePanel.openOrReveal(context, deps.documentationService, deps.highlightController, deps.refreshDocumentedSections, deps.activeEditorTracker);
      panel.beginDriftUpdate(staleRecord.recordId, relativePath, existingDocText);
    })
  );
}
