# agent-memory-mcp

> Memory that lives in your repo, not someone else's database.

A minimal MCP server that gives any compatible client (Cursor, Cline, Continue, Claude Desktop, etc.) persistent, file-based memory. Each memory is a plain Markdown file with YAML frontmatter, indexed by a single `MEMORY.md`. You can grep it, edit it by hand, commit it, diff it.

Inspired by Claude Code's built-in memory pattern — now available everywhere else MCP runs.

---

## Why this exists

Most MCP clients have no native memory. The ones that do (looking at you, Claude Code) store it in a place only that client can see. This server fixes both problems:

- **One memory store, many clients.** Cursor on your laptop and Claude Desktop on the same machine can read the same memories.
- **Plain files.** You can `cat`, `grep`, `git add`, and `vim` your memory. No SQLite blob, no opaque vector DB.
- **Per-project by default.** Memories scope to the directory you start the MCP from, just like a `.git` folder. Use `AGENT_MEMORY_SCOPE=global` for a personal-knowledge style.

---

## What you get

```
.agent-memory/
├── MEMORY.md                           # auto-managed index, one line per memory
├── user-prefers-tabs.md
├── feedback-no-emoji-in-code.md
├── project-q3-launch-frozen.md
└── reference-postgres-runbook.md
```

A memory file looks like this:

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

Plain. Greppable. Portable.

---

## Install

Until npm publish lands, install straight from GitHub:

```bash
npx -y github:xultrax-web/agent-memory-mcp
```

Or clone + build locally:

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
{
  "command": "npx",
  "args": ["-y", "github:xultrax-web/agent-memory-mcp"],
  "env": { "AGENT_MEMORY_SCOPE": "global" }
}
```

Global memories live at `~/.agent-memory/`.

Custom path:

```json
"env": { "AGENT_MEMORY_DIR": "/abs/path/to/memory" }
```

---

## Tools

| Tool | Purpose |
|---|---|
| `save_memory` | Create or update a memory. Validates the name (kebab-case) and type. Updates the index. |
| `search_memories` | Substring search across name, description, and body. Returns top 10 by relevance score. |
| `get_memory` | Fetch one memory by name. Returns frontmatter + body. |
| `list_memories` | List all memories. Optional `type` filter. |
| `delete_memory` | Remove a memory file and its index entry. |

### Memory types

Four built-in types, matching the Claude Code convention:

- **user** — facts about the person (role, preferences, expertise level)
- **feedback** — rules the assistant should follow (do this, don't do that)
- **project** — current-state context that isn't in the code (deadlines, in-flight work)
- **reference** — pointers to external systems (Linear board URL, monitoring dashboard)

---

## How it compares

| | agent-memory-mcp | Claude Code built-in | Vector DB MCPs (chroma, qdrant, etc.) |
|---|---|---|---|
| Storage format | Markdown files | Markdown files | Binary embeddings |
| Hand-editable | Yes | Yes | No |
| Greppable | Yes | Yes | No |
| Works in Cursor / Cline / Continue | **Yes** | No | Yes |
| Requires API key or external service | No | No | Often yes |
| Semantic / vector search | No | No | Yes |
| Setup time | 30 sec | n/a (built-in) | 5-30 min |

If you want fuzzy semantic recall, use a vector-backed MCP. If you want a memory system that's still useful when the power's out — and that travels with your project in git — this one's for you.

---

## Roadmap

- npm publish for one-command install
- Optional `link_memories` tool that maintains `[[name]]` cross-references
- Optional content-hash dedup
- Optional sync via git remote (memory store as a sub-repo)
- Maybe: an optional sidecar for embeddings, if anyone actually wants it

Open an issue if you want one of these before I get to it.

---

## License

MIT. Use it for whatever.

---

## Author

[@xultrax-web](https://github.com/xultrax-web) · built for the cross-client memory problem I kept running into. Inspired by the file-based memory system in Anthropic's Claude Code.
