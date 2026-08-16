import * as vscode from "vscode";
import type { DocumentationService } from "../../types";
import type { HighlightController } from "../../highlighting/highlightController";
import type { ActiveEditorTracker } from "../../editor-interactions/activeEditorTracker";
import type { ActivityLog } from "../../activity/activityLog";
import { formatDisplayPath } from "../../editor-interactions/displayPath";
import { renderWebviewShell } from "../shared/webviewShell";

// Set only by "Update documentation (code changed)" (7.4's context menu,
// temporarily reachable via rapidDocs.testBeginDriftUpdate until then) --
// redirects the NEXT compose submission to updateDriftedDoc (replace the
// old, drifted record) instead of writeDoc (create a new, unrelated one).
// null the rest of the time, which is what keeps "Document Selection"
// behaving exactly as normal for the ordinary, no-drift-involved case.
// Matches electron/renderer.js's own pendingDriftUpdate (renderer.js:129).
//
// start/end added 2026-08-16, a real bug found via manual testing: this
// used to carry no position at all, and the submit handler read
// activeEditorTracker's LIVE selection at submit time instead -- meaning
// if the user did anything with their selection between opening "Update
// documentation" and actually clicking submit (even something as ordinary
// as selecting a different line to copy it), the update silently got
// anchored to whatever was selected AT SUBMIT TIME, not the code that was
// actually highlighted when Update was invoked. The selection is real and
// known the moment the menu item is chosen (registerEditorContextMenu.ts
// already refuses to even show the menu without one), so it's captured
// here, once, instead of re-read later.
interface PendingDriftUpdate {
  oldRecordId: string;
  relativePath: string;
  // Captured at the moment the pending mode is SET (when the source file
  // is reliably known), not re-derived later from whatever editor happens
  // to be active at submit time. Multi-root correctness (2026-08-15): a
  // bare relativePath string alone doesn't say which root it belongs to,
  // and the user's active editor can genuinely change between opening
  // "Update documentation" and actually submitting.
  repoPath: string;
  start: number;
  end: number;
}

// Set only by "Edit documentation" (the context menu's matching-record
// branch, and Documented Sections' own row edit button) -- redirects the
// NEXT compose submission to editDocText (change an EXISTING record's text
// only, no code-matching hashes touched at all) instead of writeDoc/
// updateDriftedDoc. Real UX gap this replaces: editing used to swap a
// Documented Sections row for a tiny single-line <input>, a bad fit for
// anything long or multi-line -- the same problem this whole session's
// docText-preview work was about, just for WRITING instead of reading.
interface PendingEditRecord {
  recordId: string;
  relativePath: string;
  // Same reasoning as PendingDriftUpdate.repoPath above.
  repoPath: string;
}

// New 2026-08-16, the fresh-write counterpart to PendingDriftUpdate's own
// start/end fix above -- "Document selection" used to carry NO captured
// target at all, relying entirely on activeEditorTracker's live selection
// at submit time, which is exactly the same silent-misattachment risk:
// select code, open Compose, go back and select something else (even just
// to copy it), and the documentation would attach to the SECOND selection
// with zero warning. null specifically means "nothing was captured yet"
// (e.g. the bare Command Palette command with no prior selection) --
// submit falls back to reading the live selection only in that one case,
// preserving the "open blank, then select, then submit" flow.
interface PendingWrite {
  relativePath: string;
  repoPath: string;
  start: number;
  end: number;
}

