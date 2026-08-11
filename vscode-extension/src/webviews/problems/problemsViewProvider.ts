import * as vscode from "vscode";
import type { DocumentationService, RapidDocsMessage } from "../../types";
import type { HighlightController } from "../../highlighting/highlightController";
import type { ActiveEditorTracker } from "../../editor-interactions/activeEditorTracker";
import { renderWebviewShell } from "../shared/webviewShell";

// Rebuilt 2026-08-11 as a real webview, not the native DiagnosticCollection
// alone -- the native Problems panel gives extensions no hook for "which
// exact message did the user click," forcing diagnosticClickHighlight.ts to
// reconstruct it after the fact by matching the resulting selection back
// against vscode.languages.getDiagnostics(), which is exactly the
// indirect, race-prone mechanism that caused real, repeated bugs (warning
// clicks silently doing nothing, wrong highlights). electron/renderer.js's
// own Problems tab (renderFileStatus/renderClearableRows, renderer.js:
// 1033-1139) never had this problem: each row's click handler is bound
// DIRECTLY to the message object already in memory via closure --
// `label.addEventListener("click", () => onRowClick(item, key))` -- no
// reconstruction needed. This webview replicates that exact mechanism: the
// extension host sends the real message list, the webview's own rows carry
// the message data directly, and clicking one posts that SAME data back --
// never re-derived from a VSCode-native navigation event.
//
// Native DiagnosticCollection (diagnosticsController.ts) is kept alongside
// this, unchanged -- it still drives the native Problems tab / squiggly
// underlines / click-to-navigate, which are real, free, valuable VSCode
// integration. This webview is specifically for the checkbox/clear/delete
// interactivity electron's own Problems tab had that native Diagnostics
// cannot provide at all.

function problemKey(message: RapidDocsMessage): string {
  return `${message.severity}::${message.text}`;
}

type FromWebviewMessage =
  | { type: "toggleHighlight"; message: RapidDocsMessage; key: string }
  | { type: "deleteRecord"; recordId: string; relativePath: string }
  | { type: "clearSelected"; keys: string[] }
  | { type: "clearAll" };

const ICON_DELETE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

const STYLE = `
  #toolbar { display: flex; justify-content: flex-end; gap: 4px; margin-bottom: 6px; }
  #toolbar button { padding: 2px 8px; font-size: 0.9em; }
  .row { display: flex; align-items: flex-start; gap: 6px; padding: 4px; border-bottom: 1px solid var(--vscode-widget-border, transparent); }
  .row.active { background: var(--vscode-list-activeSelectionBackground); }
  .row input[type=checkbox] { margin-top: 3px; }
  .row-text { flex: 1; }
  .row-text.clickable { cursor: pointer; }
  .badge { font-weight: bold; margin-right: 4px; }
  .badge.error { color: var(--vscode-errorForeground); }
  .badge.warning { color: var(--vscode-editorWarning-foreground, orange); }
  .badge.info { color: var(--vscode-editorInfo-foreground, var(--vscode-descriptionForeground)); }
  .icon-button { background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); padding: 2px; }
  .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-errorForeground); }
  .empty { color: var(--vscode-descriptionForeground); padding: 8px 4px; }
`;

