# agent-memory-mcp

> Codify how you work. Every AI tool obeys.

[![CI](https://github.com/xultrax-web/agent-memory-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/xultrax-web/agent-memory-mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-blueviolet)](https://modelcontextprotocol.io)

**Memory as constraint, not just recall.** Plain markdown files in a directory you control. Capture your rules + recipes + decisions + context once, applied everywhere — across sessions, across machines, across every AI tool you use.

The wedge:

1. **Rules are first-class memories.** Tag with severity (hard / soft), scope, enforce_on category, regex patterns, last_verified date.
2. **Companion files emit automatically** to `AGENTS.md` (Linux-Foundation universal standard), `CLAUDE.md` (Claude Code's 5-level hierarchy), `.cursor/rules/*.mdc` (Cursor MDC), and `.gemini/instructions.md` — your rules show up in every tool, every session, with no plugin needed.
3. **`check_action` gates destructive operations.** Agent proposes an action, server matches against your rule store, and either issues a [Compliance Receipt](docs/compliance-receipt-protocol-1.0.md) (HMAC-signed bearer token bound to your rules) or returns a structured rejection naming the rule that blocked.
4. **Plain files all the way down.** You can `cat` your memory, `grep` it, edit it in vim, commit it to git, sync it to another machine via the built-in `agent-memory sync`. If the AI gets it wrong, you fix it in a text editor and save. No migration scripts. No vendor lock-in. Reference implementation of the [Compliance Receipt Protocol 1.0](docs/compliance-receipt-protocol-1.0.md) — other MCP servers can adopt the same receipts and interoperate.

---

## Memory as constraint · the v0.11 → v0.13 arc

What v0.10 and below shipped: a great file-based memory store. What v0.11+ added: rules that _enforce themselves_. A `rule` memory type carries `severity` (hard / soft), `scope`, `applies_when`, `matches` regex patterns, `enforce_on` categories, and `last_verified` date. From those, the server projects companion files out to every AI tool and gates destructive operations via cryptographic receipts.

### 1. Rule memories project to every tool

```bash
agent-memory save-rule no-emojis-ever \
  --description "Never use emojis in commits, comments, or chat output." \
  --severity hard \
  --scope global \
  --enforce-on commits,chat_responses \
  --content "No emojis. Anywhere. Ever."

agent-memory emit-companions
# writes AGENTS.md + CLAUDE.md + .cursor/rules/*.mdc + .gemini/instructions.md
```

| Target   | Path                                                                                                   | Auto-loaded by                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `agents` | `AGENTS.md`                                                                                            | Claude Code, Codex CLI, Cursor, Aider, Devin, Copilot, Gemini CLI, Windsurf, Amazon Q |
| `claude` | `CLAUDE.md`                                                                                            | Claude Code (5-level hierarchy · managed/global/project/local/subdir)                 |
| `cursor` | `.cursor/rules/operator-hard.mdc` (`alwaysApply: true`) + `operator-conventions.mdc` (agent-requested) | Cursor (MDC format)                                                                   |
| `gemini` | `.gemini/instructions.md`                                                                              | Gemini CLI                                                                            |

Set `AGENT_MEMORY_AUTO_EMIT_DIR=/path/to/project` and the server re-emits all four files automatically on every rule save.

### 2. `check_action` · the protocol enforcement point

```bash
# Agent proposes an action · server matches against rule store
agent-memory check-action "delete the memory called old-project-notes" --type deletions

# → On approval: returns a Compliance Receipt the agent passes back to destructive tools
# → On deny: returns structured hard_violations + soft_warnings
```

MCP shape:

```jsonc
{
  "name": "check_action",
  "arguments": {
    "action": "delete the memory called old-project-notes",
    "action_type": "deletions",
    "session_id": "sess_abc",
  },
}
```

**Tier 1** (deterministic, every client): action matched against `rule.matches` regex, filtered by `rule.enforce_on`. Hard violations block. Soft violations warn. Approved actions get a fresh receipt with 60s TTL.

**Tier 2** (Sampling-enriched, shipped v0.11.7): for rules with `applies_when` natural-language conditions, the server uses MCP Sampling to ask the client's LLM whether the proposed action triggers the rule. Falls back to Tier 1 only if the client doesn't advertise Sampling capability. Works on Claude Desktop and VS Code Copilot; on Claude Code, Cursor, Cline, and Codex CLI you get Tier 1 only — which is enough to enforce the rules you've written.

### 3. Compliance Receipts · the cryptographic primitive

Receipts are short-lived, signed bearer tokens with caveats (Macaroon pattern · [Birgisson et al., NDSS 2014](https://research.google/pubs/pub41892/)). The novel protocol primitive: server-issued tokens that bind to action + session + rules-version-hash + expiry. Tampering breaks the signature. Rule changes invalidate every outstanding receipt (because `rules_version` is part of the signed payload).

```typescript
import { issueReceipt, validateReceipt } from "@xultrax-web/agent-memory-mcp";

const r = issueReceipt({
  caveats: [
    { type: "action", value: "delete_memory" },
    { type: "session", value: "sess_abc123" },
  ],
  ttl_seconds: 60,
});

const v = validateReceipt(r, {
  required_caveats: [{ type: "action", value: "delete_memory" }],
});
if (!v.valid) throw new Error(v.reason);
```

**Receipt-required `delete_memory` (v0.12.0 breaking change):** calling `delete_memory` without a valid receipt is refused. The two-step pattern is `check_action` → `delete_memory(name, receipt)`. The signing-key file lives at `<MEMORY_DIR>/.keyring/hmac-key` (CRP 1.0) or `<MEMORY_DIR>/.keyring/ed25519-priv` (CRP 1.1), `0600` perms on POSIX.

**CRP 1.1 · Ed25519 federation (v0.13.0):** flip `CRP_SIGNING_MODE=ed25519` and the server signs with an asymmetric keypair instead of HMAC. The public key gets published at `<MEMORY_DIR>/.keyring/ed25519-pub`, so other MCP servers can validate your receipts without sharing a secret. The protocol allows cross-server enforcement: server A issues a receipt for "delete X", server B validates and honors it.

### 4. `audit` · operational health for the rule store

```bash
agent-memory audit          # pretty colored terminal output
agent-memory audit --json   # structured JSON for tooling
```

Surfaces:

- Rule count by severity (hard / soft / unspecified)
- **Stale rules** · `last_verified` > 90 days, or never verified
- **Pattern conflicts** · two rules sharing an `enforce_on` AND an identical regex in `matches`
- **Recent denials** · `check_action` calls that blocked an action (spot over-aggressive rules)
- **Unreceipted destructive ops** · should be empty in v0.12+; non-empty means a client is calling `delete_memory` without going through `check_action`

The `healthy` flag is true iff no stale rules, no conflicts, no unreceipted ops.

### 5. CRP 1.0 / 1.1 as a portable spec

The receipt protocol is documented standalone at [docs/compliance-receipt-protocol-1.0.md](docs/compliance-receipt-protocol-1.0.md). Other MCP servers can adopt the same format + validation rules to interoperate · `agent-memory-mcp` is the reference implementation. The spec covers: receipt structure, canonical encoding, signing (HMAC-SHA256 for 1.0, Ed25519 for 1.1), validation order, rules-version hashing, reserved caveat types, MCP integration patterns, security considerations, cross-server adoption, and test vectors.

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

### From npm (recommended)

```bash
npx -y @xultrax-web/agent-memory-mcp
```

### Listed in the MCP Registry

`io.github.xultrax-web/agent-memory-mcp` · browse at https://registry.modelcontextprotocol.io

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
      "args": ["-y", "@xultrax-web/agent-memory-mcp"]
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
    "args": ["-y", "@xultrax-web/agent-memory-mcp"]
  }
}
```

### VS Code (Copilot Chat)

> **Two VS Code paths.** The Cline section above is for the Cline extension specifically (its own MCP server UI). This section is for VS Code's native MCP support — GitHub Copilot Chat reads it directly. Pick whichever matches your assistant; both coexist fine.

`.vscode/mcp.json` (workspace) or via User Settings → Edit `mcp.json`:

```json
{
  "servers": {
    "agent-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@xultrax-web/agent-memory-mcp"]
    }
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
      "args": ["-y", "@xultrax-web/agent-memory-mcp"]
    }
  }
}
```

> **Windows note:** if `npx` doesn't resolve cleanly, wrap with `cmd /c`:
>
> ```json
> { "command": "cmd", "args": ["/c", "npx", "-y", "@xultrax-web/agent-memory-mcp"] }
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
          "args": ["-y", "@xultrax-web/agent-memory-mcp"]
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

