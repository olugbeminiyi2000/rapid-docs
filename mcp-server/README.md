# rapid-docs MCP server

Lets an AI coding agent (Claude Code, and any other MCP-compatible client) read and write [rapid-docs](https://github.com/olugbeminiyi2000/rapid-docs) documentation directly, the same actions you'd otherwise do by hand through the rapid-docs VS Code extension: check what's undocumented or drifted, write new documentation, update or delete existing records, and work with the archive.

## Setup

No install step needed. Add this to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "rapid-docs": {
      "command": "npx",
      "args": ["-y", "rapid-docs-mcp-server"]
    }
  }
}
```

Or with the Claude Code CLI:

```sh
claude mcp add rapid-docs -- npx -y rapid-docs-mcp-server
```

`npx` fetches and runs it on demand — every tool call carries its own repository path, so one server works across any project on your machine, with nothing to configure per-project beyond this one entry.

## Tools

**Read-only** — `check_file`, `find_record_for_selection`, `find_stale_record_for_selection`, `search_archive`

**Create** (can't overwrite existing documentation) — `document_selection`, `attach_archived_record`

**Requires your explicit confirmation** (can overwrite or permanently remove documentation) — `update_drifted_doc`, `edit_doc_text`, `delete_record`, `discard_archived_record`

The four confirmation-requiring tools are marked so a supporting client always prompts you before they run, regardless of any broader permission settings you've configured for this server's other tools.

## Requirements

A repository with [rapid-docs](https://github.com/olugbeminiyi2000/rapid-docs) already set up (a real git repository works best; see the main project for details — a non-git folder works too for the tools here, since none of them depend on git).