export class ProblemsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "rapidDocsProblems";

  private webviewView: vscode.WebviewView | null = null;
  private allMessages: RapidDocsMessage[] = [];
  private currentRelativePath: string | null = null;
  // Client-side dismiss set -- matches electron/renderer.js's own
  // clearedProblemKeys exactly: "Clear" hides a message from THIS list
  // without touching the underlying record; if the real problem still
  // exists, the next live recheck reports it again, same key, and it just
  // silently re-appears -- that's the intended, disclosed behavior, not a bug.
  private readonly clearedKeysByFile = new Map<string, Set<string>>();

  constructor(
    private readonly documentationService: DocumentationService,
    private readonly highlightController: HighlightController,
    private readonly activeEditorTracker: ActiveEditorTracker,
    private readonly refreshDocumentedSections: () => Promise<void>
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.render();

    webviewView.webview.onDidReceiveMessage((message: FromWebviewMessage) => void this.handleMessage(message));

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.postCurrentFileMessages();
    });
  }

  // Called by diagnosticsController.ts's live-wiring with the SAME full
  // message list the native DiagnosticCollection receives -- one real
  // source of truth, two real consumers (native squiggles + this webview).
  setAllMessages(messages: RapidDocsMessage[]): void {
    this.allMessages = messages;
    this.postCurrentFileMessages();
  }

  setActiveFile(relativePath: string | null): void {
    this.currentRelativePath = relativePath;
    this.postCurrentFileMessages();
  }

  private postCurrentFileMessages(): void {
    if (!this.webviewView) return;
    const relativePath = this.currentRelativePath;
    const cleared = relativePath ? this.clearedKeysByFile.get(relativePath) ?? new Set<string>() : new Set<string>();
    const forThisFile = relativePath
      ? this.allMessages.filter((m) => m.relativePath === relativePath && !cleared.has(problemKey(m)))
      : [];
    void this.webviewView.webview.postMessage({ type: "setMessages", messages: forThisFile });
  }

  private async handleMessage(message: FromWebviewMessage): Promise<void> {
    if (message.type === "toggleHighlight") {
      // DIRECT: message.message is the exact object the row was rendered
      // from, sent back as-is -- no reconstruction against any VSCode API,
      // the actual fix for the class of bug that motivated this rebuild.
      const editor = this.activeEditorTracker.getEditor();
      if (!editor || message.message.ranges.length === 0) return;
      const range = new vscode.Range(
        editor.document.positionAt(message.message.ranges[0].start),
        editor.document.positionAt(message.message.ranges[0].end)
      );
      this.highlightController.suppressNextSelectionEvent();
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      this.highlightController.toggle(message.key, message.message.severity === "error" ? "error" : message.message.severity === "warning" ? "warning" : "info", [range], editor);
    } else if (message.type === "deleteRecord") {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      try {
        this.documentationService.deleteRecord(folder.uri.fsPath, message.relativePath, message.recordId);
      } catch (err) {
        vscode.window.showErrorMessage(`rapid-docs: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      await this.refreshDocumentedSections();
      // The record is gone, but the NOW-stale diagnostic for it will only
      // clear once live-watch's own recheck catches up (same real latency
      // already accepted throughout this project, not a new gap).
    } else if (message.type === "clearSelected") {
      const relativePath = this.currentRelativePath;
      if (!relativePath) return;
      const set = this.clearedKeysByFile.get(relativePath) ?? new Set<string>();
      for (const key of message.keys) set.add(key);
      this.clearedKeysByFile.set(relativePath, set);
      this.postCurrentFileMessages();
    } else if (message.type === "clearAll") {
      const relativePath = this.currentRelativePath;
      if (!relativePath) return;
      const set = this.clearedKeysByFile.get(relativePath) ?? new Set<string>();
      for (const m of this.allMessages) {
        if (m.relativePath === relativePath) set.add(problemKey(m));
      }
      this.clearedKeysByFile.set(relativePath, set);
      this.postCurrentFileMessages();
    }
  }

  private render(): void {
    if (!this.webviewView) return;
    this.webviewView.webview.html = renderWebviewShell({
      webview: this.webviewView.webview,
      title: "rapid-docs: Problems",
      extraStyle: STYLE,
      bodyHtml: `
        <div id="toolbar">
          <button id="clear-selected-button">Clear Selected</button>
          <button id="clear-all-button">Clear All</button>
        </div>
        <div id="list"></div>
      `,
      scriptJs: `
        const ICON_DELETE = ${JSON.stringify(ICON_DELETE)};
        const listEl = document.getElementById('list');
        let messages = [];
        const selectedKeys = new Set();

        function problemKey(m) { return m.severity + '::' + m.text; }

        function render() {
          if (messages.length === 0) {
            listEl.innerHTML = '<div class="empty">No issues detected in this file.</div>';
            return;
          }
          listEl.innerHTML = '';
          for (const item of messages) {
            const key = problemKey(item);
            const row = document.createElement('div');
            row.className = 'row';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selectedKeys.has(key);
            checkbox.addEventListener('change', () => {
              if (checkbox.checked) selectedKeys.add(key); else selectedKeys.delete(key);
            });
            row.appendChild(checkbox);

            const textEl = document.createElement('span');
            textEl.className = 'row-text' + (item.ranges.length > 0 ? ' clickable' : '');
            textEl.innerHTML = '<span class="badge ' + item.severity + '">[' + item.severity + ']</span>';
            textEl.appendChild(document.createTextNode(item.text));
            if (item.ranges.length > 0) {
              // item captured directly in this closure -- the whole point
              // of this rebuild, matches electron/renderer.js's own
              // onRowClick(item, key) exactly, no re-derivation.
              textEl.addEventListener('click', () => {
                vscode.postMessage({ type: 'toggleHighlight', message: item, key });
              });
            }
            row.appendChild(textEl);

            // Restricted to error severity + a real recordId, same as
            // electron/renderer.js's own deleteAction gating (renderer.js:
            // 1070) -- a partially-stale (warning) record is still real,
            // accurate content worth updating, not deleting.
            if (item.severity === 'error' && item.recordId) {
              const deleteButton = document.createElement('button');
              deleteButton.className = 'icon-button';
              deleteButton.title = 'Delete documentation';
              deleteButton.innerHTML = ICON_DELETE;
              deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'deleteRecord', recordId: item.recordId, relativePath: item.relativePath });
              });
              row.appendChild(deleteButton);
            }

            listEl.appendChild(row);
          }
        }

        document.getElementById('clear-selected-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'clearSelected', keys: [...selectedKeys] });
          selectedKeys.clear();
        });
        document.getElementById('clear-all-button').addEventListener('click', () => {
          vscode.postMessage({ type: 'clearAll' });
          selectedKeys.clear();
        });

        window.addEventListener('message', (event) => {
          const message = event.data;
          if (message.type === 'setMessages') {
            messages = message.messages;
            render();
          }
        });

        render();
      `,
    });
  }
}