type FromWebviewMessage = { type: "submit"; text: string } | { type: "draftChanged"; hasText: boolean };

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
  private pendingEditRecord: PendingEditRecord | null = null;
  private pendingWrite: PendingWrite | null = null;
  // Mirrors the webview's OWN textarea state exactly (updated only by real
  // "draftChanged" reports from the client, never guessed or reset from
  // the extension-host side) -- the single source of truth confirmDiscard-
  // IfNeeded checks before letting any begin*/reset method silently blow
  // away real, unsaved text. Deliberately NOT reset when a pending mode is
  // consumed at submit time -- a FAILED submit leaves the text sitting in
  // the textarea untouched, and it needs to stay protected until the
  // client itself reports it changed.
  private hasDraftText = false;
  // Human-readable label for whatever hasDraftText is currently protecting
  // -- only ever read inside the discard-confirmation prompt, and only
  // ever written by a begin*/resetToFresh call that itself just passed
  // that same confirmation, so it never needs proactive resetting.
  private currentLabel = "the current draft";

  // Takes an already-created panel rather than creating one itself -- lets
  // BOTH a brand-new panel (openOrReveal) and an already-existing one VSCode
  // hands back after a window reload (revive, via the registered
  // WebviewPanelSerializer) funnel through the exact same setup, instead of
  // duplicating render()/onDidReceiveMessage/onDidDispose wiring in two
  // places that could drift apart.
  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly documentationService: DocumentationService,
    private readonly highlightController: HighlightController,
    private readonly refreshDocumentedSections: () => Promise<void>,
    private readonly activeEditorTracker: ActiveEditorTracker,
    private readonly activityLog: ActivityLog
  ) {
    this.panel = panel;
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
    activeEditorTracker: ActiveEditorTracker,
    activityLog: ActivityLog
  ): ComposePanel {
    if (ComposePanel.instance) {
      ComposePanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return ComposePanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      "rapidDocsCompose",
      "rapid-docs: Compose",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    // Unlike the Activity Bar icon (forced monochrome by VSCode, no
    // exceptions), a WebviewPanel's own tab icon supports real, full color --
    // real feedback, 2026-08-16: use the actual established brand mark (the
    // same blue-square/white-R/yellow-bolt icon Electron already ships as
    // icon.ico/icon-256.png), not a separately-invented bolt-only glyph.
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "compose-icon.png");
    ComposePanel.instance = new ComposePanel(panel, context, documentationService, highlightController, refreshDocumentedSections, activeEditorTracker, activityLog);
    return ComposePanel.instance;
  }

  // Called by the registered WebviewPanelSerializer when VSCode restores a
  // previously-open Compose tab after a window reload. Real bug found via
  // manual testing (2026-08-15): the tab itself survives a reload, but its
  // HTML content doesn't -- VSCode has no way to regenerate webview.html on
  // its own, that only ever happens through this class's own render() call,
  // which never re-ran for a revived panel without this. Deliberately
  // revives into a fresh, blank compose state rather than trying to restore
  // exactly what was mid-typed or which pending mode was active -- a window
  // reload already wipes the entire extension host's memory regardless, so
  // there was never anything left to actually recover; a working, blank
  // panel is strictly better than a broken, empty-looking one.
  static revive(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    documentationService: DocumentationService,
    highlightController: HighlightController,
    refreshDocumentedSections: () => Promise<void>,
    activeEditorTracker: ActiveEditorTracker,
    activityLog: ActivityLog
  ): void {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "compose-icon.png");
    ComposePanel.instance = new ComposePanel(panel, context, documentationService, highlightController, refreshDocumentedSections, activeEditorTracker, activityLog);
  }

  // Real UX gap found via manual testing (2026-08-16): Compose is reused
  // across separate targets (openOrReveal never creates a second panel), so
  // triggering a new Document/Update/Edit action while a real, unsaved draft
  // was already sitting in the textarea used to discard it completely
  // silently -- no warning, the earlier target's in-progress text just
  // vanished the moment the new one was set. Every begin*/reset method below
  // funnels through this one check first: if there's real unsaved text,
  // confirm before discarding it -- the same "show what's about to be lost,
  // require an explicit click" pattern already used for every permanent-
  // deletion path in this extension. Returns false (caller must bail out,
  // leaving the panel untouched) only when the user explicitly declines.
  private async confirmDiscardIfNeeded(newLabel: string): Promise<boolean> {
    if (!this.hasDraftText) return true;
    const confirmed = await vscode.window.showWarningMessage(
      `You have an unfinished draft for ${this.currentLabel}.`,
      { modal: true, detail: `Discard it and document ${newLabel} instead?` },
      "Discard and Continue"
    );
    return confirmed === "Discard and Continue";
  }

  async beginDriftUpdate(
    oldRecordId: string,
    relativePath: string,
    repoPath: string,
    start: number,
    end: number,
    existingDocText: string
  ): Promise<void> {
    const label = formatDisplayPath(repoPath, relativePath);
    if (!(await this.confirmDiscardIfNeeded(label))) return;
    this.pendingEditRecord = null;
    this.pendingWrite = null;
    this.pendingDriftUpdate = { oldRecordId, relativePath, repoPath, start, end };
    this.currentLabel = label;
    void this.panel.webview.postMessage({ type: "beginDriftUpdate", docText: existingDocText });
  }

  // Replaces Documented Sections' own inline <input> edit entirely (real
  // UX gap: cramped, a bad fit for anything long or multi-line -- the same
  // "long content deserves a real surface" theme as this session's
  // docText-preview work). Reuses this exact same panel/tab rather than
  // any separate editing UI. Doesn't need a code selection at all -- unlike
  // writeDoc/updateDriftedDoc, editDocText only ever changes the stored
  // text, never the code-matching hashes.
  async beginEditRecord(recordId: string, relativePath: string, repoPath: string, existingDocText: string): Promise<void> {
    const label = formatDisplayPath(repoPath, relativePath);
    if (!(await this.confirmDiscardIfNeeded(label))) return;
    this.pendingDriftUpdate = null;
    this.pendingWrite = null;
    this.pendingEditRecord = { recordId, relativePath, repoPath };
    this.currentLabel = label;
    void this.panel.webview.postMessage({ type: "beginEditRecord", docText: existingDocText });
  }

  private clearPendingModes(): void {
    this.pendingDriftUpdate = null;
    this.pendingEditRecord = null;
    this.pendingWrite = null;
    void this.panel.webview.postMessage({ type: "clearPendingModes" });
  }

  // The target-aware counterpart to resetToFresh, below -- used whenever a
  // real selection is already known (the editor context menu's "Document
  // selection" item, and the Command Palette command when something's
  // currently selected), so the eventual submit uses THIS captured
  // start/end rather than re-reading the editor's selection live.
  async beginFreshWrite(repoPath: string, relativePath: string, start: number, end: number): Promise<void> {
    const label = formatDisplayPath(repoPath, relativePath);
    if (!(await this.confirmDiscardIfNeeded(label))) return;
    this.pendingDriftUpdate = null;
    this.pendingEditRecord = null;
    this.pendingWrite = { repoPath, relativePath, start, end };
    this.currentLabel = label;
    void this.panel.webview.postMessage({ type: "resetFresh" });
  }

  // Real bug found via manual testing: opening Compose "fresh" for a
  // genuinely undocumented selection reused the EXISTING panel instance
  // (openOrReveal only reveals it, doesn't reset anything) -- if that panel
  // was still showing leftover drift-update state (button reading "Update
  // Documentation", old text still in the textarea) from an earlier,
  // unrelated action, it kept showing that stale state indefinitely, even
  // though the actual submit logic was already correctly routed to writeDoc,
  // not updateDriftedDoc. Unlike clearPendingModes (label only), this also
  // clears the textarea and any leftover status message -- a genuinely
  // fresh start, not just a relabeled button. No target is known yet here
  // (unlike beginFreshWrite) -- submit falls back to reading the editor's
  // live selection, the same "open blank, then select, then submit" flow
  // that worked before this session's capture-at-open fix.
  async resetToFresh(): Promise<void> {
    if (!(await this.confirmDiscardIfNeeded("a new selection"))) return;
    this.pendingDriftUpdate = null;
    this.pendingEditRecord = null;
    this.pendingWrite = null;
    this.currentLabel = "the current draft";
    void this.panel.webview.postMessage({ type: "resetFresh" });
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

        // The extension host's own source of truth for "is there real,
        // unsaved text right now" -- sent on every real change, typed OR
        // programmatic, so confirmDiscardIfNeeded never has to guess.
        function reportDraft() {
          vscode.postMessage({ type: 'draftChanged', hasText: textEl.value.trim().length > 0 });
        }
        textEl.addEventListener('input', reportDraft);

        buttonEl.addEventListener('click', () => {
          vscode.postMessage({ type: 'submit', text: textEl.value });
        });

        window.addEventListener('message', (event) => {
          const message = event.data;
          if (message.type === 'beginDriftUpdate') {
            textEl.value = message.docText;
            buttonEl.textContent = 'Update Documentation';
            textEl.focus();
            reportDraft();
          } else if (message.type === 'beginEditRecord') {
            textEl.value = message.docText;
            buttonEl.textContent = 'Save Changes';
            textEl.focus();
            reportDraft();
          } else if (message.type === 'clearPendingModes') {
            buttonEl.textContent = 'Document Selection';
          } else if (message.type === 'resetFresh') {
            if (statusClearTimeout) clearTimeout(statusClearTimeout);
            textEl.value = '';
            buttonEl.textContent = 'Document Selection';
            statusEl.textContent = '';
            statusEl.className = '';
            reportDraft();
          } else if (message.type === 'submitResult') {
            if (statusClearTimeout) clearTimeout(statusClearTimeout);
            statusEl.textContent = message.text;
            statusEl.className = message.severity;
            if (message.severity === 'success') {
              textEl.value = '';
              reportDraft();
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
    // The client's own report of "is there real text in the textarea right
    // now" -- see hasDraftText's own comment for why this is never guessed
    // or reset from this side.
    if (message.type === "draftChanged") {
      this.hasDraftText = message.hasText;
      return;
    }

    // Every hint/success/error Compose can ever show already funnels
    // through this one function -- hooking Activity logging in here,
    // rather than at each of the 7 individual call sites below, is what
    // guarantees full coverage instead of an easy-to-miss subset.
    const status = (text: string, severity: "hint" | "error" | "success") => {
      this.activityLog[severity](text);
      void this.panel.webview.postMessage({ type: "submitResult", text, severity });
    };

    // One-shot, mutually exclusive: whichever pending mode is active gets
    // consumed right here, regardless of outcome, so a later, unrelated
    // submission can never accidentally be redirected into finishing
    // something it was never actually about. Matches electron/renderer.js's
    // own reasoning for pendingDriftUpdate (renderer.js:954-959), extended
    // to the same one-shot treatment for editRecord/write. Deliberately does
    // NOT touch hasDraftText -- a FAILED submit below leaves the textarea's
    // real text untouched, and it must stay protected until the client
    // itself reports a real change, not just because a pending mode was
    // consumed.
    const editRecord = this.pendingEditRecord;
    const driftUpdate = this.pendingDriftUpdate;
    const write = this.pendingWrite;
    this.clearPendingModes();

    if (!message.text.trim()) {
      status("Enter some documentation text first.", "hint");
      return;
    }

    // editDocText doesn't need a code selection at all -- unlike
    // writeDoc/updateDriftedDoc, it only ever changes the stored text,
    // never the code-matching hashes -- so this branch never touches
    // activeEditorTracker/the editor at all.
    if (editRecord) {
      // formatDisplayPath, not the bare relativePath -- multi-root support
      // (2026-08-15): shows which folder this is in, once there's more
      // than one open. editDocText itself still gets the true, unprefixed
      // relativePath -- only what's shown to a human changes here.
      const editDisplayPath = formatDisplayPath(editRecord.repoPath, editRecord.relativePath);
      try {
        this.documentationService.editDocText(editRecord.repoPath, editRecord.relativePath, editRecord.recordId, message.text);
        status(`Updated. (${editDisplayPath})`, "success");
        await this.refreshDocumentedSections();
      } catch (err) {
        status(`${err instanceof Error ? err.message : String(err)} (${editDisplayPath})`, "error");
      }
      return;
    }

    // Captured target (driftUpdate/write) takes priority -- it's the whole
    // point of this session's capture-at-open fix, real evidence a user hit:
    // going back into the editor for any reason (even just selecting some
    // code to copy it) between opening Compose and clicking submit used to
    // silently redirect the documentation to whatever was selected AT
    // SUBMIT TIME instead of what was actually highlighted when the action
    // was invoked. The live editor/selection read below is now only a
    // fallback for the one legitimate case nothing was captured yet: Compose
    // opened via the bare Command Palette command with no prior selection,
    // where "open blank, then select, then submit" is still the intended
    // flow.
    let repoPath: string;
    let relativePath: string;
    let start: number;
    let end: number;

    if (driftUpdate) {
      repoPath = driftUpdate.repoPath;
      relativePath = driftUpdate.relativePath;
      start = driftUpdate.start;
      end = driftUpdate.end;
    } else if (write) {
      repoPath = write.repoPath;
      relativePath = write.relativePath;
      start = write.start;
      end = write.end;
    } else {
      // NOT vscode.window.activeTextEditor -- clicking anything inside this
      // panel (a webview, not a text editor) shifts VSCode's own focus away
      // from the source file, so by the time this message handler runs,
      // activeTextEditor is undefined even though a file genuinely IS open
      // with a real selection. Real bug found via manual testing: this
      // reported "Open a file first." on every submit. The tracker's
      // TextEditor object stays valid and its .selection stays live-accurate
      // even after it stops being VSCode's "active" one.
      const editor = this.activeEditorTracker.getEditor();
      if (!editor) {
        status("Open a file first.", "hint");
        return;
      }

      // getWorkspaceFolder(uri), not workspaceFolders?.[0] -- multi-root
      // support (2026-08-15): the correct root is whichever one actually
      // CONTAINS this file, not always the first folder in the workspace.
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!folder) {
        status("Open a folder first.", "hint");
        return;
      }

      repoPath = folder.uri.fsPath;
      relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
      start = editor.document.offsetAt(editor.selection.start);
      end = editor.document.offsetAt(editor.selection.end);
    }

    // formatDisplayPath, not the bare relativePath -- multi-root support
    // (2026-08-15): shows which folder this is in, once there's more than
    // one open. Every writeDoc/updateDriftedDoc call below still gets the
    // true, unprefixed repoPath/relativePath -- only what's shown to a
    // human changes here.
    const displayPath = formatDisplayPath(repoPath, relativePath);

    if (start === end) {
      status(`Select some code in the file above first. (${displayPath})`, "hint");
      return;
    }

    try {
      if (driftUpdate) {
        this.documentationService.updateDriftedDoc(repoPath, relativePath, driftUpdate.oldRecordId, start, end, message.text);
        status(`Updated documentation for changed code. (${displayPath})`, "success");
      } else {
        this.documentationService.writeDoc(repoPath, relativePath, start, end, message.text);
        status(`Documented. (${displayPath})`, "success");
      }
      // A highlight still showing from an earlier action (e.g. the
      // now-stale diagnostic for the selection just documented) must not
      // linger past the point it stopped being accurate.
      this.highlightController.clear(this.activeEditorTracker.getEditor());
      await this.refreshDocumentedSections();
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Same friendly-error mapping electron/renderer.js's own
      // friendlyErrorMessage used (renderer.js:900-913) for this exact case.
      const friendly = /already documented as record/.test(rawMessage)
        ? "This is already documented. Use the Edit button to change its text."
        : rawMessage;
      status(`${friendly} (${displayPath})`, "error");
    }
  }
}
