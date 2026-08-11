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
  // Real feature command -- 7.4's "Document selection" QuickPick item calls
  // this same open/reveal path, not a separate one.
  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.openCompose", () => {
      // resetToFresh() matters here too, not just from the context menu's
      // own redirect path -- reusing an existing panel that was still
      // showing leftover drift-update state (button/text from an earlier,
      // unrelated action) must not carry that state into a new, unrelated
      // "document selection" session.
      const panel = ComposePanel.openOrReveal(context, deps.documentationService, deps.highlightController, deps.refreshDocumentedSections, deps.activeEditorTracker);
      panel.resetToFresh();
    })
  );

  // rapidDocs.testBeginDriftUpdate was a deliberately temporary stand-in for
  // 7.4's real "Update documentation (code changed)" trigger, removed
  // 2026-08-11 now that registerEditorContextMenu.ts's QuickPick calls
  // beginDriftUpdate() directly for real.
}
