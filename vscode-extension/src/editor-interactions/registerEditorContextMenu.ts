import * as vscode from "vscode";
import type { DocumentationService } from "../types";
import { ComposePanel } from "../webviews/compose/composePanel";
import type { HighlightController } from "../highlighting/highlightController";
import type { ActiveEditorTracker } from "./activeEditorTracker";

export interface EditorContextMenuDeps {
  documentationService: DocumentationService;
  activeEditorTracker: ActiveEditorTracker;
  highlightController: HighlightController;
  refreshDocumentedSections: () => Promise<void>;
}

interface ActionItem extends vscode.QuickPickItem {
  run: () => void | Promise<void>;
}

// Rebuilt 2026-08-11 to actually replicate electron/renderer.js's real
// context-menu mechanism (renderer.js:334-395), not just imitate its look.
// Electron computed the ENTIRE menu -- matchingRecord, staleRecord, the
// resulting item list -- fresh, synchronously (well, awaited, but BEFORE
// anything was ever shown), directly inside the contextmenu DOM handler.
// There was no pre-computed state to go stale, because nothing was ever
// pre-computed.
//
// The first version of this built a declarative VSCode `editor/context`
// menu gated by a context key (selectionContextKey.ts) that had to be kept
// updated reactively, ahead of time -- a structurally different, race-prone
// model that caused real, repeated bugs (stale menu items showing the wrong
// action for the current selection) no amount of narrowing the update
// timing could fully close, since VSCode's own setContext dispatch has
// latency outside our control.
//
// This version has exactly ONE static menu contribution (always visible
// while a real text editor has focus, no context key involved at all) that
// opens a QuickPick built from a computation run fresh, at that exact
// moment -- the direct VSCode equivalent of Electron's showContextMenu,
// closing the race entirely rather than narrowing it.
export function registerEditorContextMenu(context: vscode.ExtensionContext, deps: EditorContextMenuDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.showEditorActions", async () => {
      // vscode.window.activeTextEditor, not the tracker -- this command can
      // only ever run while the mouse is physically on the code editor
      // (that's what "editor/context" means), so the editor genuinely has
      // focus at this exact moment. The tracker exists specifically for
      // commands invoked from INSIDE a webview (Compose, Documented
      // Sections), where activeTextEditor goes stale because the webview
      // itself has focus instead -- a different, real problem that doesn't
      // apply here.
      const editor = vscode.window.activeTextEditor;
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!editor || !folder || editor.selection.isEmpty) return;

      const repoPath = folder.uri.fsPath;
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      const start = editor.document.offsetAt(editor.selection.start);
      const end = editor.document.offsetAt(editor.selection.end);

      // Fresh, synchronous, right here -- matches electron/renderer.js's
      // own matchingRecord/staleRecord computation exactly, including the
      // order (exact match checked first; stale only checked if there
      // wasn't one, since a drifted record's hash can never equal a fresh
      // computation over current code again -- renderer.js:344-349).
      const matchingRecord = deps.documentationService.findRecordForSelection(repoPath, relativePath, start, end);
      const staleRecord = matchingRecord
        ? null
        : deps.documentationService.findStaleRecordForSelection(repoPath, relativePath, start, end);

      const items: ActionItem[] = [];

      if (matchingRecord) {
        items.push({
          label: "Edit documentation",
          // Opens the same spacious Compose panel writing new docs already
          // uses, pre-filled with the existing text -- replaces the old
          // redirect into Documented Sections' own (now-removed) inline
          // <input> edit, a cramped, bad fit for anything long or
          // multi-line. No DOM to reuse anymore; this IS the real surface.
          run: () => {
            const panel = ComposePanel.openOrReveal(
              context,
              deps.documentationService,
              deps.highlightController,
              deps.refreshDocumentedSections,
              deps.activeEditorTracker
            );
            panel.beginEditRecord(matchingRecord.recordId, relativePath, matchingRecord.docText);
          },
        });
        items.push({
          label: "Delete documentation",
          run: async () => {
            try {
              deps.documentationService.deleteRecord(repoPath, relativePath, matchingRecord.recordId);
            } catch (err) {
              vscode.window.showErrorMessage(`rapid-docs: ${err instanceof Error ? err.message : String(err)}`);
              return;
            }
            await deps.refreshDocumentedSections();
          },
        });
      } else {
        if (staleRecord) {
          items.push({
            label: "Update documentation (code changed)",
            run: () => {
              const panel = ComposePanel.openOrReveal(
                context,
                deps.documentationService,
                deps.highlightController,
                deps.refreshDocumentedSections,
                deps.activeEditorTracker
              );
              panel.beginDriftUpdate(staleRecord.recordId, relativePath, staleRecord.docText);
            },
          });
        }
        items.push({
          label: "Document selection",
          run: () => {
            const panel = ComposePanel.openOrReveal(
              context,
              deps.documentationService,
              deps.highlightController,
              deps.refreshDocumentedSections,
              deps.activeEditorTracker
            );
            panel.resetToFresh();
          },
        });
      }

      if (items.length === 0) return;

      const picked = await vscode.window.showQuickPick(items, { placeHolder: "rapid-docs" });
      await picked?.run();
    })
  );
}
