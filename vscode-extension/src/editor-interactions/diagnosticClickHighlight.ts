import * as vscode from "vscode";
import type { HighlightController, HighlightSeverity } from "../highlighting/highlightController";

// Closes the decision made in Section 7.1: VSCode's own native current-line
// highlight, on its own, wasn't visible enough after jumping to a
// diagnostic (real user feedback). Matches electron/renderer.js's own
// toggleHighlight (renderer.js:1089): clicking a Problems row selects +
// reveals the exact range AND toggles a severity-tinted decoration on it,
// through the SAME shared highlightController every other highlight in this
// extension uses (only one thing highlighted at a time, across Documented
// Sections and Problems alike).
//
// Detection: rather than duplicating a parallel cache of "what diagnostics
// currently exist," this reads VSCode's own authoritative
// languages.getDiagnostics(uri) and checks whether the CURRENT selection
// exactly matches one of our own (source === "rapid-docs") diagnostics'
// ranges -- the same "exact range match as the trigger signal" reasoning
// electron/renderer.js used, since a real, coincidental match between an
// arbitrary manual selection and one of our diagnostic ranges is
// vanishingly unlikely.
const SEVERITY_FROM_DIAGNOSTIC: Partial<Record<vscode.DiagnosticSeverity, HighlightSeverity>> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
};

function diagnosticHighlightKey(uri: vscode.Uri, diagnostic: vscode.Diagnostic): string {
  return `diag:${uri.toString()}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
}

export function registerDiagnosticClickHighlight(context: vscode.ExtensionContext, highlightController: HighlightController): void {
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // Checked FIRST, before anything else: any code that programmatically
      // sets editor.selection for its own reveal purposes (Documented
      // Sections' row click, in particular) calls
      // highlightController.suppressNextSelectionEvent() right before doing
      // so -- consuming that here is what stops the resulting event from
      // being misread as a genuine, unrelated user action. Real bug found
      // via manual testing: relying on event.kind === undefined to detect
      // "this was our own programmatic change" alone wasn't reliable coming
      // from inside a WebviewView message-handler callback, which let this
      // listener's own clear-on-unmatched-selection logic (below) wipe out
      // a row-click's "documented" highlight moments after it was set --
      // the first click on a row visibly showed nothing, only a second
      // click (on an unchanged selection, so no new event fired at all) stuck.
      if (highlightController.consumeSuppression()) return;

      const selection = event.selections[0];
      if (!selection || selection.isEmpty) return;

      const editor = event.textEditor;
      const ourDiagnostics = vscode.languages.getDiagnostics(editor.document.uri).filter((d) => d.source === "rapid-docs");
      const match = ourDiagnostics.find((d) => d.range.isEqual(selection));

      if (!match) {
        // Real feedback (2026-08-11): a highlight left over from an earlier
        // diagnostic click stayed painted while starting a brand-new,
        // unrelated manual selection (e.g. to write a new doc) -- looked
        // like part of the new selection, but was really just stale state
        // from something else entirely. Any real, user-driven selection
        // that doesn't itself match a diagnostic clears whatever highlight
        // is currently showing, so nothing lingers past the moment it
        // stopped being relevant.
        highlightController.clear(editor);
        return;
      }

      const severity = SEVERITY_FROM_DIAGNOSTIC[match.severity];
      if (!severity) return;

      highlightController.toggle(diagnosticHighlightKey(editor.document.uri, match), severity, [match.range], editor);
    })
  );
}
