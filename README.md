# agent-memory-mcp

> Markdown memory for AI agents. Your data is just files.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-blueviolet)](https://modelcontextprotocol.io)

**The only MCP memory server that isn't a database.** Every other option asks you to trust a knowledge graph, a vector DB, Postgres + pgvector, DuckDB, or Neo4j. This one writes plain markdown files to a directory.

You can `cat` your memory. You can `grep` it. You can edit it in vim. You can commit it to git. You can move it between machines with `scp`. If the AI gets it wrong, you fix it in a text editor and save. No migration scripts. No vendor lock-in. No "just trust the embedding."

---

## What you get

```text
.agent-memory/
├── MEMORY.md                           # auto-managed index
├── user-prefers-tabs.md
├── feedback-no-emoji-in-code.md
├── project-q3-launch-frozen.md
└── reference-postgres-runbook.md
```

A memory file is just markdown with YAML frontmatter:

```markdown
---
name: feedback-no-emoji-in-code
description: User wants zero emoji in commits, comments, or output
type: feedback
---

Hard rule. No emoji anywhere user-facing.

**Why:** prior contractor flooded the repo with them; user spent a
weekend removing them.

**How to apply:** scrub before commit; reject any tool output that
adds them automatically.
```

That's the whole format. No magic. Read it, edit it, ship it.

---

## Why this exists

Most MCP clients have no persistent memory. The ones that do (Claude Code) store it where only that client can see it. The official `server-memory` and every community alternative use opaque structured backends. That's fine for some workflows — but it puts your data behind a layer you can't read with `cat`.

We chose markdown because:

- **Universal.** Every developer can read markdown. Every editor handles it. Every diff tool understands it.
- **Portable.** Memories travel with the project (per-project default) or with you (global mode). Move them, copy them, fork them — they're just files.
- **Inspectable.** You can audit what your AI assistant "knows" by opening a folder.
- **Repairable.** When a memory is wrong, you fix it the way you fix any text file. No SDK, no API, no SQL.
- **Versionable.** Git understands every change. No JSON merge conflicts. No binary blobs.

If you want vector similarity search, semantic recall, or auto-relation extraction — use one of the database-backed memory MCPs. They're great at that. If you want memory that you can still read after a power outage, this is for you.

---

## Install

### Quick start (works today, no npm needed)

```bash
npx -y github:xultrax-web/agent-memory-mcp
```

### From npm (after v0.2.0 ships)

```bash
npx -y @xultrax-web/agent-memory-mcp
```

### Build locally

```bash
git clone https://github.com/xultrax-web/agent-memory-mcp
cd agent-memory-mcp
npm install
npm run build
node dist/index.js
```

The server speaks MCP over stdio. You don't run it directly — your MCP client launches it.

---

## Client configuration

Same JSON, slightly different paths per client.

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in your project):

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["-y", "github:xultrax-web/agent-memory-mcp"]
    }
  }
}
```

### Cline (VS Code extension)

Cline → MCP Servers → Add:

```json
{
  "agent-memory": {
    "command": "npx",
    "args": ["-y", "github:xultrax-web/agent-memory-mcp"]
  }
}
```

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "npx",
      "args": ["-y", "github:xultrax-web/agent-memory-mcp"]
    }
  }
}
```

> **Windows note:** if `npx` doesn't resolve cleanly, wrap with `cmd /c`:
>
> ```json
> { "command": "cmd", "args": ["/c", "npx", "-y", "github:xultrax-web/agent-memory-mcp"] }
> ```

### Continue.dev

`~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "github:xultrax-web/agent-memory-mcp"]
        }
      }
    ]
  }
}
```

### Storage scope

Per-project (default): memories live in `./.agent-memory/` relative to wherever the client launched the server. Usually that's the project root.

Personal / global pool:

```json
"env": { "AGENT_MEMORY_SCOPE": "global" }
```

Global memories live at `~/.agent-memory/`.

Custom path:

```json
"env": { "AGENT_MEMORY_DIR": "/abs/path/to/memory" }
```

---

## Tools

| Tool              | Purpose                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `save_memory`     | Create or update a memory. Validates the name (kebab-case) and type. Updates the index. |
| `search_memories` | Substring search across name, description, and body. Returns top 10 by relevance score. |
| `get_memory`      | Fetch one memory by name. Returns frontmatter + body.                                   |
| `list_memories`   | List all memories. Optional `type` filter.                                              |
| `delete_memory`   | Remove a memory file and its index entry.                                               |

### Memory types

Four built-in types, matching the Claude Code convention:

