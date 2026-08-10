import * as vscode from "vscode";
import { writeFileSync } from "fs";
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
