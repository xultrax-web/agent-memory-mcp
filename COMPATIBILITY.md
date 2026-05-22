# Client compatibility

`agent-memory-mcp` is a standards-compliant MCP server (stdio transport, tools + resources capabilities). It should work with any client that speaks MCP. This file tracks which clients have been verified end-to-end and any quirks worth knowing.

## Verification status

| Client                    | Status      | Notes                                                                                              |
| ------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| Claude Code (Anthropic)   | Verified    | Native MCP support. Server's own tools register cleanly.                                           |
| Claude Desktop            | Config docs | Configured via `claude_desktop_config.json`. On Windows, wrap `npx` with `cmd /c`.                 |
| Cursor                    | Config docs | Configured via `~/.cursor/mcp.json` (or `.cursor/mcp.json` in project).                            |
| Cline (VS Code extension) | Config docs | Add via Cline's MCP Servers UI.                                                                    |
| VS Code (Copilot Chat)    | Config docs | Native MCP. `.vscode/mcp.json` (workspace) or `mcp.json` in User Settings. Uses `"type": "stdio"`. |
| Continue.dev              | Config docs | Configured under `experimental.modelContextProtocolServers`.                                       |
| Windsurf                  | Untested    | Should work — uses standard MCP. Report at GitHub Issues if it doesn't.                            |
| Zed                       | Untested    | Should work — uses standard MCP. Report at GitHub Issues if it doesn't.                            |

**"Verified"** means the server has been launched by that client and exercised through real tool calls and resource fetches.

**"Config docs"** means we provide a copy-pasteable JSON snippet in the README and have no reason to believe it doesn't work, but haven't sat in front of it ourselves. If you use that client and confirm it works (or doesn't), open an issue or PR to update this table.

## Known quirks

### Windows `npx` resolution

Some clients launch the server via:

```json
{ "command": "npx", "args": ["-y", "github:xultrax-web/agent-memory-mcp"] }
```

On Windows, depending on how the host process inherits PATH, `npx` may not resolve directly. The fix is to wrap with the cmd shell:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "github:xultrax-web/agent-memory-mcp"] }
```

Applies primarily to Claude Desktop on Windows.

### Working directory and `.agent-memory/` location

Per-project storage (the default) puts `.agent-memory/` in whatever directory the MCP client launches the server from. For most editors that's the project root, but some clients launch from the user's home directory.

If memories aren't landing where you expect:

- Confirm via `agent-memory://index` resource (the storage location is reported)
- Set `AGENT_MEMORY_DIR` to an absolute path in the client's env config
- Or set `AGENT_MEMORY_SCOPE=global` for a single shared store at `~/.agent-memory/`

### Resources support varies by client

`agent-memory://index` and `agent-memory://memory/{name}` are exposed as MCP resources. Some clients let you pin resources as always-visible context (Claude Desktop, Cursor); others currently treat resources as fetch-only (Cline, Continue). Tool calls work in every client either way.

## Reporting issues

Open at https://github.com/xultrax-web/agent-memory-mcp/issues with:

1. Client name + version
2. OS
3. The exact MCP config snippet you used
4. Output from `agent-memory doctor` if relevant
5. Any error from the client's MCP log
