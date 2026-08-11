import * as vscode from "vscode";

// Real bug found via manual testing: vscode.window.activeTextEditor becomes
// undefined the moment a WebviewPanel (Compose, in particular) takes focus
// -- which it always does the instant a user types into its textarea or
// clicks its submit button, since a webview isn't a text editor. Compose
// NEEDS to know which file/selection the user meant even after their click
// has already shifted focus away from it. Tracking the last REAL text
// editor that WAS active (and reading its live .selection at submit time,
// not a snapshot) is what actually solves this -- the underlying
// TextEditor object stays valid and its selection stays accurate even once
// it's no longer the "active" one.
export interface ActiveEditorTracker {
  getEditor(): vscode.TextEditor | undefined;
}

export function createActiveEditorTracker(context: vscode.ExtensionContext): ActiveEditorTracker {
  let lastRealEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) lastRealEditor = editor;
    })
  );

  return {
    getEditor: () => lastRealEditor,
  };
}
