import * as vscode from "vscode";
import { join } from "path";
import type { RapidDocsMessage } from "../types";

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
