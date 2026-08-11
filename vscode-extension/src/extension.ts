import * as vscode from "vscode";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bootstrapBackend } from "./backend/bootstrap";
import { createDiagnosticsController, activateDiagnosticsLiveWiring } from "./diagnostics/diagnosticsController";
import { createHighlightController } from "./highlighting/highlightController";
import { DocumentedSectionsViewProvider } from "./webviews/documentedSections/documentedSectionsViewProvider";
import { ProblemsViewProvider } from "./webviews/problems/problemsViewProvider";
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
let liveWatchServiceRef: { stop: () => Promise<void> } | null = null;
let appContextRef: { close: () => Promise<void> } | null = null;

// Deliberately writes real, checkable evidence to disk instead of just
// trusting that activation/command-execution happened -- the same "prove
// it, don't assume it" discipline the rest of this project follows.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  writeFileSync(join(tmpdir(), "rapid-docs-activation-proof.txt"), `activated at ${new Date().toISOString()}\n`);
  console.log("rapid-docs: extension activated");

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
  liveWatchServiceRef = backend.liveWatchService;

  const highlightController = createHighlightController(context);
  const activeEditorTracker = createActiveEditorTracker(context);

  // Section 7.2: Documented Sections rebuilt as a Webview (not a TreeView --
  // see PARITY-CHECKLIST.md's 2026-08-11 decision). File-scoped, same as the
  // Electron panel was, so it refreshes whenever the active file changes.
  const documentedSectionsProvider = new DocumentedSectionsViewProvider(backend.documentationService, highlightController, activeEditorTracker);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DocumentedSectionsViewProvider.viewId, documentedSectionsProvider)
  );

  // Section 7.1 (rebuilt 2026-08-11): Problems as a real webview, not just
  // the native DiagnosticCollection -- see problemsViewProvider.ts's own
  // header comment for why (native Problems gives no closure-bound click
  // hook, which is what caused the diagnostic-click bugs; this replicates
  // electron/renderer.js's real mechanism instead of reconstructing state
  // after the fact). diagnosticClickHighlight.ts (the reconstruction-based
  // approach) is retired now that this exists.
  const problemsProvider = new ProblemsViewProvider(backend.documentationService, highlightController, activeEditorTracker, () => documentedSectionsProvider.refresh());
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ProblemsViewProvider.viewId, problemsProvider));

  function onActiveEditorChanged(): void {
    void documentedSectionsProvider.refresh();
    const editor = vscode.window.activeTextEditor;
    const folder = vscode.workspace.workspaceFolders?.[0];
    problemsProvider.setActiveFile(editor && folder ? vscode.workspace.asRelativePath(editor.document.uri, false) : null);
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(onActiveEditorChanged));
  onActiveEditorChanged();

  // Section 7.3: Compose, a real WebviewPanel opened beside the editor
  // (not docked in the sidebar) per the 2026-08-11 decision, so code and
  // the compose form stay visible together.
  registerComposeCommands(context, {
    documentationService: backend.documentationService,
    highlightController,
    refreshDocumentedSections: () => documentedSectionsProvider.refresh(),
    activeEditorTracker,
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
    documentedSectionsProvider,
    highlightController,
    refreshDocumentedSections: () => documentedSectionsProvider.refresh(),
  });

  // Section 7.1 re-confirmation: this previously only ever ran via manual
  // test commands -- a real user opening the extension got no initial
  // Problems-panel populate and no live updates until they happened to run
  // one themselves. See diagnosticsController.ts for the real, matching-
  // electron/main.ts catch-up-then-watch sequence. Also feeds problemsProvider
  // the full, repo-wide message list (electron's own messagesByFile
  // equivalent), not just the native DiagnosticCollection.
  await activateDiagnosticsLiveWiring(context, diagnosticCollection, backend.syncService, backend.liveWatchService, problemsProvider);

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
  if (liveWatchServiceRef) {
    await liveWatchServiceRef.stop();
  }
  if (appContextRef) {
    await appContextRef.close();
  }
  writeFileSync(join(tmpdir(), "rapid-docs-deactivate-proof.txt"), `deactivated at ${new Date().toISOString()}\n`);
}
