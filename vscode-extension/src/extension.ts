import * as vscode from "vscode";
import { writeFileSync, mkdtempSync, rmSync, unlinkSync, existsSync, renameSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

// Module-scoped (not local to activate()) specifically so deactivate() can
// reach them for real cleanup -- electron/main.ts never had to solve this,
// its process just exits and the OS reclaims everything, but an extension
// can be deactivated while VSCode itself keeps running (workspace closed,
// extension disabled, VSCode reloaded), so leaving the watcher running and
// the Nest context open would be a genuine, real resource leak, not a
// hypothetical one.
let liveWatchServiceRef: { stop: () => Promise<void> } | null = null;
let appContextRef: { close: () => Promise<void> } | null = null;

// Matches AstService's own real RawFoundNode shape (src/ast/ast.service.ts).
interface RawFoundNodeLike {
  type: string;
  start: number;
  end: number;
  loc: unknown;
  node: unknown;
}

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

interface DocumentedSectionItem {
  recordId: string;
  relativePath: string;
  start: number;
  end: number;
  docText: string;
  startLine: number; // 0-based, for the tree row's own description
}

// Replicates electron/main.ts's "docs:findDocumentedNodes" handler exactly
// (lines 200-222), not just DocumentationService.findDocumentedNodes()
// alone -- that method returns one entry PER MATCHED AST NODE (a single
// writeDoc call typically matches many nested nodes sharing one recordId),
// and has no docText at all. The real IPC handler collapses to one row per
// recordId and separately attaches docText from loadStorage; that glue
// logic lives in electron/main.ts, not in src/, so it has to be
// reimplemented here rather than assumed covered by the backend reuse.
async function collectDocumentedSections(
  documentationService: { findDocumentedNodes: (repoPath: string, relativePath: string) => { recordId: string; start: number; end: number }[]; loadStorage: (repoPath: string, relativePath: string) => { records: Record<string, { docText: string }> } },
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

class DocumentedSectionsProvider implements vscode.TreeDataProvider<DocumentedSectionItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private items: DocumentedSectionItem[] = [];

  setItems(items: DocumentedSectionItem[]): void {
    this.items = items;
    this.emitter.fire();
  }

  getTreeItem(element: DocumentedSectionItem): vscode.TreeItem {
    const label = element.docText.length > 60 ? `${element.docText.slice(0, 60)}...` : element.docText;
    const item = new vscode.TreeItem(label || "(no text)", vscode.TreeItemCollapsibleState.None);
    item.description = `line ${element.startLine + 1}`;
    item.contextValue = "rapidDocsSection"; // matched by the view/item/context "when" clause in package.json
    item.command = { command: "rapidDocs.revealDocumentedSection", title: "Reveal", arguments: [element] };
    return item;
  }

  getChildren(): DocumentedSectionItem[] {
    return this.items;
  }
}

// Deliberately writes real, checkable evidence to disk instead of just
// trusting that activation/command-execution happened -- the same
// "prove it, don't assume it" discipline the rest of this project follows.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  writeFileSync(join(tmpdir(), "rapid-docs-activation-proof.txt"), `activated at ${new Date().toISOString()}\n`);
  console.log("rapid-docs: extension activated");

  const diagnosticCollection = vscode.languages.createDiagnosticCollection("rapid-docs");
  context.subscriptions.push(diagnosticCollection);

  // No native VSCode concept covers this: Diagnostics is only for
  // problems, there's nothing built in for "this code is fine, and
  // here's proof it's documented." insertedTextBackground is a real,
  // already-themed VSCode color (used for diff-added lines), reused here
  // rather than picking an arbitrary color, so it adapts to whatever
  // theme (light/dark/high-contrast) the user actually has.
  const documentedDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
  });
  context.subscriptions.push(documentedDecorationType);

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
  appContextRef = appContext;
  const gitService = appContext.get(GitService);
  const astService = appContext.get(AstService);
  const documentationService = appContext.get(DocumentationService);
  const syncService = appContext.get(SyncService);
  const liveWatchService = appContext.get(LiveWatchService);
  liveWatchServiceRef = liveWatchService;
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

  // Documented Sections: file-scoped, same as the Electron panel was
  // (findDocumentedNodes takes one relativePath, not the whole repo), so
  // it refreshes whenever the active file changes, not just on demand.
  const documentedSectionsProvider = new DocumentedSectionsProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("rapidDocsDocumentedSections", documentedSectionsProvider));

  async function refreshDocumentedSectionsView(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !folder) {
      documentedSectionsProvider.setItems([]);
      return;
    }
    const repoPath = folder.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    try {
      const items = await collectDocumentedSections(documentationService, repoPath, relativePath);
      documentedSectionsProvider.setItems(items);
    } catch {
      documentedSectionsProvider.setItems([]); // file doesn't parse right now, same as the Electron panel going quiet on a broken file
    }
  }

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => void refreshDocumentedSectionsView()));
  await refreshDocumentedSectionsView();

  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.revealDocumentedSection", async (item: DocumentedSectionItem) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const range = new vscode.Range(editor.document.positionAt(item.start), editor.document.positionAt(item.end));
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.setDecorations(documentedDecorationType, [range]);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.copyDocumentedSection", async (item: DocumentedSectionItem) => {
      await vscode.env.clipboard.writeText(item.docText);
      vscode.window.showInformationMessage("rapid-docs: documentation text copied.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("rapidDocs.deleteDocumentedSection", async (item: DocumentedSectionItem) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      documentationService.deleteRecord(folder.uri.fsPath, item.relativePath, item.recordId);
      vscode.window.showInformationMessage(`rapid-docs: deleted documentation record ${item.recordId}.`);
      await refreshDocumentedSectionsView();
    })
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

    const { recordId } = documentationService.writeDoc(
      repoPath,
      relativePath,
      start,
      end,
      "Test documentation written from the VSCode extension probe."
    );

    vscode.window.showInformationMessage(`rapid-docs: wrote a real doc record (${recordId}) for ${relativePath}.`);
    writeFileSync(join(tmpdir(), "rapid-docs-writedoc-proof.txt"), `${new Date().toISOString()}\n${relativePath}\n${recordId}\n`);
    await refreshDocumentedSectionsView();
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

    let documentedNodes: { recordId: string; type: string; start: number; end: number }[];
    try {
      documentedNodes = documentationService.findDocumentedNodes(repoPath, relativePath);
    } catch (err) {
      vscode.window.showWarningMessage(`rapid-docs: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const ranges = documentedNodes.map(
      (node) => new vscode.Range(editor.document.positionAt(node.start), editor.document.positionAt(node.end))
    );
    editor.setDecorations(documentedDecorationType, ranges);

    vscode.window.showInformationMessage(`rapid-docs: highlighted ${ranges.length} documented region(s) in ${relativePath}.`);
    writeFileSync(
      join(tmpdir(), "rapid-docs-decorations-proof.txt"),
      `${new Date().toISOString()}\n${relativePath}\n${ranges.length} documented region(s)\n`
    );
  });
  context.subscriptions.push(testDecorationsDisposable);

  // Section 2 (AstService) of the parity checklist -- ping() was already
  // exercised with real evidence during Section 1's DI-graph proof, and
  // parseSource/walkAllNodes/hashNode are all exercised transitively by
  // reconcile()/decorations/Documented Sections, but none of the five
  // methods had been asserted against KNOWN, real, self-verified output
  // directly. Chained together here against one real sample, in the order
  // they actually depend on each other: parse -> walk -> filter -> name -> hash.
  const testAstServiceDisposable = vscode.commands.registerCommand("rapidDocs.testAstService", () => {
    const sample = `@Injectable()
class GreetingService {
  greet(name: string): string {
    return "Hello, " + name;
  }
}
`;
    const lines: string[] = [];

    // parseSource -- re-confirms the decorators-legacy fix through THIS
    // exact integration path, not just the isolated Jest suite.
    const parseResult = astService.parseSource(sample, "greeting.service.ts");
    lines.push(`parseSource: fatal=${parseResult.fatal}, ast=${parseResult.ast !== null ? "present" : "null"}, errors=${parseResult.errors.length}`);
    if (!parseResult.ast) {
      writeFileSync(join(tmpdir(), "rapid-docs-astservice-proof.txt"), lines.join("\n"));
      vscode.window.showErrorMessage("rapid-docs: AstService test failed at parseSource, see proof file.");
      return;
    }

    // walkAllNodes -- real node count off a real parse.
    const allNodes = astService.walkAllNodes((parseResult.ast as { program: { body: unknown } }).program.body);
    lines.push(`walkAllNodes: found ${allNodes.size} real nodes`);

    // extractName -- find the real "greet" ClassMethod among the walked nodes and confirm its name resolves correctly.
    let greetNode: RawFoundNodeLike | null = null;
    for (const entry of allNodes.values()) {
      if (entry.type === "ClassMethod") {
        greetNode = entry;
        break;
      }
    }
    const extractedName = greetNode ? astService.extractName(greetNode.node) : null;
    lines.push(`extractName on the real ClassMethod node: "${extractedName}" (expected "greet")`);

    // filterByHighlight -- narrow to just the ClassMethod's own span, confirm containment is respected.
    const filtered = greetNode ? astService.filterByHighlight(allNodes, greetNode.start, greetNode.end) : [];
    const allContained = greetNode ? filtered.every((n: RawFoundNodeLike) => n.start >= greetNode!.start && n.end <= greetNode!.end) : false;
    lines.push(`filterByHighlight: ${filtered.length} node(s) inside the method's own range, all correctly contained=${allContained}`);

    // hashNode -- determinism (same node twice -> same hash) and distinctness (different node -> different hash).
    const hash1 = greetNode ? astService.hashNode(greetNode.node) : null;
    const hash2 = greetNode ? astService.hashNode(greetNode.node) : null;
    const otherNode = [...allNodes.values()].find((n: RawFoundNodeLike) => n !== greetNode);
    const otherHash = otherNode ? astService.hashNode(otherNode.node) : null;
    lines.push(`hashNode determinism: hash1 === hash2 = ${hash1 === hash2}`);
    lines.push(`hashNode distinctness: hash(greet) !== hash(other) = ${hash1 !== otherHash}`);
    lines.push(`sample hash: ${hash1}`);

    const summary = `AstService: ${allNodes.size} nodes, name="${extractedName}", filter=${filtered.length}, hash deterministic=${hash1 === hash2}`;
    vscode.window.showInformationMessage(`rapid-docs: ${summary}`);
    writeFileSync(join(tmpdir(), "rapid-docs-astservice-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
  });
  context.subscriptions.push(testAstServiceDisposable);

  // Section 3 (GitService), the remaining methods beyond getHeadCommit.
  // diff() is checked against this repo's OWN real, current git history
  // (HEAD vs HEAD~1, computed fresh via raw git calls here in the test
  // harness itself, not hardcoded commit hashes that would go stale the
  // moment another commit lands), and getLastSyncedCommit/setLastSyncedCommit
  // use a genuinely disposable scratch git repo, so this never touches this
  // real repo's own .git/rapid-docs/last-sync.json pointer.
  const testGitServiceDisposable = vscode.commands.registerCommand("rapidDocs.testGitService", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }
    const repoPath = folder.uri.fsPath;
    const lines: string[] = [];

    // Whatever succeeded before a failure stays on record -- losing every
    // earlier result just because a later step throws would defeat the
    // whole point of writing real evidence per step.
    try {
      const tracked = gitService.listTrackedFiles(repoPath);
      lines.push(`listTrackedFiles: ${tracked.length} files, includes package.json=${tracked.includes("package.json")}`);

      const workingTree = gitService.listWorkingTreeFiles(repoPath);
      lines.push(`listWorkingTreeFiles: ${workingTree.length} files, includes package.json=${workingTree.includes("package.json")}`);

      const ignored = gitService.listIgnoredPaths(repoPath);
      const hasNodeModules = ignored.some((p: string) => p.includes("node_modules"));
      lines.push(`listIgnoredPaths: ${ignored.length} entries, includes node_modules=${hasNodeModules}`);

      // getLastSyncedCommit / setLastSyncedCommit -- disposable scratch repo.
      const scratchDir = mkdtempSync(join(tmpdir(), "rapid-docs-gitservice-scratch-"));
      try {
        execFileSync("git", ["init"], { cwd: scratchDir });
        execFileSync("git", ["config", "user.email", "test@rapid-docs.local"], { cwd: scratchDir });
        execFileSync("git", ["config", "user.name", "rapid-docs test"], { cwd: scratchDir });
        writeFileSync(join(scratchDir, "a.txt"), "hello");
        execFileSync("git", ["add", "."], { cwd: scratchDir });
        execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir });

        const beforeSet = gitService.getLastSyncedCommit(scratchDir);
        gitService.setLastSyncedCommit(scratchDir, "abc123deadbeef");
        const afterSet = gitService.getLastSyncedCommit(scratchDir);
        lines.push(`getLastSyncedCommit before any set: ${beforeSet} (expected null)`);
        lines.push(`setLastSyncedCommit + getLastSyncedCommit round-trip: ${afterSet} (expected "abc123deadbeef")`);
      } finally {
        // Windows can hold a file lock on something inside .git/ for longer
        // than the retry budget can cover (confirmed for real: even 5
        // retries at 200ms wasn't enough once). This cleanup failing is
        // never allowed to mask the actual GitService results gathered
        // above -- a leftover scratch dir in the OS temp folder is
        // harmless, but losing real evidence because of it is not.
        try {
          rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (cleanupErr) {
          lines.push(
            `(non-fatal) failed to remove scratch dir ${scratchDir}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
          );
        }
      }

      // diff() against this repo's OWN real current history.
      const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim();
      const parentHead = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: repoPath, encoding: "utf-8" }).trim();
      const expectedChanged = execFileSync("git", ["diff", "--name-only", parentHead, currentHead], { cwd: repoPath, encoding: "utf-8" })
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      const diffResult = gitService.diff(repoPath, parentHead, currentHead);
      const actualChanged = [...diffResult.added, ...diffResult.modified, ...diffResult.deleted, ...diffResult.renamed.map((r: { to: string }) => r.to)].sort();
      const diffMatches = JSON.stringify(expectedChanged) === JSON.stringify(actualChanged);
      lines.push(`diff(HEAD~1, HEAD): expected changed files ${JSON.stringify(expectedChanged)}, got ${JSON.stringify(actualChanged)}, matches=${diffMatches}`);

      // compareContent -- no repo needed at all.
      const similar = gitService.compareContent("function greet() {\n  return 'hi';\n}\n", "function greet() {\n  return 'hi there';\n}\n");
      const different = gitService.compareContent("function greet() {\n  return 'hi';\n}\n", "class TotallyUnrelated {}\n");
      lines.push(`compareContent on similar content: ${JSON.stringify(similar)} (expected a real similarity match)`);
      lines.push(`compareContent on unrelated content: ${JSON.stringify(different)} (expected null)`);

      const summary = `GitService: tracked=${tracked.length}, ignored=${ignored.length}, syncPointer round-trip ok, diff matches=${diffMatches}`;
      vscode.window.showInformationMessage(`rapid-docs: ${summary}`);
    } catch (err) {
      lines.push(`ERROR: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      vscode.window.showErrorMessage(`rapid-docs: GitService test failed partway, see proof file for what succeeded before that.`);
    } finally {
      writeFileSync(join(tmpdir(), "rapid-docs-gitservice-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
    }
  });
  context.subscriptions.push(testGitServiceDisposable);

  // Section 4 (DocumentationService), the biggest section: the 9 methods
  // never exercised by writeDoc/findDocumentedNodes/deleteRecord alone.
  // Uses three disposable scratch files inside the real workspace (needed
  // since every one of these methods reads real file content off disk),
  // all removed in a finally block regardless of where the test stops.
  const testDocumentationServiceDisposable = vscode.commands.registerCommand("rapidDocs.testDocumentationService", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }
    const repoPath = folder.uri.fsPath;
    const lines: string[] = [];
    const relA = "vscode-extension/src/__docservice_test_a__.ts";
    const relARenamed = "vscode-extension/src/__docservice_test_a_renamed__.ts";
    const relB = "vscode-extension/src/__docservice_test_b__.ts";
    const relC = "vscode-extension/src/__docservice_test_c__.ts";
    const absA = join(repoPath, relA);
    const absB = join(repoPath, relB);
    const absC = join(repoPath, relC);

    const relBroken = "vscode-extension/src/__docservice_test_broken__.ts";
    const absBroken = join(repoPath, relBroken);

    const relD = "vscode-extension/src/__docservice_test_d__.ts";
    const absD = join(repoPath, relD);

    try {
      // --- writeDoc + findRecordForSelection (found / not found) ---
      const originalContent = "function calculate(a, b) {\n  const sum = a + b;\n  return sum;\n}\n";
      writeFileSync(absA, originalContent);
      const { recordId: recordId1 } = documentationService.writeDoc(repoPath, relA, 0, originalContent.length, "Adds two numbers.");
      lines.push(`writeDoc: wrote record ${recordId1}`);

      // --- writeDoc: refuses the exact same highlight twice -- a real
      // duplicate-prevention guard, never exercised before this. ---
      let duplicateRejected = false;
      try {
        documentationService.writeDoc(repoPath, relA, 0, originalContent.length, "Duplicate attempt.");
      } catch {
        duplicateRejected = true;
      }
      lines.push(`writeDoc duplicate rejection (same file, same exact selection, twice): threw=${duplicateRejected} (expected true)`);

      // --- findRecordForSelection: finds a record even when the selection
      // is LOOSER (wider) than the exact node boundary that was documented
      // -- the actual real-world case, since a human drag-selection almost
      // never lands exactly on an AST node's precise start/end. Uses a
      // separate file whose documented span deliberately excludes trailing
      // blank lines, then queries with a selection that includes them. ---
      const functionOnly = "function loose() {\n  return 42;\n}\n";
      const contentD = functionOnly + "\n\n";
      writeFileSync(absD, contentD);
      const { recordId: recordIdD } = documentationService.writeDoc(repoPath, relD, 0, functionOnly.length, "Loose selection test.");
      const looseMatch = documentationService.findRecordForSelection(repoPath, relD, 0, contentD.length);
      lines.push(
        `findRecordForSelection (selection wider than the exact documented node span): ${looseMatch ? `found ${looseMatch.recordId}, matches=${looseMatch.recordId === recordIdD}` : "null (WRONG, expected a match despite the looser boundary)"}`
      );

      // --- deleteRecord: throws for a nonexistent record id -- every prior
      // test only exercised the success path. ---
      let deleteNonexistentThrew = false;
      try {
        documentationService.deleteRecord(repoPath, relD, "nonexistent-record-id-xyz");
      } catch {
        deleteNonexistentThrew = true;
      }
      lines.push(`deleteRecord on a nonexistent record id: threw=${deleteNonexistentThrew} (expected true)`);

      // --- canParseFile: real parseable file (true) and a genuinely broken one (false) ---
      const canParseGood = documentationService.canParseFile(repoPath, relA);
      writeFileSync(absBroken, "function broken( {{{ this is not valid syntax at all");
      const canParseBad = documentationService.canParseFile(repoPath, relBroken);
      lines.push(`canParseFile: real parseable file=${canParseGood} (expected true), genuinely broken file=${canParseBad} (expected false)`);

      // --- listDocumentedFileIds: confirm it includes the file we just documented ---
      const documentedIdsAfterA = documentationService.listDocumentedFileIds(repoPath);
      lines.push(`listDocumentedFileIds (after documenting A only): includes relA=${documentedIdsAfterA.includes(relA)}`);

      const foundMatch = documentationService.findRecordForSelection(repoPath, relA, 0, originalContent.length);
      lines.push(`findRecordForSelection (exact match): ${foundMatch ? `found ${foundMatch.recordId}, matches written record=${foundMatch.recordId === recordId1}` : "null (WRONG, expected a match)"}`);

      const noMatch = documentationService.findRecordForSelection(repoPath, relA, 0, 1);
      lines.push(`findRecordForSelection (trivial 1-char selection): ${noMatch === null ? "null (correct, no record)" : "found something (WRONG)"}`);

      // --- drift a PART of the function, keeping the "const sum = a + b;" statement untouched ---
      const driftedContent = "function calculate(a, b) {\n  const sum = a + b;\n  return sum * 2;\n}\n";
      writeFileSync(absA, driftedContent);
      const report = documentationService.checkFile(repoPath, relA);
      const drift = report.driftResults.find((d: { recordId: string }) => d.recordId === recordId1);
      lines.push(`checkFile after drift: status=${drift?.status} (expected "partially_stale"), matchingRanges=${drift?.matchingRanges.length ?? 0}`);

      // --- findStaleRecordForSelection, using the REAL matchingRanges checkFile just reported, not a predicted range ---
      let recordId2: string | null = null;
      if (drift && drift.status === "partially_stale" && drift.matchingRanges.length > 0) {
        const anchor = drift.matchingRanges[0];
        const staleMatch = documentationService.findStaleRecordForSelection(repoPath, relA, anchor.start, anchor.end);
        lines.push(`findStaleRecordForSelection (real anchor range): ${staleMatch ? `found ${staleMatch.recordId}, matches=${staleMatch.recordId === recordId1}` : "null (WRONG)"}`);

        // --- updateDriftedDoc: resolve the drift in one step ---
        const updated = documentationService.updateDriftedDoc(repoPath, relA, recordId1, 0, driftedContent.length, "Adds two numbers, doubled.");
        const newRecordId: string = updated.recordId;
        recordId2 = newRecordId;
        const storageAfterUpdate = documentationService.loadStorage(repoPath, relA);
        lines.push(
          `updateDriftedDoc: new record ${newRecordId}, old record ${recordId1} gone=${!storageAfterUpdate.records[recordId1]}, new record present=${!!storageAfterUpdate.records[newRecordId]}`
        );
      } else {
        lines.push(`SKIPPED findStaleRecordForSelection/updateDriftedDoc: drift didn't come back as expected, see status above.`);
      }

      // --- editDocText ---
      if (recordId2) {
        documentationService.editDocText(repoPath, relA, recordId2, "Adds two numbers, doubled. Edited.");
        const storageAfterEdit = documentationService.loadStorage(repoPath, relA);
        lines.push(`editDocText: docText now = "${storageAfterEdit.records[recordId2]?.docText}"`);
      }

      // --- renameFile (storage-only migration) ---
      documentationService.renameFile(repoPath, relA, relARenamed);
      const oldStorageGone = !existsSync(documentationService.storagePathFor(repoPath, relA));
      const newStorageExists = existsSync(documentationService.storagePathFor(repoPath, relARenamed));
      lines.push(`renameFile: old storage gone=${oldStorageGone}, new storage exists=${newStorageExists}`);

      // --- handleDeletedFile (file A, now at its renamed path) -> produces archive entry #1 ---
      const deleteMessagesA = documentationService.handleDeletedFile(repoPath, relARenamed);
      lines.push(`handleDeletedFile (A): ${deleteMessagesA.length} message(s) returned, storage removed=${!existsSync(documentationService.storagePathFor(repoPath, relARenamed))}`);

      // --- a second, independent documented-then-deleted file -> archive entry #2 ---
      const contentB = "const greeting = \"hi\";\n";
      writeFileSync(absB, contentB);
      documentationService.writeDoc(repoPath, relB, 0, contentB.length, "A greeting constant.");

      // --- listDocumentedFileIds again: confirms it tracks REAL current state, not a stale snapshot -- A is gone (archived above), B is now the one documented ---
      const documentedIdsAfterB = documentationService.listDocumentedFileIds(repoPath);
      lines.push(
        `listDocumentedFileIds (after A archived, B documented): includes relB=${documentedIdsAfterB.includes(relB)}, no longer includes relARenamed=${!documentedIdsAfterB.includes(relARenamed)}`
      );

      const deleteMessagesB = documentationService.handleDeletedFile(repoPath, relB);
      lines.push(`handleDeletedFile (B): ${deleteMessagesB.length} message(s) returned`);

      // --- loadArchive: confirm both real entries are there ---
      const archiveAfterBoth = documentationService.loadArchive(repoPath);
      const entryA = archiveAfterBoth.find((e: { originalFileId: string }) => e.originalFileId === relARenamed);
      const entryB = archiveAfterBoth.find((e: { originalFileId: string }) => e.originalFileId === relB);
      lines.push(`loadArchive: ${archiveAfterBoth.length} total entries, entry for A present=${!!entryA}, entry for B present=${!!entryB}`);

      // --- attachArchivedRecord: reattach A's archived text onto fresh code in file C ---
      if (entryA) {
        const contentC = "function unrelated() {\n  return 1;\n}\n";
        writeFileSync(absC, contentC);
        const attached = documentationService.attachArchivedRecord(repoPath, entryA.id, relC, 0, contentC.length);
        const archiveAfterAttach = documentationService.loadArchive(repoPath);
        lines.push(
          `attachArchivedRecord: new record ${attached.recordId} with docText "${attached.record.docText}", archive shrank ${archiveAfterBoth.length} -> ${archiveAfterAttach.length}`
        );
      }

      // --- discardArchivedRecord: permanently discard B's entry ---
      if (entryB) {
        documentationService.discardArchivedRecord(repoPath, entryB.id);
        const archiveAfterDiscard = documentationService.loadArchive(repoPath);
        const stillThere = archiveAfterDiscard.some((e: { id: string }) => e.id === entryB.id);
        lines.push(`discardArchivedRecord: entry still present afterward=${stillThere} (expected false)`);
      }

      vscode.window.showInformationMessage("rapid-docs: DocumentationService section test finished, see proof file for full results.");
    } catch (err) {
      lines.push(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      vscode.window.showErrorMessage("rapid-docs: DocumentationService test failed partway, see proof file for what succeeded before that.");
    } finally {
      for (const abs of [absA, absB, absC, absBroken, absD]) {
        try {
          if (existsSync(abs)) unlinkSync(abs);
        } catch {
          /* non-fatal, matches the GitService lesson: cleanup failure must never mask real evidence */
        }
      }
      writeFileSync(join(tmpdir(), "rapid-docs-documentationservice-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
    }
  });
  context.subscriptions.push(testDocumentationServiceDisposable);

  // Section 5 (SyncService): sync() [only reconcile() was tested before],
  // handleFileEvent, handleRenameEvent, checkFileOnDemand. sync()'s real
  // branches (no commits yet / first-ever full scan / already up to date /
  // a genuine commit diff with a rename) need actual git history under
  // control, so a disposable scratch repo is used, never this real repo's
  // own commits or sync pointer.
  const testSyncServiceDisposable = vscode.commands.registerCommand("rapidDocs.testSyncService", () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("rapid-docs: no workspace folder open.");
      return;
    }
    const repoPath = folder.uri.fsPath;
    const lines: string[] = [];
    const scratchDir = mkdtempSync(join(tmpdir(), "rapid-docs-syncservice-scratch-"));
    const relSmall = "vscode-extension/src/__syncservice_test_small__.ts";
    const relLarge = "vscode-extension/src/__syncservice_test_large__.ts";
    const absSmall = join(repoPath, relSmall);
    const absLarge = join(repoPath, relLarge);

    try {
      // --- sync() branch 1: no commits yet ---
      execFileSync("git", ["init"], { cwd: scratchDir });
      execFileSync("git", ["config", "user.email", "test@rapid-docs.local"], { cwd: scratchDir });
      execFileSync("git", ["config", "user.name", "rapid-docs test"], { cwd: scratchDir });
      const reportNoCommits = syncService.sync(scratchDir);
      lines.push(`sync() with zero commits: ${reportNoCommits.messages.length} message(s) (expected 0)`);

      // --- sync() branch 2: first-ever sync -> fullScan ---
      writeFileSync(join(scratchDir, "a.ts"), "export function alpha() {\n  return 1;\n}\n");
      execFileSync("git", ["add", "."], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "first"], { cwd: scratchDir });
      const reportFirstScan = syncService.sync(scratchDir);
      const pointerAfterFirst = gitService.getLastSyncedCommit(scratchDir);
      const headAfterFirst = gitService.getHeadCommit(scratchDir);
      lines.push(
        `sync() first-ever (fullScan): ${reportFirstScan.messages.length} message(s) (expected >=1, real undocumented function), pointer set correctly=${pointerAfterFirst === headAfterFirst}`
      );

      // --- sync() branch 3: already up to date ---
      const reportUpToDate = syncService.sync(scratchDir);
      lines.push(`sync() immediately again, no new commits: ${reportUpToDate.messages.length} message(s) (expected 0)`);

      // --- sync() branch 4: a real commit diff, WITH a rename + a modification, and real storage to migrate ---
      const { recordId: scratchRecordId } = documentationService.writeDoc(scratchDir, "a.ts", 0, "export function alpha() {\n  return 1;\n}\n".length, "Documents alpha.");
      execFileSync("git", ["mv", "a.ts", "a-renamed.ts"], { cwd: scratchDir });
      writeFileSync(join(scratchDir, "b.ts"), "export function beta() {\n  return 2;\n}\n");
      execFileSync("git", ["add", "."], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "rename a, add b"], { cwd: scratchDir });
      const reportDiff = syncService.sync(scratchDir);
      const oldStorageGone = !existsSync(documentationService.storagePathFor(scratchDir, "a.ts"));
      const newStorageExists = existsSync(documentationService.storagePathFor(scratchDir, "a-renamed.ts"));
      const migratedStorage = documentationService.loadStorage(scratchDir, "a-renamed.ts");
      lines.push(
        `sync() real diff (rename a->a-renamed + add b): ${reportDiff.messages.length} message(s), old storage gone=${oldStorageGone}, new storage exists=${newStorageExists}, record survived migration=${!!migratedStorage.records[scratchRecordId]}`
      );

      // --- sync() branch 4b: a real commit that DELETES a tracked,
      // documented file -- neither GitService.diff()'s "D" status parsing
      // nor sync()'s own diffResult.deleted loop (calling handleDeletedFile)
      // had ever been exercised before this; handleFileEvent's delete
      // branch tested above is a completely different, LIVE-filesystem
      // code path, not this commit-based one. ---
      execFileSync("git", ["rm", "a-renamed.ts"], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "delete a-renamed"], { cwd: scratchDir });
      const reportDeleteCommit = syncService.sync(scratchDir);
      const archiveAfterDeleteCommit = documentationService.loadArchive(scratchDir);
      const migratedFileArchived = archiveAfterDeleteCommit.some((e: { originalFileId: string }) => e.originalFileId === "a-renamed.ts");
      lines.push(
        `sync() real diff (commit deletes a-renamed.ts): ${reportDeleteCommit.messages.length} message(s), archived via diffResult.deleted loop=${migratedFileArchived}`
      );

      // --- reconcile()'s OWN "detect a deleted-but-still-documented file"
      // loop (listDocumentedFileIds + existsSync), specifically the gap
      // reconcile() exists to catch per its own doc comment: something
      // deleted while the app was closed, never committed, never seen live
      // by handleFileEvent either. The ONLY prior reconcile() test (Section
      // 1) ran against a repo with zero prior documentation, so this exact
      // loop body had never actually executed with real data before now. ---
      writeFileSync(join(scratchDir, "r.ts"), "export function rFunc() {\n  return \"r\";\n}\n");
      documentationService.writeDoc(scratchDir, "r.ts", 0, "export function rFunc() {\n  return \"r\";\n}\n".length, "Documents rFunc.");
      unlinkSync(join(scratchDir, "r.ts")); // real filesystem delete, no git, no handleFileEvent involved
      const reconcileReport = syncService.reconcile(scratchDir);
      const archiveAfterReconcile = documentationService.loadArchive(scratchDir);
      const rFileArchived = archiveAfterReconcile.some((e: { originalFileId: string }) => e.originalFileId === "r.ts");
      lines.push(
        `reconcile() detecting a deleted-but-still-documented file (r.ts, never committed, never seen live): ${reconcileReport.messages.length} message(s), archived=${rFileArchived}`
      );

      // --- sync() branch 4c: the diff loop specifically (not fullScan)
      // skipping a large, undocumented, newly-added file -- a different
      // code path from both fullScan (branch 2 above) and
      // checkFileOnDemand (tested below), never independently confirmed
      // to reach the same shared skip logic before now. ---
      const largePaddingDiff = "// padding\n".repeat(10_000);
      writeFileSync(join(scratchDir, "large-diff-undocumented.ts"), `${largePaddingDiff}export function largeDiffFunc() {\n  return 1;\n}\n`);
      execFileSync("git", ["add", "."], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "add large undocumented file"], { cwd: scratchDir });
      const reportLargeDiff = syncService.sync(scratchDir);
      const largeFlaggedInDiff = reportLargeDiff.messages.some((m: { relativePath: string }) => m.relativePath === "large-diff-undocumented.ts");
      lines.push(
        `sync() diff loop skip: newly-added large-undocumented file via a real commit diff (not fullScan) skipped=${!largeFlaggedInDiff} (expected true, i.e. NOT flagged)`
      );

      // --- reconcile() does NOT correlate an uncommitted rename. Unlike
      // sync()'s git-diff-based rename detection, reconcile() has no git
      // history to correlate against (nothing here was ever committed), so
      // a rename performed entirely while nothing was watching must be
      // indistinguishable from an unrelated delete + add. ---
      const contentRen = "export function renFunc() {\n  return \"ren\";\n}\n";
      writeFileSync(join(scratchDir, "ren-original.ts"), contentRen);
      documentationService.writeDoc(scratchDir, "ren-original.ts", 0, contentRen.length, "Documents renFunc.");
      unlinkSync(join(scratchDir, "ren-original.ts"));
      writeFileSync(join(scratchDir, "ren-new.ts"), contentRen); // raw fs rename, no git mv, no handleRenameEvent involved
      const reconcileRenameReport = syncService.reconcile(scratchDir);
      const archiveAfterRenameReconcile = documentationService.loadArchive(scratchDir);
      const originalArchived = archiveAfterRenameReconcile.some((e: { originalFileId: string }) => e.originalFileId === "ren-original.ts");
      const newFileFlaggedUndocumented = reconcileRenameReport.messages.some((m: { relativePath: string }) => m.relativePath === "ren-new.ts");
      lines.push(
        `reconcile() on an uncommitted rename (no git mv involved): old path archived=${originalArchived}, new path flagged as unrelated undocumented file=${newFileFlaggedUndocumented} (expected both true -- reconcile does NOT correlate renames)`
      );

      // --- handleFileEvent: file exists (real check) ---
      writeFileSync(absSmall, "export function gamma() {\n  return 3;\n}\n");
      const eventExists = syncService.handleFileEvent(repoPath, relSmall);
      lines.push(`handleFileEvent (file exists): ${eventExists.length} message(s) (expected >=1, real undocumented function)`);

      // --- handleFileEvent: file deleted, with real prior documentation to archive ---
      documentationService.writeDoc(repoPath, relSmall, 0, "export function gamma() {\n  return 3;\n}\n".length, "Documents gamma.");
      unlinkSync(absSmall);
      const eventDeleted = syncService.handleFileEvent(repoPath, relSmall);
      const archiveAfterDelete = documentationService.loadArchive(repoPath);
      const hasGammaArchiveEntry = archiveAfterDelete.some((e: { originalFileId: string }) => e.originalFileId === relSmall);
      lines.push(`handleFileEvent (file deleted): ${eventDeleted.length} message(s), archived=${hasGammaArchiveEntry}`);
      if (hasGammaArchiveEntry) {
        const entry = archiveAfterDelete.find((e: { originalFileId: string }) => e.originalFileId === relSmall)!;
        documentationService.discardArchivedRecord(repoPath, entry.id);
      }

      // --- handleRenameEvent (real repo, no git involved -- pure storage migration + check) ---
      writeFileSync(absSmall, "export function delta() {\n  return 4;\n}\n");
      const { recordId: deltaRecordId } = documentationService.writeDoc(repoPath, relSmall, 0, "export function delta() {\n  return 4;\n}\n".length, "Documents delta.");
      const relSmallRenamed = "vscode-extension/src/__syncservice_test_small_renamed__.ts";
      const renameMessages = syncService.handleRenameEvent(repoPath, relSmall, relSmallRenamed);
      const renamedStorage = documentationService.loadStorage(repoPath, relSmallRenamed);
      lines.push(
        `handleRenameEvent: ${renameMessages.length} message(s), record survived migration=${!!renamedStorage.records[deltaRecordId]}`
      );

      // --- checkFileOnDemand: NOT skippable (small, already documented) -> null ---
      const onDemandSmall = syncService.checkFileOnDemand(repoPath, relSmallRenamed);
      lines.push(`checkFileOnDemand (small, documented): ${onDemandSmall === null ? "null (correct, no-op)" : `${onDemandSmall.length} messages (WRONG)`}`);

      // --- checkFileOnDemand: genuinely skippable (>100KB, undocumented) -> real messages ---
      const padding = "// padding\n".repeat(10_000); // well over LARGE_FILE_THRESHOLD_BYTES (100_000)
      writeFileSync(absLarge, `${padding}export function epsilon() {\n  return 5;\n}\n`);
      const onDemandLarge = syncService.checkFileOnDemand(repoPath, relLarge);
      lines.push(
        `checkFileOnDemand (>100KB, undocumented): ${onDemandLarge === null ? "null (WRONG, expected real messages)" : `${onDemandLarge.length} real message(s) (correct)`}`
      );

      // --- Resilience: a fullScan continues past one unparseable file and
      // still checks the rest of the repo; handleFileEvent doesn't crash
      // on a live edit that makes a file unparseable. Neither had been
      // exercised before -- every prior test used only valid source.
      // Also confirms fullScan's OWN skip-large-undocumented path (a
      // third, separate caller of the shared skip logic, alongside the
      // diff loop above and checkFileOnDemand). Uses a dedicated second
      // scratch repo so this cleanly hits the first-ever-sync fullScan
      // branch, isolated from scratchDir's already-established history. ---
      const scratchDir2 = mkdtempSync(join(tmpdir(), "rapid-docs-syncservice-resilience-scratch-"));
      try {
        execFileSync("git", ["init"], { cwd: scratchDir2 });
        execFileSync("git", ["config", "user.email", "test@rapid-docs.local"], { cwd: scratchDir2 });
        execFileSync("git", ["config", "user.name", "rapid-docs test"], { cwd: scratchDir2 });
        writeFileSync(join(scratchDir2, "good.ts"), "export function goodFunc() {\n  return 1;\n}\n");
        writeFileSync(join(scratchDir2, "broken.ts"), "function broken( {{{ not valid syntax at all");
        const largePaddingScan = "// padding\n".repeat(10_000);
        writeFileSync(join(scratchDir2, "large-undocumented.ts"), `${largePaddingScan}export function largeFunc() {\n  return 1;\n}\n`);
        execFileSync("git", ["add", "."], { cwd: scratchDir2 });
        execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir2 });

        const resilienceReport = syncService.sync(scratchDir2); // first-ever sync -> fullScan
        const goodFlagged = resilienceReport.messages.some((m: { relativePath: string }) => m.relativePath === "good.ts");
        const largeFlaggedInFullScan = resilienceReport.messages.some((m: { relativePath: string }) => m.relativePath === "large-undocumented.ts");
        lines.push(
          `fullScan resilience + skip: good.ts still flagged despite broken.ts present=${goodFlagged} (expected true, fullScan must not abort on the first parse failure), large-undocumented.ts skipped in the bulk pass=${!largeFlaggedInFullScan} (expected true, i.e. NOT flagged)`
        );

        let liveEditThrew = false;
        let liveEditMessages: unknown[] = [];
        try {
          liveEditMessages = syncService.handleFileEvent(scratchDir2, "broken.ts");
        } catch {
          liveEditThrew = true;
        }
        lines.push(`handleFileEvent on an unparseable live file: threw=${liveEditThrew} (expected false), returned ${liveEditMessages.length} message(s) without crashing`);
      } finally {
        try {
          rmSync(scratchDir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch {
          /* non-fatal, matches the earlier Windows-EPERM lesson */
        }
      }

      vscode.window.showInformationMessage("rapid-docs: SyncService section test finished, see proof file for full results.");
    } catch (err) {
      lines.push(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      vscode.window.showErrorMessage("rapid-docs: SyncService test failed partway, see proof file for what succeeded before that.");
    } finally {
      for (const abs of [absSmall, absLarge]) {
        try {
          if (existsSync(abs)) unlinkSync(abs);
        } catch {
          /* non-fatal */
        }
      }
      try {
        rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        /* non-fatal, matches the earlier GitService/Windows-EPERM lesson */
      }
      writeFileSync(join(tmpdir(), "rapid-docs-syncservice-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
    }
  });
  context.subscriptions.push(testSyncServiceDisposable);

  // Section 6 (LiveWatchService): start()/one event/stop() were already
  // proven in Section 1. What's left is the rename-correlation window
  // (add+unlink paired within it = a rename, not two separate events),
  // genuine rapid-succession changes to different files staying separate,
  // an unlink with no matching add correctly falling through as a real
  // delete once the window elapses, and the "someone else's documentation
  // arrived via git pull" storage-only-change path. Real async timing is
  // involved here (chokidar's own event delivery, the correlation window's
  // setTimeout), unlike every synchronous method tested in Sections 2-5.
  const testLiveWatchSectionDisposable = vscode.commands.registerCommand("rapidDocs.testLiveWatchSection", async () => {
    const lines: string[] = [];
    const scratchDir = mkdtempSync(join(tmpdir(), "rapid-docs-livewatch-section-scratch-"));
    // 500ms matches the REAL production default (DEFAULT_CORRELATION_WINDOW_MS
    // in live-watch.service.ts) rather than an artificially tight value --
    // found for real that 150ms left too little headroom against genuine
    // Windows unlink-detection latency (measured ~109ms on this machine),
    // producing a false failure that wasn't a real bug, just an unrealistic
    // test window undershooting what the actual, shipped default already covers.
    const correlationWindowMs = 500;

    type Collected = { relativePaths: string[]; messageCount: number; at: number };
    const collected: Collected[] = [];
    const listener = (relativePaths: string[], messages: unknown[]) => {
      collected.push({ relativePaths, messageCount: messages.length, at: Date.now() });
    };

    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    try {
      // Reset to a clean slate -- liveWatchService is the SAME shared
      // instance testLiveWatch (Section 1) may already have started once
      // this session, on a different repo entirely.
      await liveWatchService.stop();

      execFileSync("git", ["init"], { cwd: scratchDir });
      execFileSync("git", ["config", "user.email", "test@rapid-docs.local"], { cwd: scratchDir });
      execFileSync("git", ["config", "user.name", "rapid-docs test"], { cwd: scratchDir });
      const contentX = "export function xFunc() {\n  return \"x\";\n}\n";
      const contentY = "export function yFunc() {\n  return \"y\";\n}\n";
      const contentW = "export function wFunc() {\n  return \"w\";\n}\n";
      const contentP1 = "export function p1Func() {\n  return \"p1\";\n}\n";
      const contentP2 = "export function p2Func() {\n  return \"p2\";\n}\n";
      writeFileSync(join(scratchDir, "x.ts"), contentX);
      writeFileSync(join(scratchDir, "y.ts"), contentY);
      writeFileSync(join(scratchDir, "w.ts"), contentW);
      // p1/p2 exist BEFORE start() specifically so their content is cache-primed --
      // required for the unlink side of each rename pair below to have real
      // cached content to correlate against (handleUnlink bails out immediately,
      // uncorrelated, if contentCache has nothing for that exact path).
      writeFileSync(join(scratchDir, "p1.ts"), contentP1);
      writeFileSync(join(scratchDir, "p2.ts"), contentP2);
      // .gitignore must exist and be committed BEFORE start() -- the watch
      // set itself is built once at startup from the real ignored-paths
      // list, so this has to be real, known-ignored state going in, not
      // something added after the watcher is already running.
      mkdirSync(join(scratchDir, "ignored-dir"), { recursive: true });
      writeFileSync(join(scratchDir, ".gitignore"), "ignored-dir/\n");
      execFileSync("git", ["add", "."], { cwd: scratchDir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: scratchDir });

      liveWatchService.on("messages", listener);
      await liveWatchService.start(scratchDir, correlationWindowMs);
      lines.push(`start() with a ${correlationWindowMs}ms correlation window: ok`);

      // --- Test E: a gitignored directory's contents are never watched at
      // all, not just filtered after the fact -- confirmed by writing a
      // brand-new file inside it AFTER start() and getting zero events,
      // even once the full correlation window has elapsed. Never exercised
      // before now; this is real, previously-fixed-bug territory (the
      // whole gitignore-watching performance investigation earlier in the
      // project), completely unverified in the extension until now. ---
      writeFileSync(join(scratchDir, "ignored-dir", "secret.ts"), "export function secretFunc() {\n  return \"secret\";\n}\n");
      await wait(correlationWindowMs * 4);
      const ignoredDirEvent = collected.find((e) => e.relativePaths.some((p) => p.includes("ignored-dir")));
      lines.push(`Gitignored directory contents never watched: wrote a new file inside ignored-dir/ after start(), event fired=${!!ignoredDirEvent} (expected false -- must be excluded from the watch set itself, not filtered after the fact)`);
      collected.length = 0;

      // --- Test A1: rename correlation, UNLINK arrives first -- exercises
      // handleAdd's own pendingUnlinks-matching loop specifically. A single
      // real OS renameSync only ever exercises whichever order chokidar/the
      // OS happens to report, so the two directions are triggered explicitly
      // and separately here instead, via a deliberate small gap between the
      // two raw fs operations to bias which one chokidar sees first. ---
      unlinkSync(join(scratchDir, "p1.ts"));
      await wait(60); // comfortably inside the 150ms correlation window
      writeFileSync(join(scratchDir, "p1-renamed.ts"), contentP1);
      await wait(correlationWindowMs * 4);
      const p1Events = collected.filter((e) => e.relativePaths.includes("p1.ts") || e.relativePaths.includes("p1-renamed.ts"));
      const p1Correlated = p1Events.some((e) => e.relativePaths.length === 2 && e.relativePaths.includes("p1.ts") && e.relativePaths.includes("p1-renamed.ts"));
      lines.push(`Rename correlation, unlink-arrives-first (p1.ts -> p1-renamed.ts, exercises handleAdd's matching loop): ${p1Events.length} relevant event(s), correlated=${p1Correlated}`);
      collected.length = 0;

      // --- Test A2: rename correlation, ADD arrives first -- exercises
      // handleUnlink's own pendingAdds-matching loop specifically. ---
      const p2StartTime = Date.now();
      writeFileSync(join(scratchDir, "p2-renamed.ts"), contentP2);
      await wait(60);
      unlinkSync(join(scratchDir, "p2.ts"));
      await wait(correlationWindowMs * 4);
      const p2Events = collected.filter((e) => e.relativePaths.includes("p2.ts") || e.relativePaths.includes("p2-renamed.ts"));
      const p2Correlated = p2Events.some((e) => e.relativePaths.length === 2 && e.relativePaths.includes("p2.ts") && e.relativePaths.includes("p2-renamed.ts"));
      lines.push(`Rename correlation, add-arrives-first (p2.ts -> p2-renamed.ts, exercises handleUnlink's matching loop): ${p2Events.length} relevant event(s), correlated=${p2Correlated}`);
      if (!p2Correlated) {
        lines.push(
          `  DIAGNOSTIC: ${p2Events.map((e) => `[+${e.at - p2StartTime}ms] paths=${JSON.stringify(e.relativePaths)}`).join(" | ")}`
        );
      }
      collected.length = 0;

      // --- Also confirm a real OS rename (whichever order the OS actually
      // uses) still correlates end to end, as a real-world sanity check on
      // top of the two controlled directions above. ---
      renameSync(join(scratchDir, "x.ts"), join(scratchDir, "x-renamed.ts"));
      await wait(correlationWindowMs * 4);
      const renameEvents = collected.filter((e) => e.relativePaths.includes("x.ts") || e.relativePaths.includes("x-renamed.ts"));
      const correlated = renameEvents.some((e) => e.relativePaths.length === 2 && e.relativePaths.includes("x.ts") && e.relativePaths.includes("x-renamed.ts"));
      lines.push(`Real OS rename, whichever order actually fires (x.ts -> x-renamed.ts): ${renameEvents.length} relevant event(s), correlated=${correlated}`);
      collected.length = 0;

      // --- Test B: unlink-only, no matching add -> falls through as a real delete once the window elapses ---
      unlinkSync(join(scratchDir, "y.ts"));
      await wait(correlationWindowMs * 4);
      const unlinkEvents = collected.filter((e) => e.relativePaths.includes("y.ts"));
      const singlePathUnlink = unlinkEvents.length === 1 && unlinkEvents[0].relativePaths.length === 1;
      lines.push(`Unlink-only (y.ts deleted, no pairing add): ${unlinkEvents.length} event(s), correctly a single, un-paired path=${singlePathUnlink}`);
      collected.length = 0;

      // --- Test C: rapid, near-simultaneous changes to two DIFFERENT files stay separate ---
      writeFileSync(join(scratchDir, "x-renamed.ts"), contentX + "// touched\n");
      writeFileSync(join(scratchDir, "w.ts"), contentW + "// touched\n");
      await wait(correlationWindowMs * 4);
      const xEvent = collected.find((e) => e.relativePaths.length === 1 && e.relativePaths[0] === "x-renamed.ts");
      const wEvent = collected.find((e) => e.relativePaths.length === 1 && e.relativePaths[0] === "w.ts");
      lines.push(`Rapid changes to 2 different files: x-renamed.ts got its own event=${!!xEvent}, w.ts got its own event=${!!wEvent}, no cross-contamination=${collected.length === 2}`);
      collected.length = 0;

      // --- Test D1: a .rapid-docs storage file APPEARING (add) -> rechecks the SOURCE file, not the storage path ---
      const storageDir = join(scratchDir, ".rapid-docs");
      mkdirSync(storageDir, { recursive: true });
      const storageFile = join(storageDir, "w.ts.json");
      writeFileSync(storageFile, JSON.stringify({ fileId: "w.ts", records: {} }, null, 2));
      await wait(correlationWindowMs * 4);
      const derivedAddEvent = collected.find((e) => e.relativePaths.includes("w.ts"));
      lines.push(`Storage-only ADD (.rapid-docs/w.ts.json created): rechecked the real source file w.ts, not the storage path=${!!derivedAddEvent}`);
      collected.length = 0;

      // --- Test D2: that SAME storage file being MODIFIED (change), the derive-check inside handleChange specifically ---
      writeFileSync(storageFile, JSON.stringify({ fileId: "w.ts", records: { dummy: true } }, null, 2));
      await wait(correlationWindowMs * 4);
      const derivedChangeEvent = collected.find((e) => e.relativePaths.includes("w.ts"));
      lines.push(`Storage-only CHANGE (.rapid-docs/w.ts.json modified): rechecked the real source file w.ts=${!!derivedChangeEvent}`);
      collected.length = 0;

      // --- Test D3: that SAME storage file being DELETED (unlink), the derive-check inside handleUnlink specifically ---
      unlinkSync(storageFile);
      await wait(correlationWindowMs * 4);
      const derivedUnlinkEvent = collected.find((e) => e.relativePaths.includes("w.ts"));
      lines.push(`Storage-only UNLINK (.rapid-docs/w.ts.json deleted): rechecked the real source file w.ts=${!!derivedUnlinkEvent}`);

      vscode.window.showInformationMessage("rapid-docs: LiveWatchService section test finished, see proof file for full results.");
    } catch (err) {
      lines.push(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      vscode.window.showErrorMessage("rapid-docs: LiveWatchService test failed partway, see proof file for what succeeded before that.");
    } finally {
      liveWatchService.off("messages", listener);
      try {
        await liveWatchService.stop();
      } catch {
        /* non-fatal */
      }
      try {
        rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        /* non-fatal, matches the earlier Windows-EPERM lesson */
      }
      writeFileSync(join(tmpdir(), "rapid-docs-livewatch-section-proof.txt"), `${new Date().toISOString()}\n${lines.join("\n")}\n`);
    }
  });
  context.subscriptions.push(testLiveWatchSectionDisposable);
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
