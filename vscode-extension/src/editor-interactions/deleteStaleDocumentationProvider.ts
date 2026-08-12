import * as vscode from "vscode";
import type { DocumentationService } from "../types";

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
  refreshDocumentedSections: () => Promise<void>
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

      const actions: vscode.CodeAction[] = [];
      for (const diagnostic of relevant) {
        const message = messages.find((m) => m.text === diagnostic.message && m.severity !== "info");
        if (!message || !message.recordId) continue;

        // Only offer this when NO selection could ever reach the record via
        // "Update documentation" instead -- message.ranges is the exact
        // same matchingRanges data findStaleRecordForSelection needs a
        // selection to overlap; empty here means empty there too, for
        // every possible selection, not just the one the diagnostic
        // happens to be anchored at. Error (fully-stale) records are
        // always empty here by construction (nothing survives to anchor
        // to at all) -- warning (partially-stale) ones are only empty when
        // genuinely orphaned, same as the real case that motivated this.
        // A normal, resolvable warning always has a real matchingRange (it's
        // what lets clicking it jump to the code at all), so it's
        // deliberately excluded here -- Update stays the right path for it,
        // not a competing Delete offer.
        if (message.ranges.length > 0) continue;

        // Several orphaned records can coincide at the same fallback
        // position (they all report an empty range, for the same reason),
        // so VSCode's lightbulb lists all of their actions together --
        // confirmed to genuinely confuse real testing: two entries titled
        // identically "Delete stale documentation" with no way to tell
        // which is which before clicking. A short recordId prefix is
        // enough to tell them apart in the list itself, without risking a
        // long docText cluttering the menu -- the real docText still gets
        // shown in full in the confirmation dialog below, where it
        // actually matters for deciding whether to delete.
        const shortId = message.recordId.slice(0, 8);
        const action = new vscode.CodeAction(`Delete stale documentation (${shortId})`, vscode.CodeActionKind.QuickFix);
        action.diagnostics = [diagnostic];
        action.command = {
          command: "rapidDocs.deleteStaleRecordFromDiagnostic",
          title: `Delete stale documentation (${shortId})`,
          arguments: [repoPath, relativePath, message.recordId],
        };
        actions.push(action);
      }
      return actions;
    },
  };

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      ["javascript", "javascriptreact", "typescript", "typescriptreact"],
      provider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rapidDocs.deleteStaleRecordFromDiagnostic",
      async (repoPath: string, relativePath: string, recordId: string) => {
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
        const docText = storage.records[recordId]?.docText;
        if (docText === undefined) return; // already gone, nothing to confirm

        const confirmed = await vscode.window.showWarningMessage(
          `Permanently delete this documentation? This cannot be undone.\n\n"${docText}"`,
          { modal: true },
          "Delete"
        );
        if (confirmed !== "Delete") return;

        try {
          documentationService.deleteRecord(repoPath, relativePath, recordId);
        } catch (err) {
          vscode.window.showErrorMessage(`rapid-docs: ${err instanceof Error ? err.message : String(err)}`);
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
