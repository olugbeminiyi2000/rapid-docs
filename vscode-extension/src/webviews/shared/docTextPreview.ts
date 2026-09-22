import * as vscode from "vscode";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { resolveDocTextMediaForPreview } from "./resolveDocTextMedia";

// Must match DocumentationService's/LiveWatchService's own STORAGE_DIR
// exactly (duplicated the same way live-watch.service.ts already
// duplicates it, rather than importing across the vscode-extension/backend
// boundary for one string).
const STORAGE_DIR = ".rapid-docs";
const PREVIEW_SUBDIR = ".preview-tmp";

// A single, shared way to view a possibly-long, multi-line docText fully
// and well-formatted -- real user feedback: neither a truncated Documented
// Sections row nor a one-line QuickPick label can show that. Uses VSCode's
// own built-in Markdown Preview (markdown.showPreview) so Markdown gets
// genuinely rendered (headings, lists, bold), not just displayed as raw
// text with stray `#`/`*` characters.
//
// A REAL file on disk, not a virtual TextDocumentContentProvider document
// under a custom URI scheme (which is what this used to be) -- VSCode's
// markdown preview webview only grants local-resource access to documents
// it recognizes as belonging to a real folder on disk (confirmed live,
// 2026-09-22: a correctly-resolved, EXISTING file:// URI in a virtual
// document's text still silently failed to load).
//
// Written inside the WORKSPACE itself (.rapid-docs/.preview-tmp/), not the
// OS temp directory -- tried the OS temp directory first and it still
// failed live: VSCode's markdown preview grants a document's own directory
// and the open workspace folders as resource roots, but any relative
// reference that has to `../` its way UP AND OUT of those roots before
// coming back down into one is still blocked, even though the final
// resolved path genuinely is inside the workspace. This is a documented
// VSCode limitation, not something path math can route around:
// https://github.com/microsoft/vscode/issues/82021. Placing the temp file
// itself inside the workspace closes that gap, since every real reference
// it needs is then a plain descendant, no upward escape required.
//
// This does mean a scratch .md file now briefly exists inside
// .rapid-docs/, which is otherwise meant to be committed by the user --
// mitigated by clearing this repo's whole .preview-tmp/ folder at the
// START of every call, before writing the new one (so at most one stray
// file per repo persists between previews), and again at deactivation.
export interface DocTextPreview {
  // repoPath, 2026-09-22: needed both to resolve any relative image/link
  // reference in the docText into a real, loadable path (see
  // resolveDocTextMedia.ts's own header for the real security boundary
  // that resolution has to respect) and to know which workspace folder's
  // .preview-tmp/ this particular preview belongs in.
  show(docText: string, title: string, repoPath: string): Promise<void>;
}

export function registerDocTextPreview(context: vscode.ExtensionContext): DocTextPreview {
  const previewDirsByRepo = new Set<string>();

  // Best-effort cleanup at deactivation -- never mid-session beyond the
  // per-call clear below (an already-open preview tab reading a file that
  // gets deleted out from under it would just go blank/error, not worth
  // the risk for disk space this small). A locked file (still genuinely
  // open in a preview tab at shutdown) isn't worth failing deactivation
  // over either.
  context.subscriptions.push({
    dispose: () => {
      for (const dir of previewDirsByRepo) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort, see above.
        }
      }
    },
  });

  return {
    async show(docText, title, repoPath) {
      const previewDir = join(repoPath, STORAGE_DIR, PREVIEW_SUBDIR);
      previewDirsByRepo.add(previewDir);

      // Cleared before every write, not just at deactivation -- see the
      // header above: this is what keeps stray scratch files from
      // accumulating inside the user's own repo between previews.
      try {
        rmSync(previewDir, { recursive: true, force: true });
      } catch {
        // Best-effort -- a locked file from a still-open preview tab
        // shouldn't block opening a new one.
      }
      mkdirSync(previewDir, { recursive: true });

      // A fresh, unique filename per call, not reused by title alone --
      // two different previews that happen to share a title (e.g. two
      // records both named "documents alpha" from different rounds of
      // testing) must never show one's stale cached content under the
      // other's tab.
      const filePath = join(previewDir, `${encodeURIComponent(title)}-${Date.now()}.md`);
      writeFileSync(filePath, resolveDocTextMediaForPreview(docText, repoPath, previewDir), "utf-8");
      await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(filePath));
    },
  };
}
