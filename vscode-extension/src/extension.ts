import * as vscode from "vscode";
import { existsSync } from "fs";
import { join } from "path";
import { bootstrapBackend } from "./backend/bootstrap";
import { createDiagnosticsController, activateDiagnosticsLiveWiring } from "./diagnostics/diagnosticsController";
import { createHighlightController } from "./highlighting/highlightController";
import { DocumentedSectionsViewProvider } from "./webviews/documentedSections/documentedSectionsViewProvider";
import { ArchiveViewProvider } from "./webviews/archive/archiveViewProvider";
import { createActivityLog } from "./activity/activityLog";
import { registerDiagnosticPositionHighlight } from "./editor-interactions/diagnosticPositionHighlight";
import { registerDeleteStaleDocumentationProvider } from "./editor-interactions/deleteStaleDocumentationProvider";
import { registerDocTextPreview } from "./webviews/shared/docTextPreview";
import { createActiveEditorTracker } from "./editor-interactions/activeEditorTracker";
import { registerComposeCommands } from "./webviews/compose/registerComposeCommands";
import { registerEditorContextMenu } from "./editor-interactions/registerEditorContextMenu";
import { registerAllTestCommands } from "./test-commands/registerAll";

// Module-scoped (not local to activate()) specifically so deactivate() can
// reach them for real cleanup -- electron/main.ts never had to solve this,
// its process just exits and the OS reclaims everything, but an extension
// can be deactivated while VSCode itself keeps running (workspace closed,
// extension disabled, VSCode reloaded), so leaving the watcher running and
// the Nest context open would be a genuine, real resource leak, not a
// hypothetical one.
// A collection, not a single ref -- multi-root support (2026-08-15): one
// independent LiveWatchService per folder now, so deactivate() needs to
// stop every one of them, not just one.
let liveWatchServiceRefs: { stop: () => Promise<void> }[] = [];
let appContextRef: { close: () => Promise<void> } | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const diagnosticCollection = createDiagnosticsController(context);

  // No native VSCode concept covers this: Diagnostics is only for problems,
  // there's nothing built in for "this code is fine, and here's proof it's
  // documented." insertedTextBackground is a real, already-themed VSCode
  // color (used for diff-added lines), reused here rather than picking an
  // arbitrary color, so it adapts to whatever theme (light/dark/high-
  // contrast) the user actually has. Kept as its own standalone type for the
  // Section 1-era testDecorations smoke test; the real, toggled decorations
  // used by Documented Sections/Problems live in highlightController below.
  const documentedDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
  });
  context.subscriptions.push(documentedDecorationType);

  const backend = await bootstrapBackend();
  appContextRef = backend.appContext;
  // NOT backend.liveWatchService (the single shared instance) -- the real
  // multi-root activation path below creates its own fresh instance per
  // folder via backend.createLiveWatchService() and pushes each one onto
  // liveWatchServiceRefs itself.

  const highlightController = createHighlightController(context);
  const activeEditorTracker = createActiveEditorTracker(context);

  // Real user feedback (2026-08-12): docText can be long and multi-line,
  // and neither a truncated Documented Sections row nor a one-line
  // QuickPick label can show that -- one shared preview mechanism (a real,
  // read-only Markdown-rendered tab via VSCode's own built-in Markdown
  // Preview) used everywhere docText is shown short, not a custom viewer.
  const docTextPreview = registerDocTextPreview(context);

  // Section 7.6: a persistent, session-long record of what actually
  // happened (writes/edits/deletes/attaches/discards, and every error along
  // the way) -- the one thing Documented Sections/Problems/Archive can
  // never provide, since all three only ever reflect CURRENT state, with no
  // memory of what changed to get there. See activityLog.ts's own header
  // for why this is a native LogOutputChannel, not a custom Webview.
  const activityLog = createActivityLog(context);

  // Section 7.2: Documented Sections rebuilt as a Webview (not a TreeView --
  // see PARITY-CHECKLIST.md's 2026-08-11 decision). File-scoped, same as the
  // Electron panel was, so it refreshes whenever the active file changes.
  const documentedSectionsProvider = new DocumentedSectionsViewProvider(context, backend.documentationService, highlightController, activeEditorTracker, docTextPreview, activityLog);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DocumentedSectionsViewProvider.viewId, documentedSectionsProvider)
  );

  // Section 7.5: unlike Documented Sections, not file-scoped -- loadArchive
  // returns every archived record project-wide, so this view only ever
  // needs repoPath, never activeEditorTracker.
  const archiveProvider = new ArchiveViewProvider(backend.documentationService, docTextPreview, activityLog);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ArchiveViewProvider.viewId, archiveProvider));
  void archiveProvider.refresh();

  // Discoverability fix, 2026-08-16: VSCode already auto-generates a
  // `<viewId>.focus` command for every contributed view, but it's only
  // findable by knowing the view's own name in advance, not by searching
  // "rapid-docs" in the Command Palette -- unlike Compose's own
  // rapidDocs.openCompose, which already IS findable that way. These two
  // just forward to the auto-generated ones, giving Documented Sections
  // and Archive the same "rapid-docs: Show ..." discoverability Compose
  // already had, for whenever the sidebar's been moved or closed.
  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.showDocumentedSections", () =>
      vscode.commands.executeCommand(`${DocumentedSectionsViewProvider.viewId}.focus`)
    ),
    vscode.commands.registerCommand("rapidDocs.showArchive", () =>
      vscode.commands.executeCommand(`${ArchiveViewProvider.viewId}.focus`)
    )
  );

  function onActiveEditorChanged(): void {
    void documentedSectionsProvider.refresh();
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(onActiveEditorChanged));
  onActiveEditorChanged();

  // 7.1 rebuild, step 2 (2026-08-11), now the ONLY Problems mechanism
  // (2026-08-12): native VSCode Problems panel + this position-based
  // highlight, no custom webview -- see diagnosticPositionHighlight.ts's
  // own header for the full reasoning. The earlier custom Problems webview
  // (checkboxes, Clear Selected/Clear All, per-row click) was removed: its
  // own file-scoping (tied to vscode.window.activeTextEditor) went stale
  // the instant Compose took focus, showing an empty list even though
  // nothing about the underlying messages had changed -- confirmed live,
  // not assumed. Native Problems has the exact same underlying quirk
  // (VSCode's own "Show Active File Only" filter reads the same stale
  // active-editor state), but that's a native, user-toggleable setting,
  // not a bug in our own code to carry the weight of working around.
  registerDiagnosticPositionHighlight(context, highlightController);

  // 7.6: native Quick Fix for deleting a stale (warning or error) record --
  // see deleteStaleDocumentationProvider.ts's own header for why this
  // covers both severities, not just error/fully-stale as first scoped.
  registerDeleteStaleDocumentationProvider(context, backend.documentationService, () => documentedSectionsProvider.refresh(), docTextPreview, activityLog);

  // Section 7.3: Compose, a real WebviewPanel opened beside the editor
  // (not docked in the sidebar) per the 2026-08-11 decision, so code and
  // the compose form stay visible together.
  registerComposeCommands(context, {
    documentationService: backend.documentationService,
    highlightController,
    refreshDocumentedSections: () => documentedSectionsProvider.refresh(),
    activeEditorTracker,
    activityLog,
  });

  // Section 7.4 (rebuilt 2026-08-11): one static menu entry that opens a
  // QuickPick computed fresh at invocation time -- the real VSCode
  // equivalent of electron/renderer.js's own showContextMenu, not a
  // declarative context-key-gated menu (that first version raced against
  // its own async context-key updates and showed the wrong action for the
  // current selection). Reuses the exact same underlying paths 7.2/7.3
  // already proved (Documented Sections' own edit/delete, Compose's
  // beginDriftUpdate/resetToFresh), not new logic.
  registerEditorContextMenu(context, {
    documentationService: backend.documentationService,
    activeEditorTracker,
    highlightController,
    refreshDocumentedSections: () => documentedSectionsProvider.refresh(),
    refreshArchive: () => archiveProvider.refresh(),
    docTextPreview,
    activityLog,
  });

  // Section 7.7: real, confirmed gap -- unlike electron/main.ts (which
  // explicitly checked isGitRepo() before doing anything and rejected a
  // non-repo folder with a clear message), this extension had NO equivalent
  // check anywhere. GitService.runGit() just runs `git ls-files`/`git
  // diff`/etc. directly; against a folder with no .git at all, that throws,
  // and since nothing here caught it, activate() itself would reject --
  // VSCode surfaces that as "extension failed to activate," leaving
  // everything (including the git-INDEPENDENT features below, which had
  // already finished registering by this point) in an undefined, half-wired
  // state. A ".git" folder is the one thing every real git repo has,
  // regardless of history/branch/commits -- same one-line check
  // electron/main.ts already used (main.ts:376-377).
  const isGitRepo = (candidatePath: string): boolean => existsSync(join(candidatePath, ".git"));

  // Cleared ONCE, here, before the per-folder loop below -- NOT inside
  // activateDiagnosticsLiveWiring anymore (that would wipe out an earlier
  // folder's just-set diagnostics the moment a second folder's turn came).
  diagnosticCollection.clear();

  // Section 7.1 re-confirmation, now per folder (multi-root support,
  // 2026-08-15): this previously only ever ran via manual test commands --
  // a real user opening the extension got no initial Problems-panel
  // populate and no live updates until they happened to run one
  // themselves. See diagnosticsController.ts for the real, matching-
  // electron/main.ts catch-up-then-watch sequence. The onFilesChanged
  // callback matches electron/renderer.js's own onFilesChanged handler
  // (renderer.js:1248-1259): a live edit to the file the user is ALREADY
  // looking at (e.g. a rename) must refresh Documented Sections too, not
  // just Problems -- confirmed missing for real (renaming a documented
  // function left Documented Sections showing stale, pre-rename data until
  // the user switched files away and back). This callback body doesn't
  // need to be folder-specific itself -- it already resolves everything
  // (archive refresh, the active editor's own relativePath) fresh each
  // time it fires, so the exact same one is safely reused for every
  // folder's own wiring below.
  //
  // Pulled into its own named function, not just an inline await, so it can
  // be called from either of two places below: immediately, if a given
  // folder is already a real git repo, or later, the moment one gets
  // initialized (git init, or VSCode's own "Initialize Repository" button)
  // -- the exact same wiring either way, just triggered at a different
  // time. Real, user-requested behavior (2026-08-15): a non-git folder
  // must never throw or block the OTHER, git-independent features
  // (Compose/Documented Sections/Archive/Activity, none of which touch
  // GitService at all) from working immediately -- and once a repo does
  // exist, everything git-dependent should come alive on its own, with no
  // reload required. A fresh LiveWatchService instance per folder (not the
  // single shared backend.liveWatchService) is what makes it safe to call
  // this once per folder at all -- see bootstrap.ts's own comment on why.
  async function startGitDependentFeaturesForFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const folderLiveWatchService = backend.createLiveWatchService();
    liveWatchServiceRefs.push(folderLiveWatchService);

    await activateDiagnosticsLiveWiring(context, diagnosticCollection, backend.syncService, folderLiveWatchService, folder, (relativePaths) => {
      // Unconditional and unscoped -- ANY file's deletion, in ANY folder,
      // can add a new archive entry (handleDeletedFile), so there's no
      // per-folder filtering to do here at all.
      void archiveProvider.refresh();

      const editor = activeEditorTracker.getEditor();
      if (!editor) return;
      // Normalized to forward-slash before comparing -- LiveWatchService's own
      // relativePaths always are (live-watch.service.ts:253, toRelativePath),
      // but vscode.workspace.asRelativePath returns the OS-native separator
      // (backslash on Windows) by default. A plain .includes() would silently
      // never match on Windows otherwise -- the exact same class of bug
      // already found and fixed once in live-watch.service.ts itself
      // (chokidar's forward-slash paths vs. path.join's native ones).
      const currentRelativePath = vscode.workspace.asRelativePath(editor.document.uri, false).split(/[\\/]/).join("/");
      if (relativePaths.includes(currentRelativePath)) void documentedSectionsProvider.refresh();
    });
    // Real, visible confirmation that this actually ran -- otherwise
    // there's no way to tell "git wiring came alive" apart from "nothing
    // happened" just by looking at the UI. Names the folder so this stays
    // legible once more than one is involved.
    activityLog.success(`Git repository detected in "${folder.name}". Sync and live drift-detection are now active for it.`);
  }

  // One independent pass per folder -- each folder gets its own git-repo
  // check, its own immediate-or-deferred activation, and (inside
  // startGitDependentFeaturesForFolder) its own LiveWatchService instance.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (isGitRepo(folder.uri.fsPath)) {
      await startGitDependentFeaturesForFolder(folder);
    } else {
      // Not a git repo YET -- watch specifically for ".git" being created at
      // THIS folder's own root (git init, or VSCode's own Source Control
      // panel's "Initialize Repository" button both produce this) and start
      // the same git-dependent wiring the moment it appears, no reload
      // needed. A native vscode.FileSystemWatcher, not chokidar -- this only
      // ever needs to notice ONE specific path being created, not walk/watch
      // the whole tree the way LiveWatchService's own broader watcher does.
      const gitInitWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".git")
      );
      context.subscriptions.push(gitInitWatcher);
      const disposable = gitInitWatcher.onDidCreate(() => {
        disposable.dispose();
        void startGitDependentFeaturesForFolder(folder);
      });
      context.subscriptions.push(disposable);
      activityLog.hint(`No git repository found yet in "${folder.name}". Sync and live drift-detection will activate automatically once one exists (e.g. after "git init").`);
    }
  }

  registerAllTestCommands(context, {
    backend,
    diagnosticCollection,
    documentedDecorationType,
    refreshDocumentedSectionsView: () => documentedSectionsProvider.refresh(),
    highlightController,
  });
}

// electron/main.ts never needed an equivalent to this -- its whole process
// exits and the OS reclaims the chokidar watcher and the Nest context for
// free. An extension doesn't get that: VSCode can deactivate one without
// exiting at all (workspace closed, extension disabled, window reloaded),
// so without this, the watcher keeps running and the Nest context stays
// open indefinitely, a real leak, not a hypothetical one, first found
// completely empty and never caught until the parity audit specifically
// asked "what happens on shutdown."
export async function deactivate(): Promise<void> {
  // One per folder now (multi-root support, 2026-08-15) -- every one of
  // them needs stopping, not just a single shared instance.
  await Promise.all(liveWatchServiceRefs.map((ref) => ref.stop()));
  liveWatchServiceRefs = [];
  if (appContextRef) {
    await appContextRef.close();
  }
}
