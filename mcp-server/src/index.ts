// zod/v3, not the top-level "zod" export -- real finding, 2026-10-11:
// zod-to-json-schema's own ZodSchema type is imported specifically from
// "zod/v3" (zod 3.25+ ships a dual v3/v4-compatible internal structure).
// Importing z/ZodRawShape from plain "zod" gave a structurally similar but
// NOT identical type tree to what zod-to-json-schema expects, and comparing
// the two was the second, more targeted TS2589 blowup (after fixing the
// first one, the ZodRawShape-widening issue in buildToolSchema below).
// Importing from the exact same subpath zod-to-json-schema itself uses
// makes the two sides reference the identical type, not just a compatible
// one.
import { z, type ZodRawShape } from "zod/v3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { bootstrapBackend } from "./backend.js";
import { buildToolDefinitions, REQUIRES_CONFIRMATION_META } from "./tools.js";
// Read at build time, not hardcoded -- real drift found 2026-10-11: this
// file's own reported serverInfo.version had quietly fallen behind
// package.json's real version (still said "0.1.0" after a 0.1.1 bump).
// esbuild bundles a require() of a JSON file natively, so this stays
// correct through every future version bump with no second place to
// remember to update.
const { version: packageVersion } = require("../package.json") as { version: string };

// The raw Server class, not McpServer -- see tools.ts's own header for why:
// McpServer's registerTool()/tool() convenience methods either crash the
// TypeScript compiler (registerTool's own generic inference, confirmed via
// isolated repro) or silently drop any custom _meta field before it ever
// reaches a tool's wire definition (confirmed via reading McpServer's own
// runtime source). The raw Server class has neither limitation.
//
// stdio, spawned per Claude Code session via a .mcp.json entry -- not a
// long-running background service. Simplest option that matches "start
// with just Claude Code first": no port, no lifecycle to manage separately
// from the agent session that's using it.
async function main(): Promise<void> {
  const backend = await bootstrapBackend();
  const toolDefinitions = buildToolDefinitions();
  const toolsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

  // Computed once at startup, not per tools/list call -- zodToJsonSchema's
  // own output never changes for a given shape, so there's no reason to
  // redo this conversion work on every request.
  //
  // tool.shape as any, not z.object(tool.shape) directly -- real finding,
  // 2026-10-11, confirmed by isolating backend.ts/tools.ts/index.ts one at
  // a time: tools.ts and backend.ts are each fast alone and fast together;
  // the moment index.ts calls z.object() on a value whose STATIC type is
  // the generic ZodRawShape interface (not a concrete literal shape),
  // TypeScript has to compute z.object()'s mapped output/input types over
  // keyof ZodRawShape -- an index-signature type, so effectively `string`,
  // an unbounded key set -- which is exactly the class of input that causes
  // catastrophic TypeScript type-instantiation blowup (confirmed OOM-crash
  // at both 4 and 18 minutes before this fix). zod itself doesn't consult
  // TypeScript types at runtime at all, so short-circuiting the generic
  // here costs nothing real -- buildToolSchema below does this once, in one
  // place, rather than repeating the cast at both call sites.
  // Returns z.ZodTypeAny, not z.ZodObject<ZodRawShape> -- the return type
  // annotation itself has to be cheap too: naming ZodObject<ZodRawShape>
  // explicitly would make TypeScript validate the function body's actual
  // return value against that same expensive mapped-type shape, defeating
  // the point of the cast above. ZodTypeAny is zod's own intentionally
  // wide, cheap base type for exactly this "don't need the precise static
  // shape" case -- both call sites below only ever use the result for
  // .parse() (runtime) or zodToJsonSchema() (also runtime), neither of
  // which needs a precise TS type at all.
  function buildToolSchema(shape: ZodRawShape): z.ZodTypeAny {
    return z.object(shape as any);
  }

  const toolListEntries = toolDefinitions.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: zodToJsonSchema(buildToolSchema(tool.shape), { strictUnions: true }),
    ...(tool.requiresConfirmation ? { _meta: REQUIRES_CONFIRMATION_META } : {}),
  }));

  const server = new Server({ name: "rapid-docs", version: packageVersion }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolListEntries }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    // Real runtime validation, not just a type annotation -- the schema
    // used to build the JSON Schema sent to the client is the SAME one
    // validating what actually comes back, so a malformed call fails with
    // a clear zod error rather than reaching DocumentationService with the
    // wrong shape. buildToolSchema again here, not z.object(tool.shape)
    // directly -- see its own header above for why calling z.object() on a
    // ZodRawShape-typed value directly is what caused the OOM crash.
    const args = buildToolSchema(tool.shape).parse(request.params.arguments ?? {}) as Record<string, unknown>;
    return tool.handler(args, backend.documentationService);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Closes the Nest application context on the way out -- same cleanup
  // discipline bootstrapBackend's own vscode-extension counterpart already
  // follows (extension.ts's deactivate()), just triggered by process exit
  // here instead of VSCode's own deactivation hook.
  process.on("SIGINT", () => void backend.close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void backend.close().then(() => process.exit(0)));
}

main().catch((err) => {
  console.error("rapid-docs-mcp-server failed to start:", err);
  process.exit(1);
});
