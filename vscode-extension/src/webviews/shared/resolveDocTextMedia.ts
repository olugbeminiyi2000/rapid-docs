import { existsSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";

// Real bug found via live use (2026-09-22): a docText copied in from a
// standalone Markdown file, with real, working relative image references
// (`![diagram](./diagram.png)`), showed no image at all once previewed
// through rapid-docs. Root cause: docTextPreview.ts renders against a
// virtual document with no real location on disk at all (see its own
// header), so ANY relative reference in the text resolves to a fake path
// nothing can serve -- this was never specific to one video's file, it
// would happen for any relative image/link in any docText, hand-typed or
// pasted in.
//
// Fix: rewrite relative markdown references to real, absolute file:// URIs,
// but ONLY at preview-render time, never in storage -- the stored docText
// stays exactly as portable, relative markdown, which is what makes it
// keep working for every collaborator who clones the repo. Only the moment
// someone actually previews it do we resolve it against a real directory
// on THEIR machine.
//
// Anchored at repoPath (the workspace root), not the documented source
// file's own directory: docText isn't tied to a real, permanent file
// location the way an ordinary .md file is (its source code can be
// renamed, moved, or -- for an archived record -- deleted entirely), but
// repoPath is always real and always available, and it's the exact same
// root ".rapid-docs/" itself lives at, matching the user's own framing of
// "must be a descendant of where .rapid-docs is."
//
// The security boundary this exists for, not just a formatting nicety:
// .rapid-docs/*.json gets committed to git, so a docText's image reference
// can arrive on YOUR machine having been written by SOMEONE ELSE's commit.
// Resolving a reference naively would let a crafted path (an absolute
// path, or a "../../../../" traversal) turn into a real, loadable
// file:// URI reaching outside the repo entirely, on your machine, with
// your permissions, the moment you preview their documentation. Every
// resolved path is checked here to be a genuine descendant of repoPath,
// and to actually exist, before it's ever turned into a real URI --
// anything that fails either check is left exactly as it was in the raw
// text (rendering as a broken image/dead link, never as a real local
// file reference outside the repo).
// Two alternatives for the destination, matching real CommonMark syntax:
// `<a path (with) spaces or parens.pdf>` (angle-bracket form, the one
// composePanel.ts's own insert-file/insert-image feature always produces,
// specifically because a real filename can and does contain either), or a
// bare `plain/path.png` with neither. A bare destination can't contain a
// space or an unescaped `)` at all -- that ambiguity is the exact reason
// the angle-bracket form exists -- so this only ever needs to try one
// alternative or the other, never both at once.
const MARKDOWN_REFERENCE_PATTERN = /(!?\[[^\]]*\])\((?:<([^>]+)>|([^)\s]+))\)/g;

// Any reference that already carries its own scheme (http:, https:,
// data:, an existing file:, mailto:, etc.) is left completely untouched --
// only a bare relative path is ambiguous enough to need resolving here.
function hasScheme(refPath: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(refPath);
}

function resolveWithinRepo(repoPath: string, refPath: string): string | null {
  if (isAbsolute(refPath)) return null;
  const resolved = resolve(repoPath, refPath);
  const rel = relative(repoPath, resolved);
  const isDescendant = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!isDescendant) return null;
  if (!existsSync(resolved)) return null;
  return resolved;
}

// previewFileDir: the REAL directory the rendered preview file itself will
// live in (see docTextPreview.ts). Real bug found via live use
// (2026-09-22): this used to emit an absolute `file://` URI here instead.
// That's not just a webview/virtual-document problem (already fixed by
// docTextPreview.ts writing a real file) -- markdown-it, which VSCode's
// built-in preview renders through, hardcodes `file:` into the exact same
// "unsafe scheme" bucket as `javascript:`/`vbscript:` in its default link
// validator, and REFUSES TO PARSE the image/link syntax at all when the
// destination starts with it, falling back to showing the raw
// `![alt](<file:///...>)` characters as literal text (confirmed live: the
// image never even attempted to load, or failed as broken -- the raw
// markdown syntax itself was visible on screen). A schemeless path has no
// prefix for that blocklist to match, so it sails through validation, and
// VSCode's own preview machinery resolves it against the preview file's
// real directory into a real local resource -- the exact same, ordinary
// case as previewing any hand-written .md file with relative images.
export function resolveDocTextMediaForPreview(docText: string, repoPath: string, previewFileDir: string): string {
  return docText.replace(
    MARKDOWN_REFERENCE_PATTERN,
    (whole, label: string, angleBracketPath: string | undefined, plainPath: string | undefined) => {
      const refPath = angleBracketPath ?? plainPath ?? "";
      if (hasScheme(refPath)) return whole;
      const resolved = resolveWithinRepo(repoPath, refPath);
      if (!resolved) return whole;
      // Always re-wrapped in <...> for the output too, regardless of which
      // form the input used -- the path relative to previewFileDir is just
      // as capable of containing a space (e.g. "../../Jane Doe/repo/...")
      // as the original one was, so the same escaping is just as
      // necessary here.
      const relativeToPreview = relative(previewFileDir, resolved).split(sep).join("/");
      return `${label}(<${relativeToPreview}>)`;
    }
  );
}
