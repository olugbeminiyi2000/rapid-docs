// Confirmation dialogs (delete/discard) exist so someone can recognize real
// content before it's gone for good, not to render the whole thing -- that's
// what the eye-icon preview (docTextPreview.ts) is for. Real bug found via
// manual testing (2026-09-09): a long, multi-line Markdown docText (exactly
// the kind of content these dialogs are supposed to protect) pushed
// VSCode's own confirm/cancel buttons out of the visible modal area
// entirely, since `detail` has no built-in cap and the dialog just grows to
// fit it. Truncating specifically for the CONFIRMATION prompt, never for
// the real preview, keeps the dialog's own actionable buttons in view
// regardless of how long the actual documentation is.
const CONFIRM_DIALOG_MAX_LINES = 8;
const CONFIRM_DIALOG_MAX_CHARS = 400;

export function truncateForConfirmDialog(docText: string): string {
  const lines = docText.split("\n");
  const truncatedByLines = lines.length > CONFIRM_DIALOG_MAX_LINES;
  const limitedByLines = lines.slice(0, CONFIRM_DIALOG_MAX_LINES).join("\n");

  const truncatedByChars = limitedByLines.length > CONFIRM_DIALOG_MAX_CHARS;
  const limited = truncatedByChars ? limitedByLines.slice(0, CONFIRM_DIALOG_MAX_CHARS) : limitedByLines;

  return truncatedByLines || truncatedByChars ? `${limited.trimEnd()}\n…` : limited;
}
