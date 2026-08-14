import * as vscode from "vscode";
import { join } from "path";
import type { DocumentationService, DocumentedSectionItem } from "../../types";
import type { HighlightController } from "../../highlighting/highlightController";
import type { ActiveEditorTracker } from "../../editor-interactions/activeEditorTracker";
import type { DocTextPreview } from "../shared/docTextPreview";
import type { ActivityLog } from "../../activity/activityLog";
import { renderWebviewShell } from "../shared/webviewShell";
import { ComposePanel } from "../compose/composePanel";

// Replicates electron/main.ts's "docs:findDocumentedNodes" handler exactly
// (main.ts:200-222), not just DocumentationService.findDocumentedNodes()
// alone -- that method returns one entry PER MATCHED AST NODE (a single
// writeDoc call typically matches many nested nodes sharing one recordId),
// and has no docText at all. The real IPC handler collapses to one row per
// recordId and separately attaches docText from loadStorage; that glue
// logic lives in electron/main.ts, not in src/, so it has to be
// reimplemented here rather than assumed covered by the backend reuse.
export async function collectDocumentedSections(
  documentationService: DocumentationService,
  repoPath: string,
  relativePath: string
): Promise<DocumentedSectionItem[]> {
  const locations = documentationService.findDocumentedNodes(repoPath, relativePath);
  const storage = documentationService.loadStorage(repoPath, relativePath);

  const byRecordId = new Map<string, { recordId: string; start: number; end: number }>();
  for (const loc of locations) {
    const existing = byRecordId.get(loc.recordId);
    if (existing === undefined) {
      byRecordId.set(loc.recordId, { recordId: loc.recordId, start: loc.start, end: loc.end });
    } else {
      existing.start = Math.min(existing.start, loc.start);
      existing.end = Math.max(existing.end, loc.end);
    }
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(repoPath, relativePath)));
  return Array.from(byRecordId.values()).map((entry) => ({
    ...entry,
    relativePath,
    docText: storage.records[entry.recordId]?.docText ?? "",
    startLine: document.positionAt(entry.start).line,
  }));
}

export function sectionHighlightKey(recordId: string): string {
  return `doc:${recordId}`;
}

type FromWebviewMessage =
  | { type: "reveal"; recordId: string }
  | { type: "edit"; recordId: string }
  | { type: "delete"; recordId: string }
  | { type: "preview"; recordId: string };

// Same edit/delete glyphs electron/renderer.js's own ICONS.edit/ICONS.delete
// used (renderer.js:26-31) -- kept visually consistent with the original
// design rather than picking new icons. Real icon buttons, not text labels
// with "Edit"/"Delete" spelled out: their shape alone (pencil/trash) already
// communicates the action, a native title="" tooltip covers anyone who
// wants the word too, on hover -- exactly how VSCode's own inline row
// actions (e.g. Search results, Source Control) work.
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>';
const ICON_DELETE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
// Real user feedback (2026-08-12): docText can be long and multi-line, and
// this row's own text is truncated to 60 chars -- an eye icon opens the
// full thing, well-formatted, in a real read-only tab (docTextPreview.ts),
// same mechanism the delete Quick Fix's QuickPick also uses.
const ICON_PREVIEW =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';

