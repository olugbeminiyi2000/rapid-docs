import * as vscode from "vscode";
import type { DocumentationService } from "../types";
import { ComposePanel } from "../webviews/compose/composePanel";
import type { HighlightController } from "../highlighting/highlightController";
import type { ActiveEditorTracker } from "./activeEditorTracker";
import type { DocTextPreview } from "../webviews/shared/docTextPreview";
import type { ActivityLog } from "../activity/activityLog";
import { formatDisplayPath } from "./displayPath";

export interface EditorContextMenuDeps {
  documentationService: DocumentationService;
  activeEditorTracker: ActiveEditorTracker;
  highlightController: HighlightController;
  refreshDocumentedSections: () => Promise<void>;
  refreshArchive: () => Promise<void>;
  docTextPreview: DocTextPreview;
  activityLog: ActivityLog;
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
      // getWorkspaceFolder(uri), not workspaceFolders?.[0] -- multi-root
      // support (2026-08-15): the correct root is whichever one actually
      // CONTAINS this file, not always the first folder in the workspace.
      const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
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
          run: async () => {
            const panel = ComposePanel.openOrReveal(
              context,
              deps.documentationService,
              deps.highlightController,
              deps.refreshDocumentedSections,
              deps.activeEditorTracker,
              deps.activityLog
            );
            await panel.beginEditRecord(matchingRecord.recordId, relativePath, repoPath, matchingRecord.docText);
          },
        });
        items.push({
          label: "Delete documentation",
          run: async () => {
            // Same data-loss-prevention pattern as Documented Sections' own
            // delete button -- the same deleteRecord call, reached by a
            // second UI path, deserves the same guard rather than a weaker
            // one just because it's a menu item instead of an icon.
            const confirmed = await vscode.window.showWarningMessage(
              "Permanently delete this documentation? This cannot be undone.",
              { modal: true, detail: `"${matchingRecord.docText}"` },
              "Delete"
            );
            if (confirmed !== "Delete") return;

            // formatDisplayPath, not the bare relativePath -- multi-root
            // support (2026-08-15): shows which folder this is in, once
            // there's more than one open.
            const displayPath = formatDisplayPath(repoPath, relativePath);
            try {
              deps.documentationService.deleteRecord(repoPath, relativePath, matchingRecord.recordId);
              deps.activityLog.success(`Deleted documentation. (${displayPath})`);
            } catch (err) {
              const message = `${err instanceof Error ? err.message : String(err)} (${displayPath})`;
              deps.activityLog.error(message);
              vscode.window.showErrorMessage(`rapid-docs: ${message}`);
              return;
            }
            await deps.refreshDocumentedSections();
          },
        });
      } else {
        if (staleRecord) {
          items.push({
            label: "Update documentation (code changed)",
            run: async () => {
              const panel = ComposePanel.openOrReveal(
                context,
                deps.documentationService,
                deps.highlightController,
                deps.refreshDocumentedSections,
                deps.activeEditorTracker,
                deps.activityLog
              );
              // start/end captured HERE, at the moment this menu item is
              // chosen -- see PendingDriftUpdate's own header for the real
              // bug this fixes (submit used to re-read whatever was
              // selected at CLICK time instead, silently misattaching the
              // update if the selection changed in between).
              await panel.beginDriftUpdate(staleRecord.recordId, relativePath, repoPath, start, end, staleRecord.docText);
            },
          });
        }
        items.push({
          label: "Document selection",
          run: async () => {
            const panel = ComposePanel.openOrReveal(
              context,
              deps.documentationService,
              deps.highlightController,
              deps.refreshDocumentedSections,
              deps.activeEditorTracker,
              deps.activityLog
            );
            // Same capture-at-open fix as Update documentation above --
            // start/end are already known here (the menu never even shows
            // without a real, non-empty selection).
            await panel.beginFreshWrite(repoPath, relativePath, start, end);
          },
        });

        // Only offered when there's actually something to attach -- an
        // empty archive would just be a dead-end menu entry. Section 7.5:
        // reuses the exact "createQuickPick + preview eye-icon button"
        // pattern the delete-stale-documentation Quick Fix already proved,
        // rather than inventing Electron's separate "Attach here" bar --
        // one selection, one selection here, one attach action for it.
        const archive = deps.documentationService.loadArchive(repoPath);
        if (archive.length > 0) {
          items.push({
            label: "Attach archived record...",
            run: async () => {
              type Item = vscode.QuickPickItem & { archiveId: string; docText: string };
              const previewButton: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon("eye"),
                tooltip: "Preview full documentation",
              };
              const pickerItems: Item[] = archive.map((entry) => {
                const firstLine = entry.docText.split("\n")[0] ?? "";
                const wasTruncated = entry.docText.length > firstLine.length || firstLine.length > 60;
                const label = firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
                return {
                  label: (label || `(archived ${entry.id.slice(0, 8)})`) + (wasTruncated ? " (…)" : ""),
                  description: `from ${entry.originalFileId}`,
                  archiveId: entry.id,
                  docText: entry.docText,
                  buttons: [previewButton],
                };
              });

              const picked = await new Promise<Item | undefined>((resolve) => {
                const quickPick = vscode.window.createQuickPick<Item>();
                quickPick.items = pickerItems;
                quickPick.placeholder = "Select an archived record to attach to this selection";
                quickPick.onDidTriggerItemButton((e) => {
                  void deps.docTextPreview.show(e.item.docText, e.item.archiveId.slice(0, 8));
                });
                quickPick.onDidAccept(() => {
                  resolve(quickPick.selectedItems[0]);
                  quickPick.hide();
                });
                quickPick.onDidHide(() => {
                  resolve(undefined);
                  quickPick.dispose();
                });
                quickPick.show();
              });
              if (!picked) return;

              // formatDisplayPath, not the bare relativePath -- multi-root
              // support (2026-08-15): shows which folder this is in, once
              // there's more than one open.
              const attachDisplayPath = formatDisplayPath(repoPath, relativePath);
              try {
                deps.documentationService.attachArchivedRecord(repoPath, picked.archiveId, relativePath, start, end);
                deps.activityLog.success(`Attached archived documentation. (${attachDisplayPath})`);
              } catch (err) {
                const message = `${err instanceof Error ? err.message : String(err)} (${attachDisplayPath})`;
                deps.activityLog.error(message);
                vscode.window.showErrorMessage(`rapid-docs: ${message}`);
                return;
              }
              await deps.refreshDocumentedSections();
              await deps.refreshArchive();
            },
          });
        }
      }

      if (items.length === 0) return;

      const picked = await vscode.window.showQuickPick(items, { placeHolder: "rapid-docs" });
      await picked?.run();
    })
  );
}
