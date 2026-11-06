// zod/v3, not the top-level "zod" export -- see index.ts's own header for
// why: zod-to-json-schema's own types are anchored to "zod/v3" specifically
// (zod 3.25+'s dual v3/v4-compatible structure), and a shape built from the
// plain "zod" export is a structurally similar but not identical type to
// what it expects, which is what caused a second TS2589 blowup.
import { z, type ZodRawShape } from "zod/v3";
import { isAbsolute, relative, resolve } from "path";
import type { DocumentationService } from "./types.js";

// Forces Claude Code to ALWAYS prompt for human confirmation on a tool call
// carrying this flag, regardless of permission mode (even bypassPermissions)
// and regardless of any "always allow" the user has set for this server's
// other tools -- a server-side guarantee this process controls directly,
// not dependent on the connecting client's own settings. Applied only to
// the four tools below that can overwrite or permanently remove existing
// documentation; every read tool and document_selection/
// attach_archived_record (which can only ever CREATE -- writeDoc itself
// throws on an exact-duplicate highlight, so there's no overwrite risk to
// guard here) are left to execute freely.
//
// CAVEAT, not yet verified against a live Claude Code session: this is the
// documented mechanism as of Claude Code v2.1.214+ (a server-side
// `_meta["anthropic/requiresUserInteraction"]` flag on a tool's own
// `tools/list` entry). Confirm this still matches the installed Claude Code
// version with a real end-to-end test before relying on it.
export const REQUIRES_CONFIRMATION_META = { "anthropic/requiresUserInteraction": true };

// index.ts dispatches tool calls through this plain registry, built with
// the raw Server class (ListToolsRequestSchema/CallToolRequestSchema)
// rather than McpServer's own registerTool()/tool() convenience methods --
// real finding, 2026-10-11: registerTool()'s own generic inference (which
// has to infer a callback's argument type FROM a caller-supplied ZodRawShape
// generic, while also disambiguating it from a structurally-similar
// ToolAnnotations overload) hits TS2589 ("Type instantiation is excessively
// deep") even on ONE trivial tool with ONE field -- confirmed via an
// isolated, minimal repro, not assumed, and confirmed NOT a zod-duplication
// or old-TypeScript problem either. Separately, confirmed via reading
// McpServer's own runtime source: registerTool()'s config object is
// destructured to exactly {title, description, inputSchema, outputSchema,
// annotations} -- any _meta field passed in it is silently dropped before
// it ever reaches the tools/list response, so even avoiding the TS2589
// crash some other way still wouldn't have made the confirmation gate work.
// The raw Server class's ListToolsRequestSchema handler has no such
// limitation (confirmed via the same isolation-test method) and a Tool
// object's wire schema genuinely does carry an optional, arbitrary `_meta`
// passthrough field -- this is the one path that actually delivers it.
//
// Deliberately typed loosely (args as Record<string, unknown>, validated at
// call time via zod's own .parse()) rather than threading a generic Shape
// through a shared helper -- the whole point of moving off registerTool()
// was to get away from generic inference over a caller-supplied ZodRawShape
// in the first place; reinventing a similar helper here would risk the
// exact same class of problem for no real benefit, since each handler below
// already destructures its own named, individually-typed arguments.
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  shape: ZodRawShape;
  requiresConfirmation?: boolean;
  handler: (args: Record<string, unknown>, documentationService: DocumentationService) => Promise<{
    content: { type: "text"; text: string }[];
  }>;
}

const repoPath = z.string().describe("Absolute path to the repository root (the folder containing .rapid-docs/).");
const relativePath = z.string().describe("Path to the file, relative to repoPath, forward-slash separated.");
const start = z.number().int().describe("Start byte offset of the code selection within the file's current text.");
const end = z.number().int().describe("End byte offset of the code selection within the file's current text.");
const recordId = z.string().describe("A documentation record's id, as returned by document_selection, check_file, or find_record_for_selection.");
const archiveId = z.string().describe("An archived record's id, as returned by search_archive.");
const docText = z.string().describe("The documentation text to store, written in Markdown.");

function textResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

