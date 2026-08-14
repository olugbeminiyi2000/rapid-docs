import * as vscode from "vscode";

// Section 7.6: matches electron/renderer.js's own addActivityEntry exactly
// in SCOPE (every hint/success/error this extension's real actions produce,
// not a narrowed subset) but not in mechanism -- Electron's Activity tab was
// a custom, checkbox-select-able list with its own Clear Selected/Clear All
// UI, but real code-reading (renderClearableRows' own call site for
// Activity, renderer.js:1142) confirmed it was NEVER click-to-navigate
// (onRowClick was never passed for Activity, only for Problems), so the one
// thing a custom Webview would add over a native mechanism was per-entry
// selective clearing -- already discussed and dropped once before, for the
// exact same reasoning, when Problems was rebuilt native-only. A
// LogOutputChannel (the same panel GROUP as Problems/Terminal/Debug
// Console, selectable via that panel's own dropdown) gives severity-colored,
// automatically-timestamped lines and a native "Clear Output" button for
// free, with zero custom UI -- strictly more capable than Electron's own
// plain-text badge for the "read it, clear it" use case this actually is.
export interface ActivityLog {
  hint(text: string): void;
  success(text: string): void;
  error(text: string): void;
}

export function createActivityLog(context: vscode.ExtensionContext): ActivityLog {
  const channel = vscode.window.createOutputChannel("rapid-docs: Activity", { log: true });
  context.subscriptions.push(channel);
  return {
    // warn/info/error, not three custom badge colors -- native severity
    // coloring, automatic per-line timestamps, for the same three tiers
    // Electron's own addActivityEntry(severity, text) used.
    hint: (text) => channel.warn(text),
    success: (text) => channel.info(text),
    error: (text) => channel.error(text),
  };
}
