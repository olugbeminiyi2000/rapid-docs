import * as vscode from "vscode";
import type { DocumentationService, ArchiveEntry } from "../../types";
import type { DocTextPreview } from "../shared/docTextPreview";
import type { ActivityLog } from "../../activity/activityLog";
import { renderWebviewShell } from "../shared/webviewShell";

// Unlike Documented Sections, the archive is NOT scoped to the currently
// open file -- loadArchive(repoPath) returns every archived record
// project-wide (a documented file can be deleted, or a record discarded,
// from anywhere), so this view has no dependency on activeEditorTracker at
// all, and refresh() never goes blank just because focus moved to a
// non-editor panel.
type FromWebviewMessage = { type: "preview"; archiveId: string } | { type: "discard"; archiveId: string };

const ICON_DISCARD =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
// Same eye glyph docTextPreview's other two callers (Documented Sections,
// the delete-stale-documentation QuickPick) already use -- kept visually
// consistent rather than picking a new icon for a third place that needs
// the exact same "show the full thing" affordance.
const ICON_PREVIEW =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';

const STYLE = `
  .row { border-bottom: 1px solid var(--vscode-widget-border, transparent); padding: 6px 4px; }
  .row-header { display: flex; justify-content: space-between; align-items: center; }
  .origin { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .text { margin-top: 2px; white-space: pre-wrap; word-break: break-word; }
  .row-actions { display: flex; gap: 2px; }
  .icon-button {
    background: transparent;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    padding: 2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
  }
  .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .icon-button.danger:hover { color: var(--vscode-errorForeground); }
  .empty { color: var(--vscode-descriptionForeground); padding: 8px 4px; }
`;

export class ArchiveViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "rapidDocsArchive";

  private webviewView: vscode.WebviewView | null = null;
  private items: ArchiveEntry[] = [];

  constructor(
    private readonly documentationService: DocumentationService,
    private readonly docTextPreview: DocTextPreview,
    private readonly activityLog: ActivityLog
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.render();

    webviewView.webview.onDidReceiveMessage((message: FromWebviewMessage) => {
      void this.handleMessage(message);
    });

    // Same "a WebviewView only resolves the first time it's actually
    // opened" fix Documented Sections needed -- re-refresh on every
    // visibility change, not just once at activation.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.refresh();
    });
    void this.refresh();
  }

  private render(): void {
    if (!this.webviewView) return;
    this.webviewView.webview.html = renderWebviewShell({
      webview: this.webviewView.webview,
      title: "rapid-docs: Archive",
      extraStyle: STYLE,
      bodyHtml: `<div id="list"></div>`,
      scriptJs: `
        const ICON_DISCARD = ${JSON.stringify(ICON_DISCARD)};
        const ICON_PREVIEW = ${JSON.stringify(ICON_PREVIEW)};
        const listEl = document.getElementById('list');
        let items = [];

        function render() {
          if (items.length === 0) {
            listEl.innerHTML = '<div class="empty">Nothing archived.</div>';
            return;
          }
          listEl.innerHTML = '';
          for (const item of items) {
            const row = document.createElement('div');
            row.className = 'row';
            const truncated = item.docText.length > 60 ? item.docText.slice(0, 60) + '...' : item.docText;
            row.innerHTML =
              '<div class="row-header">' +
                '<span class="origin"></span>' +
                '<span class="row-actions">' +
                  '<button class="icon-button preview" title="Preview full documentation">' + ICON_PREVIEW + '</button>' +
                  '<button class="icon-button danger discard" title="Discard permanently">' + ICON_DISCARD + '</button>' +
                '</span>' +
              '</div>' +
              '<div class="text"></div>';
            row.querySelector('.origin').textContent = item.originalFileId;
            row.querySelector('.text').textContent = truncated || '(no text)';

            row.querySelector('.preview').addEventListener('click', () => {
              vscode.postMessage({ type: 'preview', archiveId: item.id });
            });
            row.querySelector('.discard').addEventListener('click', () => {
              vscode.postMessage({ type: 'discard', archiveId: item.id });
            });

            listEl.appendChild(row);
          }
        }

        window.addEventListener('message', (event) => {
          const message = event.data;
          if (message.type === 'setItems') {
            items = message.items;
            render();
          }
        });

        render();
      `,
    });
  }

  private async handleMessage(message: FromWebviewMessage): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const repoPath = folder.uri.fsPath;

    if (message.type === "preview") {
      const item = this.items.find((i) => i.id === message.archiveId);
      if (!item) return;
      await this.docTextPreview.show(item.docText, item.id.slice(0, 8));
    } else if (message.type === "discard") {
      const item = this.items.find((i) => i.id === message.archiveId);
      if (!item) return;
      // Same data-loss-prevention pattern as the delete-stale-documentation
      // Quick Fix -- discard is permanent, and showing the real docText
      // (not just "are you sure") is what lets someone recognize "wait,
      // that's real content" before it's gone for good. detail (not a
      // crammed single string) gives it the same bold-title/lighter-detail
      // structure VSCode's own native confirm dialogs use.
      const confirmed = await vscode.window.showWarningMessage(
        "Permanently discard this archived documentation? This cannot be undone.",
        { modal: true, detail: `"${item.docText}"` },
        "Discard"
      );
      if (confirmed !== "Discard") return;

      try {
        this.documentationService.discardArchivedRecord(repoPath, message.archiveId);
        this.activityLog.success(`Discarded archived documentation. (${item.originalFileId})`);
      } catch (err) {
        const errText = `${err instanceof Error ? err.message : String(err)} (${item.originalFileId})`;
        this.activityLog.error(errText);
        vscode.window.showErrorMessage(`rapid-docs: ${errText}`);
        return;
      }
      await this.refresh();
    }
  }

  async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.items = folder ? this.documentationService.loadArchive(folder.uri.fsPath) : [];
    void this.webviewView?.webview.postMessage({ type: "setItems", items: this.items });
  }
}
