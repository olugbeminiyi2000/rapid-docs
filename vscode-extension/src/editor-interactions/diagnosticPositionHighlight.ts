import * as vscode from "vscode";
import type { HighlightController, HighlightSeverity } from "../highlighting/highlightController";

// Closes the decision made in Section 7.1: VSCode's own native current-line
// highlight, on its own, wasn't visible enough after navigating to a
// diagnostic (real user feedback). This is deliberately a PURE POSITION
// CHECK, not an attempt to detect "was this click a Problems-row click" --
// that earlier approach (diagnosticClickHighlight.ts, removed) tried to
// reconstruct intent from an ambiguous selection-change event, which is
// exactly what caused real, repeated bugs (warning clicks silently doing
// nothing). The rule here is simpler and doesn't need to know HOW the
// cursor got somewhere: if the current position falls inside one of our
// own diagnostics' ranges, show its highlight; otherwise clear it. Works
// identically whether the cursor arrived via a Problems-panel click, arrow
// keys, or a direct click in the code.
//
// Deliberately does NOT touch editor.selection or call revealRange -- pure
// visual reaction to wherever the cursor already is, never repositioning
// it. That's the real difference from the click-inside-a-documented-region
// feature removed earlier in 7.2: THAT one actively re-selected the whole
// region on click, which is what fought against starting a new selection.
// This one only paints a decoration; the user's own selection is never
// touched, so it can't hijack a drag the same way.
const SEVERITY_FROM_DIAGNOSTIC: Partial<Record<vscode.DiagnosticSeverity, HighlightSeverity>> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
};

function diagnosticHighlightKey(uri: vscode.Uri, diagnostic: vscode.Diagnostic): string {
  return `diag:${uri.toString()}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.message}`;
}

export function registerDiagnosticPositionHighlight(context: vscode.ExtensionContext, highlightController: HighlightController): void {
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // Still needed: our OWN programmatic reveals (Documented Sections'
      // row click) set editor.selection directly, and that resulting event
      // must not be misread as "the cursor is now somewhere real" for THIS
      // listener either -- same suppression mechanism, same reason as before.
      if (highlightController.consumeSuppression()) return;

      const selection = event.selections[0];
      const position = selection?.active;
      if (!position) return;

      const editor = event.textEditor;
      const ourDiagnostics = vscode.languages.getDiagnostics(editor.document.uri).filter((d) => d.source === "rapid-docs");
      const match = ourDiagnostics.find((d) => d.range.contains(position));

      if (!match) {
        highlightController.clear(editor);
        return;
      }

      const severity = SEVERITY_FROM_DIAGNOSTIC[match.severity];
      if (!severity) return;

      highlightController.toggle(diagnosticHighlightKey(editor.document.uri, match), severity, [match.range], editor);
    })
  );
}
