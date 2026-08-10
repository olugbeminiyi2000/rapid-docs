import * as vscode from "vscode";
import { join } from "path";
import type { RapidDocsMessage, SyncService, LiveWatchService } from "../types";

const SEVERITY_MAP: Record<RapidDocsMessage["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

// The one real conversion this layer has to do: a byte offset only means
// something once translated against the ACTUAL current text of the file,
// via a real TextDocument's own positionAt() -- there's no way to compute a
// correct line/column from an offset without the real content in hand.
export async function messagesToDiagnosticsByFile(
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

export function createDiagnosticsController(context: vscode.ExtensionContext): vscode.DiagnosticCollection {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection("rapid-docs");
  context.subscriptions.push(diagnosticCollection);
  return diagnosticCollection;
}

// Matches electron/main.ts's own dedupeMessages (main.ts:443) exactly: two
// different messages about two different files that happen to read
// identically ("A ImportDeclaration near line 1 has no documentation yet.")
// must NOT collapse into one -- relativePath is part of the key specifically
// so that never happens.
function dedupeMessages(messages: RapidDocsMessage[]): RapidDocsMessage[] {
  const seen = new Set<string>();
  const result: RapidDocsMessage[] = [];
  for (const message of messages) {
    const key = `${message.severity}::${message.relativePath}::${message.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(message);
    }
  }
  return result;
}

// relativePaths names every file this batch represents the CURRENT, complete
// state for (see live-watch.service.ts:256's own doc comment) -- including a
// file that just became fully clean, which `messages` alone can't convey (an
// empty array carries no indication of which file it's empty for). Setting
// diagnostics for every path in relativePaths, even with zero entries, is
// what correctly clears a fixed file's diagnostics rather than leaving them
// to linger.
async function applyMessagesToDiagnostics(
  diagnosticCollection: vscode.DiagnosticCollection,
  repoPath: string,
  relativePaths: string[],
  messages: RapidDocsMessage[]
): Promise<void> {
  const byFile = await messagesToDiagnosticsByFile(messages, repoPath);
  for (const relativePath of relativePaths) {
    diagnosticCollection.set(vscode.Uri.file(join(repoPath, relativePath)), byFile.get(relativePath) ?? []);
  }
}

// Matches electron/main.ts's activateRepo() exactly (main.ts:491-517): run
// sync() (catches up committed history since the last sync pointer) THEN
// reconcile() (catches up uncommitted drift), dedupe the combined result,
// populate Diagnostics fully, then (re)start LiveWatchService so it stays
// live-updated from here on. Previously this entire sequence only ever ran
// via manual test commands (rapidDocs.testReconcile/testDiagnostics/
// testLiveWatch) -- a real user opening the extension got neither an
// initial Problems-panel populate nor any live updates at all until they
// happened to run one of those test commands themselves.
export async function activateDiagnosticsLiveWiring(
  context: vscode.ExtensionContext,
  diagnosticCollection: vscode.DiagnosticCollection,
  syncService: SyncService,
  liveWatchService: LiveWatchService
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const repoPath = folder.uri.fsPath;

  const syncReport = syncService.sync(repoPath);
  const reconcileReport = syncService.reconcile(repoPath);
  const catchUpMessages = dedupeMessages([...syncReport.messages, ...reconcileReport.messages]);

  diagnosticCollection.clear();
  const byFile = await messagesToDiagnosticsByFile(catchUpMessages, repoPath);
  for (const [relativePath, diagnostics] of byFile) {
    diagnosticCollection.set(vscode.Uri.file(join(repoPath, relativePath)), diagnostics);
  }

  // start() doesn't guard against an already-running watcher itself (see
  // live-watch.service.ts's own start() comment: calling it twice silently
  // overwrites the internal handle, leaking the old one) -- stop() first is
  // what electron/main.ts's activateRepo() does too, and is safe even on a
  // genuinely first activation where nothing is running yet.
  await liveWatchService.stop();
  await liveWatchService.start(repoPath);

  const listener = (relativePaths: string[], messages: RapidDocsMessage[]) => {
    void applyMessagesToDiagnostics(diagnosticCollection, repoPath, relativePaths, messages);
  };
  liveWatchService.on("messages", listener);
  context.subscriptions.push({ dispose: () => liveWatchService.off("messages", listener) });
}