- **user** — facts about the person (role, preferences, expertise level)
- **feedback** — rules the assistant should follow (do this, don't do that)
- **project** — current-state context that isn't in the code (deadlines, in-flight work)
- **reference** — pointers to external systems (Linear board URL, monitoring dashboard)

---

## CLI

The same binary is also a command-line tool. Useful in shell scripts, git hooks, cron, or just for quick lookups outside your editor.

```bash
agent-memory save user-likes-tabs --type user --description "Prefers tabs" --content "Always use tabs in new files."
agent-memory list
agent-memory list --type feedback
agent-memory search "tabs"
agent-memory get user-likes-tabs
agent-memory delete user-likes-tabs
```

Multi-line content can come from a file or stdin:

```bash
agent-memory save my-handoff --type project --description "Q3 handoff notes" --content-file handoff.md
cat conversation.txt | agent-memory save extracted-prefs --type user --description "Pulled from chat" --stdin
```

### Importing from Claude Code

If you've been using Claude Code's built-in memory, bring it over:

```bash
# See what would be imported (dry run, no writes)
agent-memory import-claude-code --dry-run

# Filter to one project by substring match (case-insensitive)
agent-memory import-claude-code --project prefixcheck --dry-run

# Do the import
agent-memory import-claude-code --project prefixcheck

# Replace existing memories with the same names
agent-memory import-claude-code --project prefixcheck --overwrite
```

The importer walks `~/.claude/projects/*/memory/`, parses each memory's YAML frontmatter (tolerantly — malformed files don't kill the run), flattens Claude Code's `metadata.type` field to top-level `type`, and writes to your current store. Existing memories with the same name are skipped unless you pass `--overwrite`.

---

## How it compares

The memory MCP landscape, as of May 2026:

| Server                                           | Backend                | Hand-editable? | Greppable? | Git-friendly?  |
| ------------------------------------------------ | ---------------------- | -------------- | ---------- | -------------- |
| **agent-memory-mcp (this)**                      | **Markdown files**     | **Yes**        | **Yes**    | **Yes**        |
| `@modelcontextprotocol/server-memory` (official) | Knowledge graph (JSON) | No (raw JSON)  | Limited    | Painful merges |
| memory-graph/memory-graph                        | Graph DB               | No             | No         | No             |
| IzumiSy/mcp-duckdb-memory-server                 | DuckDB                 | No             | No         | No             |
| sdimitrov/mcp-memory                             | Postgres + pgvector    | No             | No         | No             |
| JovanHsu/mcp-neo4j-memory-server                 | Neo4j                  | No             | No         | No             |

**The trade you're making:** you give up native semantic similarity search and structured entity-relation queries. You get a memory store that survives every tool change, every machine swap, every "wait, what was that AI telling me about this codebase six months ago?"

For most workflows that's a good trade. For some it isn't. Pick the right tool.

---

## Operator-grade by design

This server is built to be used daily, not to demo well once. v1.0 includes:

- **Atomic writes** — no partial writes if power dies
- **Soft delete** — `delete_memory` moves to `.trash/`, restore command available
- **Index recovery** — `agent-memory doctor` rebuilds `MEMORY.md` if it diverges
- **Read-only mode** — `AGENT_MEMORY_READ_ONLY=1` for shared/published stores
- **Event log** — every read/write goes to `.events.jsonl` for audit
- **No silent failures** — every error includes a remediation
- **Spec-compliant** — implements MCP Resources alongside Tools; clients can pin the memory index as always-visible context

(Some of these land in v0.2-v0.7 over the next two weeks. Check [CHANGELOG.md](CHANGELOG.md) for current shipped features.)

---

## Roadmap

- **v0.2** — MCP Resources support, Claude Code import script (`agent-memory import-claude-code`), CLI mode
- **v0.3** — Atomic writes, soft delete, schema versioning, doctor command
- **v0.4** — Structured event log, stats command, color output
- **v0.5** — Fuzzy search (Fuse.js), BM25 ranking, snippet highlighting
- **v0.7** — Comprehensive test suite, multi-client compatibility matrix
- **v0.9** — npm publish + MCP Registry submission
- **v1.0** — Public launch

Beyond v1.0: sync backends (git remote, S3), web UI, team mode, browser extension, optional embeddings sidecar.

Open an issue if you want one of these before I get to it.

---

## License

MIT. Use it for whatever.

---

## Author

[@xultrax-web](https://github.com/xultrax-web) · built for the cross-client memory problem I kept running into. Part of [PrefixCheck Labs](https://prefixcheck.com/labs/).

Inspired by the file-based memory system in Anthropic's Claude Code.
