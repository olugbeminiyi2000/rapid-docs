import * as vscode from "vscode";
import type { DocumentationService } from "../../types";
import type { HighlightController } from "../../highlighting/highlightController";
import type { ActiveEditorTracker } from "../../editor-interactions/activeEditorTracker";
import { renderWebviewShell } from "../shared/webviewShell";

// Set only by "Update documentation (code changed)" (7.4's context menu,
// temporarily reachable via rapidDocs.testBeginDriftUpdate until then) --
// redirects the NEXT compose submission to updateDriftedDoc (replace the
// old, drifted record) instead of writeDoc (create a new, unrelated one).
// null the rest of the time, which is what keeps "Document Selection"
// behaving exactly as normal for the ordinary, no-drift-involved case.
// Matches electron/renderer.js's own pendingDriftUpdate (renderer.js:129).
interface PendingDriftUpdate {
  oldRecordId: string;
  relativePath: string;
}

type FromWebviewMessage = { type: "submit"; text: string };

const STYLE = `
  body { display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  textarea { flex: 1; resize: none; margin-bottom: 8px; }
  /* Real feedback: status must be immediately visible, above the action
     that produces it -- not buried below the button where it's easy to miss. */
  #status { margin-bottom: 6px; min-height: 1.2em; }
  #status.error { color: var(--vscode-errorForeground); }
  #status.success { color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground)); }
  #status.hint { color: var(--vscode-descriptionForeground); }
`;

