import * as vscode from "vscode";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bootstrapBackend } from "./backend/bootstrap";
import { createDiagnosticsController, activateDiagnosticsLiveWiring } from "./diagnostics/diagnosticsController";
import { registerDocumentedSections } from "./documented-sections/documentedSectionsProvider";
import { registerAllTestCommands } from "./test-commands/registerAll";
import { TestFoundationViewProvider } from "./webviews/testFoundation/testFoundationViewProvider";

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
  // contrast) the user actually has.
  const documentedDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
  });
  context.subscriptions.push(documentedDecorationType);

  const backend = await bootstrapBackend();
  appContextRef = backend.appContext;
  liveWatchServiceRef = backend.liveWatchService;

  const documentedSections = registerDocumentedSections(context, backend.documentationService, documentedDecorationType);
  await documentedSections.refresh();

  // Section 7.1 re-confirmation: this previously only ever ran via manual
  // test commands -- a real user opening the extension got no initial
  // Problems-panel populate and no live updates until they happened to run
  // one themselves. See diagnosticsController.ts for the real, matching-
  // electron/main.ts catch-up-then-watch sequence.
  await activateDiagnosticsLiveWiring(context, diagnosticCollection, backend.syncService, backend.liveWatchService);

  // Section 7.1: the new webview-infrastructure proof, separate from
  // everything above -- see PARITY-CHECKLIST.md Section 7.1.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TestFoundationViewProvider.viewId, new TestFoundationViewProvider())
  );

  registerAllTestCommands(context, {
    backend,
    diagnosticCollection,
    documentedDecorationType,
    refreshDocumentedSectionsView: documentedSections.refresh,
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
