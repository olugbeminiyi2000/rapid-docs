import * as vscode from "vscode";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { GitService, SyncService, DocumentationService, LiveWatchService } from "../types";
import { messagesToDiagnosticsByFile } from "../diagnostics/diagnosticsController";

export interface InitialProbesDeps {
  gitService: GitService;
  syncService: SyncService;
  documentationService: DocumentationService;
  liveWatchService: LiveWatchService;
  diagnosticCollection: vscode.DiagnosticCollection;
  documentedDecorationType: vscode.TextEditorDecorationType;
  refreshDocumentedSectionsView: () => Promise<void>;
}

// The original, pre-section-numbering smoke tests: rapidDocs.helloWorld and
// the first hand-rolled probes against each service before the later,
// section-numbered tests (testAstService, testGitService, etc.) existed.
// Kept together since several of them share the same "no workspace open"
// guard and proof-file pattern, not because they're one cohesive feature.
export function registerInitialProbes(context: vscode.ExtensionContext, deps: InitialProbesDeps): void {
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

  const testReconcileDisposable = vscode.commands.registerCommand("rapidDocs.testReconcile", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }

    const repoPath = folder.uri.fsPath;
    const report = deps.syncService.reconcile(repoPath);
    const summary = `reconcile() found ${report.messages.length} message(s).`;
    const firstFew = report.messages
      .slice(0, 5)
      .map((m) => `[${m.severity}] ${m.relativePath}: ${m.text}`)
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
    const headCommit = deps.gitService.getHeadCommit(repoPath);
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
    const report = deps.syncService.reconcile(repoPath);
    const byFile = await messagesToDiagnosticsByFile(report.messages, repoPath);

    deps.diagnosticCollection.clear();
    let total = 0;
    for (const [relativePath, diagnostics] of byFile) {
      deps.diagnosticCollection.set(vscode.Uri.file(join(repoPath, relativePath)), diagnostics);
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
    deps.liveWatchService.on("messages", (relativePaths, messages) => {
      writeFileSync(
        join(tmpdir(), "rapid-docs-livewatch-proof.txt"),
        `${new Date().toISOString()}\nchanged: ${relativePaths.join(", ")}\n${messages
          .map((m) => `[${m.severity}] ${m.relativePath}: ${m.text}`)
          .join("\n")}\n`
      );
      vscode.window.showInformationMessage(`rapid-docs live-watch fired for: ${relativePaths.join(", ")}`);
    });
    await deps.liveWatchService.start(repoPath);
    vscode.window.showInformationMessage(`rapid-docs: now live-watching ${repoPath}`);
    writeFileSync(join(tmpdir(), "rapid-docs-livewatch-started-proof.txt"), `started at ${new Date().toISOString()}\n${repoPath}\n`);
  });
  context.subscriptions.push(testLiveWatchDisposable);

  const testWriteDocDisposable = vscode.commands.registerCommand("rapidDocs.testWriteDoc", async () => {
    const editor = vscode.window.activeTextEditor;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !folder) {
      vscode.window.showWarningMessage("rapid-docs: open a file first.");
      return;
    }
    if (editor.selection.isEmpty) {
      vscode.window.showWarningMessage("rapid-docs: select some code first.");
      return;
    }

    const repoPath = folder.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const start = editor.document.offsetAt(editor.selection.start);
    const end = editor.document.offsetAt(editor.selection.end);

    const { recordId } = deps.documentationService.writeDoc(
      repoPath,
      relativePath,
      start,
      end,
      "Test documentation written from the VSCode extension probe."
    );

    vscode.window.showInformationMessage(`rapid-docs: wrote a real doc record (${recordId}) for ${relativePath}.`);
    writeFileSync(join(tmpdir(), "rapid-docs-writedoc-proof.txt"), `${new Date().toISOString()}\n${relativePath}\n${recordId}\n`);
    await deps.refreshDocumentedSectionsView();
  });
  context.subscriptions.push(testWriteDocDisposable);

  const testDecorationsDisposable = vscode.commands.registerCommand("rapidDocs.testDecorations", () => {
    const editor = vscode.window.activeTextEditor;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !folder) {
      vscode.window.showWarningMessage("rapid-docs: open a file first.");
      return;
    }

    const repoPath = folder.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

    let documentedNodes: { recordId: string; start: number; end: number }[];
    try {
      documentedNodes = deps.documentationService.findDocumentedNodes(repoPath, relativePath);
    } catch (err) {
      vscode.window.showWarningMessage(`rapid-docs: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const ranges = documentedNodes.map(
      (node) => new vscode.Range(editor.document.positionAt(node.start), editor.document.positionAt(node.end))
    );
    editor.setDecorations(deps.documentedDecorationType, ranges);

    vscode.window.showInformationMessage(`rapid-docs: highlighted ${ranges.length} documented region(s) in ${relativePath}.`);
    writeFileSync(
      join(tmpdir(), "rapid-docs-decorations-proof.txt"),
      `${new Date().toISOString()}\n${relativePath}\n${ranges.length} documented region(s)\n`
    );
  });
  context.subscriptions.push(testDecorationsDisposable);
}
