import * as vscode from "vscode";

// A single, shared way to view a possibly-long, multi-line docText fully
// and well-formatted -- real user feedback: neither a truncated Documented
// Sections row nor a one-line QuickPick label can show that. Rather than
// build a custom viewer, uses VSCode's own built-in Markdown Preview
// (markdown.showPreview) against a real, read-only virtual document --
// content providers are read-only by construction, no separate flag
// needed, and Markdown gets genuinely rendered (headings, lists, bold),
// not just displayed as raw text with stray `#`/`*` characters.
const SCHEME = "rapid-docs-preview";

export interface DocTextPreview {
  show(docText: string, title: string): Promise<void>;
}

export function registerDocTextPreview(context: vscode.ExtensionContext): DocTextPreview {
  const contentByUri = new Map<string, string>();
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent(uri) {
      return contentByUri.get(uri.toString()) ?? "";
    },
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider));

  return {
    async show(docText, title) {
      // A fresh, unique path per call, not reused by title alone -- two
      // different previews that happen to share a title (e.g. two records
      // both named "documents alpha" from different rounds of testing)
      // must never show one's stale cached content under the other's tab.
      const uri = vscode.Uri.parse(`${SCHEME}:/${encodeURIComponent(title)}-${Date.now()}.md`);
      contentByUri.set(uri.toString(), docText);
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    },
  };
}
