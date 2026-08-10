import * as vscode from "vscode";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Matches the real shape SyncService/DocumentationService produce (see
// preload.ts's RendererMessage) -- ranges are byte offsets into the file's
// raw text, the same convention Monaco used, not line/column.
interface RapidDocsMessage {
  severity: "info" | "warning" | "error";
  text: string;
  relativePath: string;
  recordId: string | null;
  ranges: { start: number; end: number }[];
}

const SEVERITY_MAP: Record<RapidDocsMessage["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

// The one real conversion this layer has to do: a byte offset only means
// something once translated against the ACTUAL current text of the file,
// via a real TextDocument's own positionAt() -- there's no way to compute
// a correct line/column from an offset without the real content in hand.
async function messagesToDiagnosticsByFile(
  messages: RapidDocsMessage[],
  repoPath: string
): Promise<Map<string, vscode.Diagnostic[]>> {
  const byFile = new Map<string, RapidDocsMessage[]>();
  for (const message of messages) {
    const existing = byFile.get(message.relativePath) ?? [];
    existing.push(message);
    byFile.set(message.relativePath, existing);
  }

  const result = new Map<string, vscode.Diagnostic[]>();
  for (const [relativePath, fileMessages] of byFile) {
    const uri = vscode.Uri.file(join(repoPath, relativePath));
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      continue; // file genuinely gone (deleted-file messages reference a path that no longer exists on disk)
    }

    const diagnostics = fileMessages.map((message) => {
      const range =
        message.ranges.length > 0
          ? new vscode.Range(document.positionAt(message.ranges[0].start), document.positionAt(message.ranges[0].end))
          : new vscode.Range(0, 0, 0, 0);
      const diagnostic = new vscode.Diagnostic(range, message.text, SEVERITY_MAP[message.severity]);
      diagnostic.source = "rapid-docs";
      return diagnostic;
    });
    result.set(relativePath, diagnostics);
  }
  return result;
}

// Deliberately writes real, checkable evidence to disk instead of just
// trusting that activation/command-execution happened -- the same
// "prove it, don't assume it" discipline the rest of this project follows.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  writeFileSync(join(tmpdir(), "rapid-docs-activation-proof.txt"), `activated at ${new Date().toISOString()}\n`);
  console.log("rapid-docs: extension activated");

  const diagnosticCollection = vscode.languages.createDiagnosticCollection("rapid-docs");
  context.subscriptions.push(diagnosticCollection);

  const helloDisposable = vscode.commands.registerCommand("rapidDocs.helloWorld", () => {
    const editor = vscode.window.activeTextEditor;
    const fileInfo = editor
      ? `Active file: ${editor.document.fileName}. Selection: "${editor.document.getText(editor.selection) || "(empty)"}"`
      : "No active editor.";

    vscode.window.showInformationMessage(`rapid-docs says hello. ${fileInfo}`);
    writeFileSync(
      join(tmpdir(), "rapid-docs-command-proof.txt"),
      `command ran at ${new Date().toISOString()}\n${fileInfo}\n`
    );
  });
  context.subscriptions.push(helloDisposable);

  // Same dynamic-import pattern electron/main.ts's bootstrapEngine() uses,
  // and for the same reason: dist/app.module.js is a real ES module (root
  // package.json says "type": "module"), and this file compiles to
  // CommonJS, so require() can't load it directly -- only a dynamic
  // import() can bridge a CommonJS file to a genuine ESM one. The relative
  // path depth is identical too: vscode-extension/dist/extension.js sits
  // exactly as many levels under the repo root as electron/dist/main.js does.
  const { NestFactory } = await import("@nestjs/core");
  // @ts-expect-error -- dist/ is a separately-compiled, untyped JS output, same boundary electron/main.ts already crosses
  const { AppModule } = await import("../../dist/app.module.js");
  // @ts-expect-error -- see above
  const { GitService } = await import("../../dist/git/git.service.js");
  // @ts-expect-error -- see above
  const { AstService } = await import("../../dist/ast/ast.service.js");
  // @ts-expect-error -- see above
  const { DocumentationService } = await import("../../dist/ast/documentation.service.js");
  // @ts-expect-error -- see above
  const { SyncService } = await import("../../dist/sync/sync.service.js");
  // @ts-expect-error -- see above
  const { LiveWatchService } = await import("../../dist/sync/live-watch.service.js");

  const appContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const gitService = appContext.get(GitService);
  const astService = appContext.get(AstService);
  const documentationService = appContext.get(DocumentationService);
  const syncService = appContext.get(SyncService);
  const liveWatchService = appContext.get(LiveWatchService);
  // Real evidence the whole DI graph resolved, not just SyncService's own
  // constructor -- ping() and storagePathFor() are cheap, side-effect-free
  // calls that only succeed if each service is a genuine, correctly-wired
  // instance, not just a truthy object.
  console.log(
    "rapid-docs: NestJS backend context created.",
    astService.ping(),
    documentationService.storagePathFor(".", "probe.ts"),
    typeof gitService.getHeadCommit
  );

  const testReconcileDisposable = vscode.commands.registerCommand("rapidDocs.testReconcile", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }

    const repoPath = folder.uri.fsPath;
    const report = syncService.reconcile(repoPath);
    const summary = `reconcile() found ${report.messages.length} message(s).`;
    const firstFew = report.messages
      .slice(0, 5)
      .map((m: { severity: string; text: string; relativePath: string }) => `[${m.severity}] ${m.relativePath}: ${m.text}`)
      .join("\n");

    vscode.window.showInformationMessage(`rapid-docs: ${summary}`);
    writeFileSync(
      join(tmpdir(), "rapid-docs-reconcile-proof.txt"),
      `${new Date().toISOString()}\n${repoPath}\n${summary}\n${firstFew}\n`
    );
  });
  context.subscriptions.push(testReconcileDisposable);

  const testBackendDisposable = vscode.commands.registerCommand("rapidDocs.testBackend", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }

    const repoPath = folder.uri.fsPath;
    const headCommit = gitService.getHeadCommit(repoPath);
    const result = headCommit
      ? `Real GitService.getHeadCommit() returned: ${headCommit}`
      : "GitService.getHeadCommit() returned null (not a git repo, or no commits yet).";

    vscode.window.showInformationMessage(`rapid-docs backend test. ${result}`);
    writeFileSync(join(tmpdir(), "rapid-docs-backend-proof.txt"), `${new Date().toISOString()}\n${repoPath}\n${result}\n`);
  });
  context.subscriptions.push(testBackendDisposable);

  const testDiagnosticsDisposable = vscode.commands.registerCommand("rapidDocs.testDiagnostics", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }

    const repoPath = folder.uri.fsPath;
    const report = syncService.reconcile(repoPath);
    const byFile = await messagesToDiagnosticsByFile(report.messages, repoPath);

    diagnosticCollection.clear();
    let total = 0;
    for (const [relativePath, diagnostics] of byFile) {
      diagnosticCollection.set(vscode.Uri.file(join(repoPath, relativePath)), diagnostics);
      total += diagnostics.length;
    }

    vscode.window.showInformationMessage(
      `rapid-docs: populated ${total} real diagnostics across ${byFile.size} file(s). Check the Problems panel.`
    );
    writeFileSync(
      join(tmpdir(), "rapid-docs-diagnostics-proof.txt"),
      `${new Date().toISOString()}\n${repoPath}\n${total} diagnostics across ${byFile.size} files\n`
    );
  });
  context.subscriptions.push(testDiagnosticsDisposable);

  const testLiveWatchDisposable = vscode.commands.registerCommand("rapidDocs.testLiveWatch", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }

    const repoPath = folder.uri.fsPath;
    liveWatchService.on(
      "messages",
      (relativePaths: string[], messages: { severity: string; text: string; relativePath: string }[]) => {
        writeFileSync(
          join(tmpdir(), "rapid-docs-livewatch-proof.txt"),
          `${new Date().toISOString()}\nchanged: ${relativePaths.join(", ")}\n${messages
            .map((m) => `[${m.severity}] ${m.relativePath}: ${m.text}`)
            .join("\n")}\n`
        );
        vscode.window.showInformationMessage(`rapid-docs live-watch fired for: ${relativePaths.join(", ")}`);
      }
    );
    await liveWatchService.start(repoPath);
    vscode.window.showInformationMessage(`rapid-docs: now live-watching ${repoPath}`);
    writeFileSync(join(tmpdir(), "rapid-docs-livewatch-started-proof.txt"), `started at ${new Date().toISOString()}\n${repoPath}\n`);
  });
  context.subscriptions.push(testLiveWatchDisposable);
}

export function deactivate(): void {}