// Real security finding, 2026-10-11: DocumentationService itself (src/ast/
// documentation.service.ts) does no path-traversal validation anywhere --
// writeDoc/checkFile/etc. all just join(repoPath, relativePath) and
// read/write directly. That was tolerable while the only caller was a human
// through the VSCode UI, where relativePath always came from
// vscode.workspace.asRelativePath() against a real, already-open editor
// document VSCode itself had already resolved inside the workspace folder.
// An AI agent calling this server supplies relativePath directly, and can
// be influenced by content it reads (prompt injection) or by its own
// mistakes -- a crafted "../../../../Users/victim/.ssh/id_rsa" would
// otherwise read or write files anywhere the server process can reach,
// entirely outside the intended repo. DocumentationService lives in src/
// (shared with vscode-extension and the deprecated electron app, off
// limits to edit here), so the fix lives at this boundary instead -- the
// exact same descendant-of-repoPath check already proven in
// resolveDocTextMedia.ts and composePanel.ts's insertMediaReference,
// applied to every tool that accepts a relativePath, before
// DocumentationService ever sees it.
function assertRelativePathIsContained(repoPath: string, relativePath: string): void {
  if (isAbsolute(relativePath)) {
    throw new Error(`relativePath must be a relative path, not absolute: "${relativePath}"`);
  }
  const resolved = resolve(repoPath, relativePath);
  const rel = relative(repoPath, resolved);
  const isDescendant = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!isDescendant) {
    throw new Error(`relativePath must stay within repoPath, but "${relativePath}" escapes it.`);
  }
}

// Wraps every tool definition's handler with the check above whenever its
// shape declares a relativePath field -- one place that guarantees the
// check is never forgotten on a tool that needs it, rather than repeating
// (and risking missing it on) a manual call inside each of the eight
// handlers that take one.
function withPathSafety(tool: ToolDefinition): ToolDefinition {
  if (!("relativePath" in tool.shape)) return tool;
  const innerHandler = tool.handler;
  return {
    ...tool,
    handler: async (args, documentationService) => {
      const { repoPath, relativePath } = args as { repoPath: string; relativePath: string };
      assertRelativePathIsContained(repoPath, relativePath);
      return innerHandler(args, documentationService);
    },
  };
}

export function buildToolDefinitions(): ToolDefinition[] {
  return rawToolDefinitions().map(withPathSafety);
}

