import * as vscode from "vscode";
import type { DocumentationService } from "../types";
import type { DocTextPreview } from "../webviews/shared/docTextPreview";
import type { ActivityLog } from "../activity/activityLog";

// The native Quick Fix for deleting a stale record -- VSCode hands
// provideCodeActions the actual vscode.Diagnostic objects at the cursor
// directly via context.diagnostics, closure-bound the same way Electron's
// own Problems row click was (onRowClick(item, key), renderer.js:1064), no
// reconstruction from a navigation event needed.
//
// Originally scoped to error (fully-stale) severity only, matching the one
// case Electron itself had no other way to resolve -- broadened to warning
// too after real manual testing produced an orphaned, partially-stale
// record with no exact-match selection and no stale-match selection either
// (both matchingRecord and staleRecord lookups require a real code
// selection to key off of; an orphan has none), meaning it could never be
// reached via the editor context menu's Edit/Update/Delete options, and
// never shows in Documented Sections either (findDocumentedNodes requires
// an exact full-span match, which an orphan doesn't have). This Quick Fix
// is the one remaining path back to it for either severity.
//
// Deliberately excludes info (undocumented) diagnostics -- there is no
// record at all behind one yet, nothing to delete.
export function registerDeleteStaleDocumentationProvider(
  context: vscode.ExtensionContext,
  documentationService: DocumentationService,
  refreshDocumentedSections: () => Promise<void>,
  docTextPreview: DocTextPreview,
  activityLog: ActivityLog
): void {
  const provider: vscode.CodeActionProvider = {
    provideCodeActions(document, _range, ctx) {
      const relevant = ctx.diagnostics.filter(
        (d) =>
          d.source === "rapid-docs" &&
          (d.severity === vscode.DiagnosticSeverity.Warning || d.severity === vscode.DiagnosticSeverity.Error)
      );
      if (relevant.length === 0) return [];

      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return [];
      const repoPath = folder.uri.fsPath;
      const relativePath = vscode.workspace.asRelativePath(document.uri, false).split(/[\\/]/).join("/");

      // Recomputed fresh, right here, at the moment the Quick Fix is
      // actually invoked -- the same "compute everything fresh,
      // synchronously" principle the editor context menu's QuickPick
      // already uses, not stale, pre-fetched state. matchingRanges alone
      // can't be trusted to correlate a diagnostic back to its record: an
      // orphan (or any record with no reliable anchor) reports an empty
      // range, and several such records could coincide at the same
      // fallback position -- text + severity is the same identity concept
      // dedupeMessages already uses to treat two messages as "the same"
      // within one file.
      const report = documentationService.checkFile(repoPath, relativePath);
      const messages = documentationService.generateMessages(repoPath, relativePath, report);

      // Only offer this when NO selection could ever reach the record via
      // "Update documentation" instead -- message.ranges is the exact same
      // matchingRanges data findStaleRecordForSelection needs a selection
      // to overlap; empty here means empty there too, for every possible
      // selection, not just the one the diagnostic happens to be anchored
      // at. Error (fully-stale) records are always empty here by
      // construction; warning (partially-stale) ones are only empty when
      // genuinely orphaned. A normal, resolvable warning always has a real
      // matchingRange (that's what lets clicking it jump to the code at
      // all), so it's excluded here -- Update stays the right path for it.
      const eligible = relevant.some((diagnostic) => {
        const message = messages.find((m) => m.text === diagnostic.message && m.severity !== "info");
        return message?.recordId && message.ranges.length === 0;
      });
      if (!eligible) return [];

      // ONE consolidated action, not one per colliding diagnostic -- real
      // user feedback: several orphaned records routinely coincide at the
      // same fallback position (that's what "orphaned" means), and a
      // lightbulb full of identically-titled entries was tedious and hard
      // to tell apart. The action opens a QuickPick (below) that lists
      // every real candidate with its actual docText, the same "compute
      // fresh, show a real list" pattern the editor context menu already
      // uses, rather than trying to cram N choices into N separate
      // lightbulb rows.
      const action = new vscode.CodeAction("Delete stale documentation...", vscode.CodeActionKind.QuickFix);
      action.diagnostics = relevant;
      action.command = {
        command: "rapidDocs.deleteStaleRecordFromDiagnostic",
        title: "Delete stale documentation...",
        arguments: [repoPath, relativePath],
      };
      return [action];
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      ["javascript", "javascriptreact", "typescript", "typescriptreact"],
      provider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  const previewButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("eye"),
    tooltip: "Preview full documentation",
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rapidDocs.deleteStaleRecordFromDiagnostic",
      async (repoPath: string, relativePath: string) => {
        // Recomputed fresh again, right here -- the QuickPick may be
        // invoked a moment after the lightbulb was shown, and this list
        // must reflect whatever's actually still true, not a snapshot
        // from when the Quick Fix was first offered.
        const report = documentationService.checkFile(repoPath, relativePath);
        const messages = documentationService.generateMessages(repoPath, relativePath, report);
        const candidates = messages.filter((m) => m.severity !== "info" && m.recordId && m.ranges.length === 0);
        if (candidates.length === 0) return;

        // Real docText as the label, not a hash or the drift-message
        // wrapper text -- the whole point raised in review was to actually
        // SEE what's about to be deleted while choosing, not just tell
        // entries apart by an opaque id. The eye-icon button (below) is
        // for the case docText itself is long/multi-line and doesn't fit
        // legibly on the QuickPick's own single label line -- click it to
        // open the full thing, well-formatted, in a real tab, without
        // losing your place in this list.
        const storageForList = documentationService.loadStorage(repoPath, relativePath);
        type Item = vscode.QuickPickItem & { recordId: string; docText: string };
        const items: Item[] = candidates.map((m) => {
          const docText = storageForList.records[m.recordId!]?.docText ?? "";
          // A QuickPick label is a single display line -- a raw multi-line
          // docText would render squashed/illegible there, exactly the
          // problem being solved. First line only, truncated, is enough to
          // recognize which one this is; the preview button is the real
          // way to read a long or multi-line one in full.
          const firstLine = docText.split("\n")[0] ?? "";
          const wasTruncated = docText.length > firstLine.length || firstLine.length > 60;
          const label = firstLine.length > 60 ? firstLine.slice(0, 60) + "…" : firstLine;
          return {
            label: (label || `(record ${m.recordId!.slice(0, 8)})`) + (wasTruncated ? " (…)" : ""),
            description: `(${m.severity})`,
            recordId: m.recordId!,
            docText,
            buttons: [previewButton],
          };
        });

        const picked = await new Promise<Item | undefined>((resolve) => {
          const quickPick = vscode.window.createQuickPick<Item>();
          quickPick.items = items;
          quickPick.placeholder = "Select the stale documentation to delete";
          quickPick.onDidTriggerItemButton((e) => {
            void docTextPreview.show(e.item.docText, e.item.recordId.slice(0, 8));
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

        // Real, user-identified risk this guards against: "orphaned" isn't
        // a permanent property of a record -- it's relative to whatever
        // ELSE is currently ambiguous, and can resolve on its own (e.g.
        // documenting a sibling function frees up the shared position pool
        // and can rescue an orphan with zero data loss, confirmed live
        // this session). Delete is the one irreversible action in this
        // whole flow -- Electron's own error-only Delete never had this
        // risk (a fully-stale record can never self-resolve), so this
        // confirmation exists specifically because broadening to warnings
        // introduced a real way to lose recoverable documentation with one
        // accidental click. Showing the actual docText, not just "are you
        // sure", is what lets someone recognize "wait, that's real content
        // I wrote" before it's gone for good.
        const storage = documentationService.loadStorage(repoPath, relativePath);
        const docText = storage.records[picked.recordId]?.docText;
        if (docText === undefined) return; // already gone, nothing to confirm

        // detail (not a crammed single message string) is what gives this
        // the same bold-title / lighter-secondary-paragraph structure
        // VSCode's own native confirm dialogs use (e.g. the file-delete
        // "you can restore this from the Recycle Bin" prompt) -- real user
        // feedback (2026-08-15) that the previous single-string version
        // looked flatter than VSCode's own dialogs, which this is the same
        // underlying native mechanism as, not a custom one.
        const confirmed = await vscode.window.showWarningMessage(
          "Permanently delete this documentation? This cannot be undone.",
          { modal: true, detail: `"${docText}"` },
          "Delete"
        );
        if (confirmed !== "Delete") return;

        try {
          documentationService.deleteRecord(repoPath, relativePath, picked.recordId);
          activityLog.success(`Deleted stale documentation. (${relativePath})`);
        } catch (err) {
          const errText = `${err instanceof Error ? err.message : String(err)} (${relativePath})`;
          activityLog.error(errText);
          vscode.window.showErrorMessage(`rapid-docs: ${errText}`);
          return;
        }
        // Native Problems updates on its own via the existing live-watch
        // path (deleteRecord changes .rapid-docs/<file>.json, which
        // deriveSourcePathFromStoragePath already catches) -- refreshed
        // explicitly here too anyway, matching the editor context menu's
        // own Delete action, so Documented Sections doesn't wait on watch
        // latency for something the user just did directly.
        await refreshDocumentedSections();
      }
    )
  );
}
