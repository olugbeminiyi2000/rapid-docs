import * as vscode from "vscode";
import { join } from "path";
import type { DocumentationService, DocumentedSectionItem } from "../types";

// Replicates electron/main.ts's "docs:findDocumentedNodes" handler exactly
// (lines 200-222), not just DocumentationService.findDocumentedNodes() alone
// -- that method returns one entry PER MATCHED AST NODE (a single writeDoc
// call typically matches many nested nodes sharing one recordId), and has no
// docText at all. The real IPC handler collapses to one row per recordId and
// separately attaches docText from loadStorage; that glue logic lives in
// electron/main.ts, not in src/, so it has to be reimplemented here rather
// than assumed covered by the backend reuse.
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

export class DocumentedSectionsProvider implements vscode.TreeDataProvider<DocumentedSectionItem> {
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

export interface DocumentedSectionsController {
  provider: DocumentedSectionsProvider;
  refresh: () => Promise<void>;
}

// Documented Sections: file-scoped, same as the Electron panel was
// (findDocumentedNodes takes one relativePath, not the whole repo), so it
// refreshes whenever the active file changes, not just on demand.
export function registerDocumentedSections(
  context: vscode.ExtensionContext,
  documentationService: DocumentationService,
  documentedDecorationType: vscode.TextEditorDecorationType
): DocumentedSectionsController {
  const provider = new DocumentedSectionsProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("rapidDocsDocumentedSections", provider));

  async function refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !folder) {
      provider.setItems([]);
      return;
    }
    const repoPath = folder.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    try {
      const items = await collectDocumentedSections(documentationService, repoPath, relativePath);
      provider.setItems(items);
    } catch {
      provider.setItems([]); // file doesn't parse right now, same as the Electron panel going quiet on a broken file
    }
  }

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => void refresh()));

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
      await refresh();
    })
  );

  return { provider, refresh };
}