function rawToolDefinitions(): ToolDefinition[] {
  return [
    // ---- Read-only ----
    {
      name: "check_file",
      title: "Check a file's documentation status",
      description:
        "Reports which parts of a file are undocumented or have drifted out of sync with their documentation. " +
        "Call this before documenting new code, to see what's already covered and what isn't.",
      shape: { repoPath, relativePath },
      handler: async (args, documentationService) => {
        const { repoPath, relativePath } = args as { repoPath: string; relativePath: string };
        const report = documentationService.checkFile(repoPath, relativePath);
        return textResult(documentationService.generateMessages(repoPath, relativePath, report));
      },
    },
    {
      name: "find_record_for_selection",
      title: "Find the documentation record for an exact code selection",
      description:
        "Returns the existing documentation record that exactly matches the given selection, or null if that " +
        "exact selection isn't documented yet. Use this before document_selection to check whether something is " +
        "already covered, since writing a duplicate record is rejected.",
      shape: { repoPath, relativePath, start, end },
      handler: async (args, documentationService) => {
        const { repoPath, relativePath, start, end } = args as { repoPath: string; relativePath: string; start: number; end: number };
        return textResult(documentationService.findRecordForSelection(repoPath, relativePath, start, end));
      },
    },
    {
      name: "find_stale_record_for_selection",
      title: "Find a drifted documentation record overlapping a code selection",
      description:
        "Returns the stale (partially drifted) documentation record whose surviving anchors overlap the given " +
        "selection, or null if none does. Use this to find what update_drifted_doc should replace.",
      shape: { repoPath, relativePath, start, end },
      handler: async (args, documentationService) => {
        const { repoPath, relativePath, start, end } = args as { repoPath: string; relativePath: string; start: number; end: number };
        return textResult(documentationService.findStaleRecordForSelection(repoPath, relativePath, start, end));
      },
    },
    {
      name: "search_archive",
      title: "List archived documentation records",
      description:
        "Returns every archived record for a repository -- documentation whose original code was deleted, kept " +
        "instead of lost. Use this to find prior writing that could be reused via attach_archived_record.",
      shape: { repoPath },
      handler: async (args, documentationService) => {
        const { repoPath } = args as { repoPath: string };
        return textResult(documentationService.loadArchive(repoPath));
      },
    },

    // ---- Create-only (writeDoc/attachArchivedRecord structurally can't
    // overwrite an existing record -- both throw on an exact-duplicate
    // highlight -- so neither needs requiresConfirmation). ----
    {
      name: "document_selection",
      title: "Document a code selection",
      description:
        "Writes new documentation for an exact code selection. Fails if that exact selection is already " +
        "documented (use find_record_for_selection first to check, or edit_doc_text to change existing text).",
      shape: { repoPath, relativePath, start, end, docText },
      handler: async (args, documentationService) => {
        const { repoPath, relativePath, start, end, docText } = args as {
          repoPath: string;
          relativePath: string;
          start: number;
          end: number;
          docText: string;
        };
        return textResult(documentationService.writeDoc(repoPath, relativePath, start, end, docText));
      },
    },
    {
      name: "attach_archived_record",
      title: "Attach an archived record to a new code selection",
      description:
        "Reuses a previously archived documentation record by attaching it to a new, currently-undocumented code " +
        "selection, removing it from the archive in the same step.",
      shape: { repoPath, archiveId, relativePath, start, end },
      handler: async (args, documentationService) => {
        const { repoPath, archiveId, relativePath, start, end } = args as {
          repoPath: string;
          archiveId: string;
          relativePath: string;
          start: number;
          end: number;
        };
        return textResult(documentationService.attachArchivedRecord(repoPath, archiveId, relativePath, start, end));
      },
    },

    // ---- Requires confirmation: update ----
    {
      name: "update_drifted_doc",
      title: "Update a drifted documentation record",
      description:
        "Replaces a stale documentation record with a fresh one for the code's current form. Permanently " +
        "discards the old record's text unless you pass the same text back.",
      shape: { repoPath, relativePath, oldRecordId: recordId, start, end, docText },
      requiresConfirmation: true,
      handler: async (args, documentationService) => {
        const { repoPath, relativePath, oldRecordId, start, end, docText } = args as {
          repoPath: string;
          relativePath: string;
          oldRecordId: string;
          start: number;
          end: number;
          docText: string;
        };
        return textResult(documentationService.updateDriftedDoc(repoPath, relativePath, oldRecordId, start, end, docText));
      },
    },
    {
      name: "edit_doc_text",
      title: "Edit an existing documentation record's text",
      description: "Overwrites an existing record's documentation text in place, without touching what code it's attached to.",
      shape: { repoPath, relativePath, recordId, newText: docText },
      requiresConfirmation: true,
      handler: async (args, documentationService) => {
        const { repoPath, relativePath, recordId, newText } = args as {
          repoPath: string;
          relativePath: string;
          recordId: string;
          newText: string;
        };
        documentationService.editDocText(repoPath, relativePath, recordId, newText);
        return textResult("ok");
      },
    },

    // ---- Requires confirmation: delete ----
    {
      name: "delete_record",
      title: "Permanently delete a documentation record",
      description: "Permanently deletes a documentation record. This cannot be undone and does not archive the text.",
      shape: { repoPath, relativePath, recordId },
      requiresConfirmation: true,
      handler: async (args, documentationService) => {
        const { repoPath, relativePath, recordId } = args as { repoPath: string; relativePath: string; recordId: string };
        documentationService.deleteRecord(repoPath, relativePath, recordId);
        return textResult("ok");
      },
    },
    {
      name: "discard_archived_record",
      title: "Permanently discard an archived record",
      description: "Permanently removes a record from the archive. This cannot be undone.",
      shape: { repoPath, archiveId },
      requiresConfirmation: true,
      handler: async (args, documentationService) => {
        const { repoPath, archiveId } = args as { repoPath: string; archiveId: string };
        documentationService.discardArchivedRecord(repoPath, archiveId);
        return textResult("ok");
      },
    },
  ];
}