const STYLE = `
  .row { border-bottom: 1px solid var(--vscode-widget-border, transparent); padding: 6px 4px; }
  .row.active { background: var(--vscode-list-activeSelectionBackground); }
  .row-header { display: flex; justify-content: space-between; align-items: center; }
  .lines { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .text { cursor: pointer; margin-top: 2px; white-space: pre-wrap; word-break: break-word; }
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

export class DocumentedSectionsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "rapidDocsDocumentedSections";

  private webviewView: vscode.WebviewView | null = null;
  private items: DocumentedSectionItem[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly documentationService: DocumentationService,
    private readonly highlightController: HighlightController,
    private readonly activeEditorTracker: ActiveEditorTracker,
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

    // A WebviewView only resolves the FIRST time the user actually opens
    // this panel -- any refresh() call before that (e.g. right after
    // activation, or from a test command run while the panel was closed)
    // had nowhere to post its message to, and nothing re-sent it once the
    // panel finally became visible. Re-computing here, every time the panel
    // becomes visible, is what fixes that -- a freshly-opened panel always
    // shows the REAL current state, not stale emptiness from before it existed.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.refresh();
    });
    void this.refresh();
  }

  private render(): void {
    if (!this.webviewView) return;
    this.webviewView.webview.html = renderWebviewShell({
      webview: this.webviewView.webview,
      title: "rapid-docs: Documented Sections",
      extraStyle: STYLE,
      bodyHtml: `<div id="list"></div>`,
      scriptJs: `
        const ICON_EDIT = ${JSON.stringify(ICON_EDIT)};
        const ICON_DELETE = ${JSON.stringify(ICON_DELETE)};
        const ICON_PREVIEW = ${JSON.stringify(ICON_PREVIEW)};
        const listEl = document.getElementById('list');
        let items = [];

        function render() {
          if (items.length === 0) {
            listEl.innerHTML = '<div class="empty">Nothing documented in this file yet.</div>';
            return;
          }
          listEl.innerHTML = '';
          for (const item of items) {
            const row = document.createElement('div');
            row.className = 'row';
            row.dataset.recordId = item.recordId;
            const truncated = item.docText.length > 60 ? item.docText.slice(0, 60) + '...' : item.docText;
            row.innerHTML =
              '<div class="row-header">' +
                '<span class="lines">line ' + (item.startLine + 1) + '</span>' +
                '<span class="row-actions">' +
                  '<button class="icon-button preview" title="Preview full documentation">' + ICON_PREVIEW + '</button>' +
                  '<button class="icon-button edit" title="Edit documentation">' + ICON_EDIT + '</button>' +
                  '<button class="icon-button danger delete" title="Delete documentation">' + ICON_DELETE + '</button>' +
                '</span>' +
              '</div>' +
              '<div class="text"></div>';
            row.querySelector('.text').textContent = truncated || '(no text)';

            row.querySelector('.lines').addEventListener('click', () => {
              vscode.postMessage({ type: 'reveal', recordId: item.recordId });
            });
            row.querySelector('.text').addEventListener('click', () => {
              vscode.postMessage({ type: 'reveal', recordId: item.recordId });
            });
            row.querySelector('.preview').addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'preview', recordId: item.recordId });
            });
            row.querySelector('.delete').addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'delete', recordId: item.recordId });
            });
            row.querySelector('.edit').addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'edit', recordId: item.recordId });
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
    // NOT vscode.window.activeTextEditor -- clicking any row/button inside
    // this webview shifts VSCode's focus away from the source file, the
    // same real bug found and fixed in Compose. See activeEditorTracker.ts.
    const editor = this.activeEditorTracker.getEditor();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !folder) return;
    const repoPath = folder.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

    if (message.type === "reveal") {
      const item = this.items.find((i) => i.recordId === message.recordId);
      if (!item) return;
      const range = new vscode.Range(editor.document.positionAt(item.start), editor.document.positionAt(item.end));
      // Must be called before touching editor.selection -- see
      // highlightController.ts's own comment on why this exists: without
      // it, the resulting selection-change event could be misread by
      // diagnosticClickHighlight as a genuine, unrelated user selection and
      // clear the highlight this reveal is about to set, moments later.
      this.highlightController.suppressNextSelectionEvent();
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      // Always reveals/selects regardless of toggle state, but the
      // decoration itself toggles -- matches electron/renderer.js's own
      // row-click behavior (toggleDocSectionHighlight, called unconditionally
      // alongside selectByOffsets, renderer.js:789-796) exactly.
      this.highlightController.toggle(sectionHighlightKey(item.recordId), "documented", [range], editor);
    } else if (message.type === "edit") {
      const item = this.items.find((i) => i.recordId === message.recordId);
      if (!item) return;
      // Replaces the old inline <input> swap entirely (real UX gap: cramped,
      // a bad fit for anything long or multi-line) -- opens the same
      // spacious Compose panel already used for writing new docs, pre-filled
      // with this record's existing text via editDocText (doesn't need a
      // code selection at all -- unlike writeDoc/updateDriftedDoc, it never
      // touches the code-matching hashes, only the stored text).
      const panel = ComposePanel.openOrReveal(
        this.context,
        this.documentationService,
        this.highlightController,
        () => this.refresh(),
        this.activeEditorTracker,
        this.activityLog
      );
      panel.beginEditRecord(item.recordId, item.relativePath, item.docText);
    } else if (message.type === "delete") {
      const item = this.items.find((i) => i.recordId === message.recordId);
      if (!item) return;
      // Real user concern (2026-08-15): a Documented Sections row's trash
      // icon is one accidental click away from destroying documentation
      // someone just wrote -- no other action here (edit, preview) is
      // destructive, only this one, so it's the only one that needs a
      // guard. Same data-loss-prevention pattern as delete-stale-
      // documentation and archive-discard: show the real docText, require
      // an explicit "Delete" click, not just "are you sure".
      const confirmed = await vscode.window.showWarningMessage(
        "Permanently delete this documentation? This cannot be undone.",
        { modal: true, detail: `"${item.docText}"` },
        "Delete"
      );
      if (confirmed !== "Delete") return;

      try {
        this.documentationService.deleteRecord(repoPath, relativePath, message.recordId);
        this.activityLog.success(`Deleted documentation. (${relativePath})`);
      } catch (err) {
        const errText = `${err instanceof Error ? err.message : String(err)} (${relativePath})`;
        this.activityLog.error(errText);
        vscode.window.showErrorMessage(`rapid-docs: ${errText}`);
      }
      await this.refresh();
    } else if (message.type === "preview") {
      const item = this.items.find((i) => i.recordId === message.recordId);
      if (!item) return;
      await this.docTextPreview.show(item.docText, message.recordId.slice(0, 8));
    }
  }

  async refresh(): Promise<void> {
    // NOT vscode.window.activeTextEditor -- real bug found via manual
    // testing: refresh() runs immediately after a successful Compose
    // submission, at which point the Compose PANEL (not the code editor)
    // has focus, so activeTextEditor was undefined and the list went blank
    // ("Nothing documented in this file yet") until the user clicked back
    // into the real file. The tracker keeps pointing at the last REAL text
    // editor throughout, exactly what's needed here.
    const editor = this.activeEditorTracker.getEditor();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !folder) {
      this.items = [];
    } else {
      const repoPath = folder.uri.fsPath;
      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      try {
        this.items = await collectDocumentedSections(this.documentationService, repoPath, relativePath);
      } catch {
        this.items = []; // file doesn't parse right now, same as the Electron panel going quiet on a broken file
      }
    }

    // Real bug found via manual testing: deleting (or editing away) the
    // record a highlight currently points at left the highlight itself
    // painted on the editor forever -- refresh() updated the LIST, but a
    // TextEditorDecorationType, once set, has no idea the data behind it
    // just changed. Matches electron/renderer.js's own re-validation
    // (refreshDocumentedSections, renderer.js:716-726): every refresh
    // re-checks whether the currently active highlight's record still
    // exists, and clears it if not.
    const activeKey = this.highlightController.currentKey();
    if (activeKey?.startsWith("doc:") && !this.items.some((item) => sectionHighlightKey(item.recordId) === activeKey)) {
      this.highlightController.clear(editor);
    }

    void this.webviewView?.webview.postMessage({ type: "setItems", items: this.items });
  }

  currentItems(): DocumentedSectionItem[] {
    return this.items;
  }
}
