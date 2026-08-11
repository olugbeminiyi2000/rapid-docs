import * as vscode from "vscode";

// The single cross-cutting "at most one thing highlighted at a time" rule
// -- shared by Documented Sections (7.2), the click-inside-a-documented-
// region behavior (7.2), and diagnostic-click highlighting (7.1's decision).
// Matches Electron's own activeHighlight/toggleHighlight/toggleDocSection-
// Highlight (renderer.js:139, 742, 1089): real feedback there was that an
// always-on tint over every problem/documented region at once was noise,
// not help -- clicking a row/point toggles ONE highlight on, clicking the
// same one again turns it off, clicking a different one replaces it.
export type HighlightSeverity = "documented" | "warning" | "info" | "error";

export interface ActiveHighlight {
  key: string;
  ranges: vscode.Range[];
}

export interface HighlightController {
  toggle(key: string, severity: HighlightSeverity, ranges: vscode.Range[], editor: vscode.TextEditor): void;
  clear(editor: vscode.TextEditor | undefined): void;
  currentKey(): string | null;
  // Real bug found via manual testing: relying on
  // TextEditorSelectionChangeEvent.kind to distinguish "our own programmatic
  // reveal" from "a genuine user selection" didn't hold up -- a plain
  // editor.selection = ... assignment made from inside a WebviewView message
  // handler didn't reliably report kind:undefined the way a direct,
  // synchronous assignment does, so diagnosticClickHighlight's own
  // clear-on-unmatched-selection logic was wiping out the SAME highlight a
  // row-click had just set, moments after (self-inflicted: the first click
  // on a Documented Sections row visibly showed nothing, only a second click
  // -- on an unchanged selection, so no new event fired -- stuck). Suppression
  // driven by our OWN explicit intent, not inferred from event metadata, is
  // what actually fixes this: call suppressNextSelectionEvent() immediately
  // before any code sets editor.selection for its own reveal purposes, and
  // consumeSuppression() as the very first check in any listener that would
  // otherwise treat the resulting event as a genuine user action.
  suppressNextSelectionEvent(): void;
  consumeSuppression(): boolean;
}

export function createHighlightController(context: vscode.ExtensionContext): HighlightController {
  // documented reuses the decoration Section 6/7.1 already built and proved;
  // warning/info/error are new here, each a real, already-themed VSCode
  // color carrying the right semantic meaning on its own (validation
  // backgrounds), not an arbitrary pick -- so all four adapt automatically
  // to whatever theme (light/dark/high-contrast) the user has, same as
  // documentedDecorationType already did.
  const decorationTypes: Record<HighlightSeverity, vscode.TextEditorDecorationType> = {
    documented: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
    }),
    // opacity softens these three -- real feedback: the raw
    // inputValidation.*Background colors (designed for a thin form-field
    // strip, not a text-background wash over real code) read as too intense
    // ("much more lighter" requested) once applied across a whole span.
    // Still fully theme-driven, just toned down, not replaced with a
    // hardcoded color.
    // Real feedback (2026-08-11): neither editor.findMatchHighlightBackground
    // NOR editorWarning.foreground actually rendered as a real, recognizable
    // yellow in the user's theme -- confirmed by testing both, real
    // evidence, not assumed. Theme tokens are unreliable for "must look like
    // THIS specific yellow" (a bumblebee-style gold), so this is a
    // deliberate, disclosed exception to the "always theme-driven" approach
    // used for documented/info/error: a fixed hex color, not a ThemeColor.
    // Won't auto-adjust for light vs dark themes the way the other three do.
    warning: vscode.window.createTextEditorDecorationType({
      backgroundColor: "#FFC10766", // bumblebee-gold at ~40% alpha
      border: "1px solid",
      borderColor: "#FFC107", // full-strength, so the outline stays visible even under the native selection overlay
    }),
    // Real feedback (2026-08-11): should look like VSCode's own native
    // text-selection color (the light blue shown while dragging a
    // selection to write a new doc), not inputValidation.infoBackground --
    // editor.selectionBackground IS that exact color, designed by every
    // theme author specifically to sit well as an overlay tint over real
    // syntax-highlighted code, so no extra opacity needed on top of it.
    info: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
    }),
    error: vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor("inputValidation.errorBackground"),
      opacity: "0.5",
    }),
  };
  for (const type of Object.values(decorationTypes)) context.subscriptions.push(type);

  let active: (ActiveHighlight & { severity: HighlightSeverity }) | null = null;
  let suppressed = false;

  function applyToEditor(editor: vscode.TextEditor): void {
    for (const [severity, type] of Object.entries(decorationTypes) as [HighlightSeverity, vscode.TextEditorDecorationType][]) {
      const ranges = active && active.severity === severity ? active.ranges : [];
      editor.setDecorations(type, ranges);
    }
  }

  return {
    toggle(key, severity, ranges, editor) {
      active = active && active.key === key ? null : { key, severity, ranges };
      applyToEditor(editor);
    },
    clear(editor) {
      active = null;
      if (editor) applyToEditor(editor);
    },
    currentKey() {
      return active?.key ?? null;
    },
    suppressNextSelectionEvent() {
      suppressed = true;
    },
    consumeSuppression() {
      if (!suppressed) return false;
      suppressed = false;
      return true;
    },
  };
}