| Tool                | Purpose                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save_memory`       | Create or update a memory. Atomic write + locked. Validates name + type. Updates the index.                                                                                 |
| `search_memories`   | Fuzzy search (Fuse.js · typo-tolerant, word-order tolerant, partial matches). Returns top N with relevance 0-100 + body snippet.                                            |
| `relevant_memories` | Same matching as search, but returns full memory bodies as one markdown doc. Built for LLM auto-context.                                                                    |
| `get_memory`        | Fetch one memory by name. Returns frontmatter + body.                                                                                                                       |
| `list_memories`     | List memories. Optional `type` filter. Paginated (default 50/page).                                                                                                         |
| `delete_memory`     | **v0.12+: receipt-required.** Pass a valid Compliance Receipt with `{type:'action_type', value:'deletions'}`. Soft-deletes to `.trash/<ts>-<name>.md` on success.           |
| `restore_memory`    | Restore a soft-deleted memory from `.trash/`. Picks the most recent trash entry for the name.                                                                               |
| `doctor`            | Storage integrity check. Reports orphans, dangling index entries, unreadable files. Pass `rebuild-index=true` to repair `MEMORY.md` from disk.                              |
| `stats`             | Dashboard: counts per type, total size, largest memory, audit-log size, trash count.                                                                                        |
| `log_events`        | Read recent entries from the audit event log. Optional `tail` (default 20) + `action` filter.                                                                               |
| `verify_memory`     | Re-evaluate a memory's claims. Extracts URLs/dates/file refs, flags stale-date signals, returns type-specific verification heuristics. Pairs with the `audit_stale` prompt. |
| `find_backlinks`    | List memories that link to the given memory via `[[wiki-link]]` syntax in their bodies. Useful for "what references this" views.                                            |
| `find_related`      | Surface memories related to one by combining outbound links, inbound backlinks, shared tags, type match, and content similarity. Navigates the memory graph by association. |
| `sync_status`       | Report git-sync state: remote URL, branch, uncommitted local files, ahead/behind origin.                                                                                    |
| `sync_push`         | Commit local memory changes + push to the configured git remote. Auto-timestamps the commit message if none given.                                                          |
| `sync_pull`         | Fast-forward pull from the git remote. Refuses to pull if local changes are uncommitted.                                                                                    |
| `save_rule`         | **v0.11+.** Create or update a `rule` memory with `severity` / `scope` / `matches` / `enforce_on` / `applies_when` / `last_verified`. Auto-emits companions if configured.  |
| `list_rules`        | **v0.11+.** List just rule memories, optionally filtered by severity or enforce_on category.                                                                                |
| `emit_companions`   | **v0.11.1+.** Project the rule store out to `AGENTS.md` + `CLAUDE.md` + `.cursor/rules/*.mdc` + `.gemini/instructions.md`. Pass `target` to filter.                         |
| `check_action`      | **v0.11.3+.** Tier-1 deterministic + Tier-2 Sampling rule check. Returns `{approved, hard_violations, soft_warnings, receipt?}`. The protocol enforcement point.            |
| `audit`             | **v0.11.4+.** Operational health for the rule store: stale rules, pattern conflicts, recent denials, unreceipted destructive ops. Returns JSON or pretty-prints.            |

### Prompts

The server exposes 4 built-in MCP prompts that clients (Claude Desktop, Cursor, etc.) surface as slash-commands. These turn memory into an active workflow layer, not just a passive store:

| Prompt             | Arguments            | What it does                                                                                                                            |
| ------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `extract_memories` | none                 | LLM scans the current conversation, proposes candidate memories, and calls `save_memory` for each one (with type + description chosen). |
| `summarize_topic`  | `topic`              | LLM pulls memories relevant to the topic via `relevant_memories` and synthesizes them into a single summary with citations.             |
| `prepare_handoff`  | `project` (optional) | LLM walks project-type memories matching the filter and assembles a structured handoff doc (current state, open items, watch-outs).     |
| `audit_stale`      | none                 | LLM evaluates project + reference memories for staleness and produces a triage list (likely stale / worth verifying / still fresh).     |

### Memory types

Five built-in types. The first four match the Claude Code convention; `rule` is what v0.11 added:

- **user** — facts about the person (role, preferences, expertise level)
- **feedback** — soft guidance for the assistant (prefer this style, lean toward that approach)
- **project** — current-state context that isn't in the code (deadlines, in-flight work)
- **reference** — pointers to external systems (Linear board URL, monitoring dashboard)
- **rule** — constraints to enforce, not just facts to recall. Carries `severity`, `scope`, `matches`, `enforce_on`, `applies_when`, `last_verified`. Projects to companion files; gates `check_action`.

### Tags + wiki-links

Beyond types, two cross-cutting organization features:

**Tags** — optional `tags: [a, b, c]` array in frontmatter. Queryable via `list_memories({tags: [...]})` and the `agent-memory list --tags "a,b"` CLI. Filter is intersection — memories must have all listed tags. Tag names are lowercase a-z + digits + hyphen/underscore, max 40 chars.

```markdown
---
name: deploy-process
description: Blue-green prod deployment
type: project
tags: [deployment, production, critical]
---
```

**Wiki-links** — write `[[memory-name]]` anywhere in a memory body and it becomes a link. `find_backlinks` returns memories that reference a given one; `find_related` ranks the full graph (outbound links, inbound backlinks, shared tags, content similarity) for discovery navigation.

---

## CLI

The same binary is also a command-line tool. Useful in shell scripts, git hooks, cron, or just for quick lookups outside your editor.

```bash
agent-memory save user-likes-tabs --type user --description "Prefers tabs" --content "Always use tabs in new files."
agent-memory list
agent-memory list --type feedback
agent-memory search "tabs"                    # fuzzy, top 10 by relevance
agent-memory search "depoy" --limit 5         # typo-tolerant ("depoy" → "deploy")
agent-memory relevant "deployment" --max 3    # full memory bodies, LLM-ready
agent-memory get user-likes-tabs
agent-memory list --limit 20 --offset 40      # pagination
agent-memory delete user-likes-tabs           # soft delete — moves to .trash/
agent-memory restore user-likes-tabs          # restore the most recent trash entry
agent-memory doctor                            # check integrity
agent-memory doctor --rebuild-index            # repair MEMORY.md from disk
agent-memory stats                             # dashboard: counts, sizes, audit/trash
agent-memory log                               # last 20 entries from the audit log
agent-memory log --tail 50 --action delete     # filter by action, tail size
agent-memory verify deploy-process             # extract URLs/dates/file refs + staleness heuristics
agent-memory save my-mem --type project --description "X" --content "Body" --tags "production,critical"
agent-memory list --tags "production"          # filter by tag (intersection)
agent-memory backlinks deploy-process          # memories that link to deploy-process
agent-memory related deploy-process            # ranked discovery: links + tags + similarity
agent-memory sync init git@github.com:you/agent-memory.git    # multi-machine setup (one-time)
agent-memory sync push                         # commit + push local changes
agent-memory sync pull                         # fast-forward from remote
agent-memory sync status                       # local + ahead/behind state
agent-memory ui                                # launch the TUI (browse + edit interactively)

# v0.11+ · rules and enforcement
agent-memory save-rule no-emoji --severity hard --enforce-on commits,chat_responses \
  --matches "emoji|:[a-z_]+:" --content "No emojis. Anywhere. Ever."
agent-memory list-rules                        # rule memories only
agent-memory list-rules --severity hard        # filter by severity
agent-memory emit-companions                   # write AGENTS.md + CLAUDE.md + .cursor/rules + .gemini
agent-memory emit-companions --target agents,claude   # filter targets
agent-memory check-action "delete old notes" --type deletions   # returns approval + receipt JSON
agent-memory audit                             # pretty operational health report
agent-memory audit --json                      # structured JSON for tooling
```

### Multi-machine memory (git sync)

The killer feature for file-based memory: every dev machine has git, and markdown merges cleanly. `agent-memory sync` turns `.agent-memory/` into a git repo pointed at a (private) remote, and your memories follow you across desktop/laptop/server.

```bash
# One-time setup
agent-memory sync init git@github.com:you/agent-memory.git

# End of the day on desktop
agent-memory sync push

# Pick up your laptop before bed
agent-memory sync pull

# Save a new memory while reading in bed
agent-memory save bedtime-thought --type project --description "..." --content "..."
agent-memory sync push

# Next morning at desktop
agent-memory sync pull          # picks up the bedtime memory
```

What's NOT synced (per-machine state, kept local):

- `.lock` — per-process file lock
- `.events.jsonl` — per-machine audit trail
- `.trash/` — soft-delete staging

What IS synced: every memory file, the `MEMORY.md` index, and any `.gitignore` you add.

Commits use the identity `agent-memory <agent-memory@local>` by default — set `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_EMAIL` in your environment if you want per-machine attribution.

### Audit log + structured logging

Every mutation appends one JSON line to `.agent-memory/.events.jsonl`:

```jsonl
{"ts":"2026-05-22T04:02:38.536Z","action":"save","name":"first-mem","type":"user","update":false,"bytes":6}
{"ts":"2026-05-22T04:02:39.414Z","action":"delete","name":"second-mem","trash":"1779422559413-second-mem.md"}
{"ts":"2026-05-22T04:02:39.712Z","action":"restore","name":"second-mem","binnedAt":"2026-05-22T04:02:39.413Z"}
```

Read it any way you want: `cat`, `jq`, the `log` / `log_events` tool, or a sidecar that ships it to your observability stack.

Operational logging is separate. Set `AGENT_MEMORY_LOG=debug|info|warn|error` (default `info`) and structured lines stream to stderr — won't pollute the MCP stdio channel.

Color output is on by default in TTYs. Set `NO_COLOR=1` to disable, `FORCE_COLOR=1` to force-enable in pipes.

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

## Why files, not a database

You give up native semantic similarity search and structured entity-relation queries. You get a memory store that survives every tool change, every machine swap, every "wait, what was that AI telling me about this codebase six months ago?" — and that you can still read after a power outage.

The trade is real. For workflows that need vector recall or graph queries, a database-backed memory is the right tool. For workflows where memory is something you want to grep, edit, version-control, and audit by hand, this is.

---

## Operator-grade by design

This server is built to be used daily, not to demo well once.

**Shipped in v0.3:**

- **Atomic writes** — tmp-file + rename pattern. Power-loss never leaves a half-written file.
- **File locking** — `proper-lockfile` around every mutation. Concurrent MCP server + CLI access can't corrupt the index.
- **Soft delete** — `delete_memory` moves to `.trash/<timestamp>-<name>.md`. `restore_memory` brings it back.
- **Index recovery** — `agent-memory doctor` reports orphan files, dangling entries, and parse errors. `--rebuild-index` rewrites `MEMORY.md` from disk.
- **Schema versioning** — every memory file gets a `schema: 1` field so future format changes can migrate cleanly.
- **Spec-compliant Resources** — `agent-memory://index` + `agent-memory://memory/{name}`; clients can pin them as always-visible context.

**Shipped in v0.4:**

- **Append-only event log** at `.events.jsonl` — every mutation timestamped + JSON-structured for audit.
- **`agent-memory stats`** — dashboard of counts per type, total/avg/largest size, audit + trash counts.
- **`agent-memory log`** — paginated browser of the event log, filterable by action.
- **Structured stderr logging** — `AGENT_MEMORY_LOG=debug|info|warn|error`; safe to use alongside MCP stdio.
- **Color output** — auto-detected via TTY, respects `NO_COLOR` / `FORCE_COLOR`.

**Shipped in v0.5:**

- **Fuse.js fuzzy search** with field weights (name×3, description×2, body×1). Typo, partial, and word-order tolerant.
- **Snippet highlighting** — body-context excerpts shown under each match with `...` markers.
- **Relevance scoring** — Fuse score inverted + scaled to 0-100 for human readability.
- **`relevant_memories(query, max=5)`** — sister tool to search that returns FULL memory bodies as a single markdown doc, built for LLM auto-context loading.
- **Pagination** — `offset` + `limit` on `list_memories` and `limit` on `search_memories`.

**Shipped in v0.6:**

- **Vitest test suite** — 25+ blackbox tests covering CLI + MCP server paths.
- **GitHub Actions CI** — runs tests on every push/PR across Node 20/22/24.
- **[COMPATIBILITY.md](COMPATIBILITY.md)** — known-working client matrix + quirks.

**Shipped in v0.7 · the active context layer:**

- **MCP Prompts capability** — 4 built-in workflows (`extract_memories`, `summarize_topic`, `prepare_handoff`, `audit_stale`) that the client surfaces as slash-commands.
- **`verify_memory` tool** — static analysis of a memory's URLs/dates/file refs with type-specific staleness heuristics. Plus the matching `agent-memory verify <name>` CLI.
- **Conflict detection on save** — fuzzy-matches new memories against existing ones; warns on near-duplicates without blocking the save (so the LLM can decide whether to merge, rename, or proceed).

**Shipped in v0.8 · organization at scale:**

- **Tags** — optional `tags: [...]` array in frontmatter. Queryable via `list_memories` and `agent-memory list --tags "a,b"`. Intersection filter.
- **`[[wiki-links]]`** — write `[[memory-name]]` in any memory body, auto-detected.
- **`find_backlinks`** tool + `agent-memory backlinks <name>` CLI — "what links to this".
- **`find_related`** tool + `agent-memory related <name>` CLI — combines outbound + inbound links, shared tags, type match, and content similarity into a ranked discovery view.

**Shipped in v0.9 · the moat — multi-machine memory via git:**

- **`agent-memory sync init <remote-url>`** — convert `.agent-memory/` into a git repo, push to remote.
- **`agent-memory sync push`** — auto-commit local changes + push.
- **`agent-memory sync pull`** — fast-forward from remote.
- **`agent-memory sync status`** — local state + commits ahead/behind origin.
- **`agent-memory sync log`** — history of cross-machine memory changes.
- **`sync_status` / `sync_push` / `sync_pull` MCP tools** — the LLM can do this too.
- Per-machine state (`.lock`, `.events.jsonl`, `.trash/`) auto-excluded from sync.
- Default commit identity injected (`agent-memory@local`) so machines without `git config --global user.email` work without setup.

**Shipped in v0.10 · the visual identity (TUI):**

- **`agent-memory ui`** — Ink-based terminal UI for browsing, filtering, searching, and editing memories without leaving the terminal.
- Type-filter quick-keys (0-4 cycle through all/user/feedback/project/reference)
- Fuzzy live search with `/`
- `e` opens the highlighted memory in `$EDITOR` (vim/notepad/nano/whatever) — saves back to disk
- `d` soft-deletes with `y/n` confirmation
- Detail pane previews the body of the selected memory
- Color-coded by type, tag chips inline

**Shipped in v0.11 · memory as constraint:**

- `rule` memory type with `severity` / `scope` / `matches` / `enforce_on` / `applies_when` / `last_verified`
- `save_rule` + `list_rules` tools and CLI commands
- `emit_companions` projects rules to `AGENTS.md` + `CLAUDE.md` + `.cursor/rules/*.mdc` + `.gemini/instructions.md`
- `AGENT_MEMORY_AUTO_EMIT_DIR` triggers re-emission on every rule save
- **Compliance Receipts** (`issueReceipt` / `validateReceipt`) — HMAC-SHA256 bearer tokens with Macaroon-style caveats, bound to `rules_version` so rule changes invalidate outstanding tokens
- `check_action` MCP tool (Tier 1 deterministic; Tier 2 Sampling-enriched on v0.11.7 for clients that advertise the capability)
- `audit` command — stale rules, pattern conflicts, recent denials, unreceipted destructive ops
- [CRP 1.0 protocol spec](docs/compliance-receipt-protocol-1.0.md) — portable, vendor-neutral

**Shipped in v0.12 · the wedge made teeth (breaking change):**

- `delete_memory` REQUIRES a valid receipt. Calling without one is refused at the tool boundary.
- Two-step pattern is canonical: `check_action` → receipt → `delete_memory(name, receipt)`
- Audit log no longer needs an "unreceipted ops" warning class to surface escapes — there are none

**Shipped in v0.13 · cross-server federation:**

- CRP 1.1 · Ed25519 asymmetric signing (set `CRP_SIGNING_MODE=ed25519`)
- Public key published at `<MEMORY_DIR>/.keyring/ed25519-pub` so other servers can validate without sharing a secret
- 9 dedicated Ed25519 tests verifying keypair generation, signing, and cross-server validation paths

---

## Roadmap

### Released

| Version   | Highlights                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------- |
| v0.1      | Five-tool MVP, file storage, four-client config snippets                                            |
| v0.2      | MCP Resources, Claude Code import (`agent-memory import-claude-code`), CLI mode, prettier baseline  |
| v0.3      | Atomic writes, file locking, soft delete + `restore_memory`, `doctor` repair, schema versioning     |
| v0.4      | Append-only event log (`.events.jsonl`), `stats` dashboard, `log_events` browser, color output      |
| v0.5      | Fuzzy search via Fuse.js, relevance scoring, body-context snippets, `relevant_memories`, pagination |
| v0.6      | 25+ Vitest tests, GitHub Actions CI (Node 20/22/24 matrix), `COMPATIBILITY.md`                      |
| v0.7      | MCP Prompts (4 starter workflows), `verify_memory`, conflict detection on save                      |
| v0.8      | Tags, `[[wiki-links]]`, `find_backlinks`, `find_related`                                            |
| v0.8.1    | Trusted Publishing live · tokenless OIDC publishes to npm + MCP Registry on git tag                 |
| v0.9      | `agent-memory sync` · multi-machine memory via git remote (init/push/pull/status/log)               |
| v0.10     | Ink-based TUI · `agent-memory ui` for visual browsing, search, and editing                          |
| v0.11.0   | `rule` memory type + `AGENTS.md` companion emitter                                                  |
| v0.11.1   | `CLAUDE.md` + `.cursor/rules/*.mdc` + `.gemini/instructions.md` emitters                            |
| v0.11.2   | Compliance Receipts primitive · HMAC-SHA256 tokens with Macaroon-style caveats                      |
| v0.11.3   | `check_action` MCP tool (Tier 1 deterministic) + receipt-gated `delete_memory` (opt-in)             |
| v0.11.4   | `audit` command · stale rules, pattern conflicts, recent denials, unreceipted ops                   |
| v0.11.5   | CRP 1.0 protocol spec — portable, vendor-neutral enforcement primitive                              |
| v0.11.6   | Repositioning · "codify how you work, every AI tool obeys"                                          |
| v0.11.7   | Tier-2 Sampling-enriched `check_action` · LLM judges `applies_when` on capable clients              |
| **v0.12** | **Receipt REQUIRED on `delete_memory` · breaking change · the wedge made teeth**                    |
| **v0.13** | **CRP 1.1 · Ed25519 asymmetric signing for cross-server federation**                                |

### Coming next

- Receipt-gated `restore_memory` and `doctor --rebuild-index` (same `check_action` flow)
- Federation example · a second reference MCP server that issues + validates CRP 1.1 receipts
- Auto-context loading — server hook that auto-fires `relevant_memories` before each LLM turn
- Folder support inside the store (`.agent-memory/work/`, `.agent-memory/personal/`)
- Memory packs — export/import shareable `.tar.gz` bundles of curated memories
- Browser companion UI (`agent-memory web`)
- TUI polish — file-watching for auto-refresh, inline editing, sync as keybindings

### Beyond

Optional local-embeddings sidecar (transformers.js, no API), team mode with diff/merge, browser extension to capture from chatgpt.com / claude.ai → memory, mobile companion.

Open an issue if you want one of these before I get to it.

---

## License

MIT. Use it for whatever.

---

## Author

[@xultrax-web](https://github.com/xultrax-web) · built for the cross-client memory problem I kept running into. Part of [PrefixCheck Labs](https://prefixcheck.com/labs/).

Inspired by the file-based memory system in Anthropic's Claude Code.