export class ComposePanel {
  private static instance: ComposePanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private pendingDriftUpdate: PendingDriftUpdate | null = null;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly documentationService: DocumentationService,
    private readonly highlightController: HighlightController,
    private readonly refreshDocumentedSections: () => Promise<void>,
    private readonly activeEditorTracker: ActiveEditorTracker
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "rapidDocsCompose",
      "rapid-docs: Compose",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    context.subscriptions.push(this.panel);
    this.panel.onDidDispose(() => {
      if (ComposePanel.instance === this) ComposePanel.instance = null;
    });
    this.render();
    this.panel.webview.onDidReceiveMessage((message: FromWebviewMessage) => void this.handleMessage(message));
  }

  // Reuses the same panel/tab rather than spawning a new one each time --
  // per the 2026-08-11 decision, this lives beside the editor precisely so
  // code and compose stay visible together, which only works if there's
  // ever just the one panel.
  static openOrReveal(
    context: vscode.ExtensionContext,
    documentationService: DocumentationService,
    highlightController: HighlightController,
    refreshDocumentedSections: () => Promise<void>,
    activeEditorTracker: ActiveEditorTracker
  ): ComposePanel {
    if (ComposePanel.instance) {
      ComposePanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return ComposePanel.instance;
    }
    ComposePanel.instance = new ComposePanel(context, documentationService, highlightController, refreshDocumentedSections, activeEditorTracker);
    return ComposePanel.instance;
  }

  beginDriftUpdate(oldRecordId: string, relativePath: string, existingDocText: string): void {
    this.pendingDriftUpdate = { oldRecordId, relativePath };
    void this.panel.webview.postMessage({ type: "beginDriftUpdate", docText: existingDocText });
  }

  private clearDriftUpdateMode(): void {
    this.pendingDriftUpdate = null;
    void this.panel.webview.postMessage({ type: "clearDriftUpdateMode" });
  }

  private render(): void {
    this.panel.webview.html = renderWebviewShell({
      webview: this.panel.webview,
      title: "rapid-docs: Compose",
      extraStyle: STYLE,
      bodyHtml: `
        <textarea id="doc-text" placeholder="Select some code in the file, then describe it here..."></textarea>
        <div id="status"></div>
        <button id="submit-button">Document Selection</button>
      `,
      scriptJs: `
        const textEl = document.getElementById('doc-text');
        const buttonEl = document.getElementById('submit-button');
        const statusEl = document.getElementById('status');
        let statusClearTimeout = null;

        buttonEl.addEventListener('click', () => {
          vscode.postMessage({ type: 'submit', text: textEl.value });
        });

        window.addEventListener('message', (event) => {
          const message = event.data;
          if (message.type === 'beginDriftUpdate') {
            textEl.value = message.docText;
            buttonEl.textContent = 'Update Documentation';
            textEl.focus();
          } else if (message.type === 'clearDriftUpdateMode') {
            buttonEl.textContent = 'Document Selection';
          } else if (message.type === 'submitResult') {
            if (statusClearTimeout) clearTimeout(statusClearTimeout);
            statusEl.textContent = message.text;
            statusEl.className = message.severity;
            if (message.severity === 'success') {
              textEl.value = '';
              // Matches electron/renderer.js's own setStatus(autoClearMs)
              // design exactly: success fades on its own since the real
              // confirmation (the new row in Documented Sections) is
              // already visible elsewhere; hints/errors stay put until the
              // user actually does something about them.
              statusClearTimeout = setTimeout(() => {
                statusEl.textContent = '';
                statusEl.className = '';
              }, 4000);
            }
          }
        });
      `,
    });
  }

  private async handleMessage(message: FromWebviewMessage): Promise<void> {
    if (message.type !== "submit") return;

    // NOT vscode.window.activeTextEditor -- clicking anything inside this
    // panel (a webview, not a text editor) shifts VSCode's own focus away
    // from the source file, so by the time this message handler runs,
    // activeTextEditor is undefined even though a file genuinely IS open
    // with a real selection. Real bug found via manual testing: this
    // reported "Open a file first." on every submit. The tracker's
    // TextEditor object stays valid and its .selection stays live-accurate
    // even after it stops being VSCode's "active" one.
    const editor = this.activeEditorTracker.getEditor();
    const folder = vscode.workspace.workspaceFolders?.[0];
    const status = (text: string, severity: "hint" | "error" | "success") =>
      void this.panel.webview.postMessage({ type: "submitResult", text, severity });

    if (!editor || !folder) {
      status("Open a file first.", "hint");
      return;
    }
    // One-shot: whatever the outcome, this specific pending update is
    // consumed right here, so a later, unrelated "Document Selection"
    // submission can never accidentally be redirected into updating some
    // earlier drifted record it was never actually about. Matches
    // electron/renderer.js's own reasoning (renderer.js:954-959) exactly.
    const driftUpdate = this.pendingDriftUpdate;
    this.clearDriftUpdateMode();

    const repoPath = folder.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const start = editor.document.offsetAt(editor.selection.start);
    const end = editor.document.offsetAt(editor.selection.end);

    if (!driftUpdate && start === end) {
      status(`Select some code in the file above first. (${relativePath})`, "hint");
      return;
    }
    if (!message.text.trim()) {
      status(`Enter some documentation text first. (${relativePath})`, "hint");
      return;
    }

    try {
      if (driftUpdate) {
        this.documentationService.updateDriftedDoc(repoPath, driftUpdate.relativePath, driftUpdate.oldRecordId, start, end, message.text);
        status(`Updated documentation for changed code. (${driftUpdate.relativePath})`, "success");
      } else {
        this.documentationService.writeDoc(repoPath, relativePath, start, end, message.text);
        status(`Documented. (${relativePath})`, "success");
      }
      // A highlight still showing from an earlier action (e.g. the
      // now-stale diagnostic for the selection just documented) must not
      // linger past the point it stopped being accurate.
      this.highlightController.clear(editor);
      await this.refreshDocumentedSections();
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Same friendly-error mapping electron/renderer.js's own
      // friendlyErrorMessage used (renderer.js:900-913) for this exact case.
      const friendly = /already documented as record/.test(rawMessage)
        ? "This is already documented. Use the Edit button to change its text."
        : rawMessage;
      status(`${friendly} (${relativePath})`, "error");
    }
  }
}
