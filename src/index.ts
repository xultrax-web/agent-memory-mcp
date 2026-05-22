#!/usr/bin/env node
/**
 * agent-memory-mcp
 *
 * File-based persistent memory for any MCP client. Markdown files with
 * YAML frontmatter, indexed by a simple MEMORY.md file. Inspired by
 * Claude Code's built-in memory pattern, made available to Cursor,
 * Cline, Continue, and any other MCP-compatible tool.
 *
 * Storage resolution (first match wins):
 *   1. AGENT_MEMORY_DIR env var (absolute path)
 *   2. AGENT_MEMORY_SCOPE=global  → ~/.agent-memory/
 *   3. default                    → ./.agent-memory/  (per-project)
 *
 * Three usage modes share the same binary:
 *   1. MCP server (stdio)    · default when invoked with no args
 *   2. CLI                   · agent-memory <save|search|get|list|delete>
 *   3. Bulk import           · agent-memory import-claude-code
 *
 * The tools are intentionally minimal. The whole point is that the
 * storage is plain markdown — users can grep, edit, commit, and
 * inspect it without going through the server.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import matter from "gray-matter";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// -------------------------------------------------------------
// Storage location resolution
// -------------------------------------------------------------

function resolveStorageDir(): string {
  const explicit = process.env.AGENT_MEMORY_DIR;
  if (explicit) return resolve(explicit);
  if (process.env.AGENT_MEMORY_SCOPE === "global") {
    return join(homedir(), ".agent-memory");
  }
  return resolve(process.cwd(), ".agent-memory");
}

const MEMORY_DIR = resolveStorageDir();
const INDEX_FILE = join(MEMORY_DIR, "MEMORY.md");

function ensureStorage(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) {
    writeFileSync(
      INDEX_FILE,
      "# Memory Index\n\n_Auto-managed by agent-memory-mcp. Hand-edits to entries are preserved._\n\n",
      "utf8",
    );
  }
}

// -------------------------------------------------------------
// Types & validation
// -------------------------------------------------------------

const VALID_TYPES = new Set(["user", "feedback", "project", "reference"]);
// Slug rules: lowercase a-z + digits + hyphen + underscore, start with
// a letter or digit, 1-80 chars. Underscores are allowed because Claude
// Code's memory tree uses them; we want frictionless import.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;

interface MemoryFrontmatter {
  name: string;
  description: string;
  type: string;
}

interface Memory {
  name: string;
  description: string;
  type: string;
  body: string;
  filePath: string;
}

function memoryFilePath(name: string): string {
  return join(MEMORY_DIR, `${name}.md`);
}

function readMemory(name: string): Memory | null {
  const fp = memoryFilePath(name);
  if (!existsSync(fp)) return null;
  const raw = readFileSync(fp, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as Partial<MemoryFrontmatter>;
  return {
    name: fm.name ?? name,
    description: fm.description ?? "",
    type: fm.type ?? "project",
    body: parsed.content.trim(),
    filePath: fp,
  };
}

function listMemoryFiles(): string[] {
  if (!existsSync(MEMORY_DIR)) return [];
  return readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .map((f) => f.replace(/\.md$/, ""));
}

// -------------------------------------------------------------
// Index management
// -------------------------------------------------------------

const INDEX_ENTRY_PATTERN = /^- \[([^\]]+)\]\(([^)]+)\) — (.+)$/;

function readIndex(): Map<string, string> {
  if (!existsSync(INDEX_FILE)) return new Map();
  const lines = readFileSync(INDEX_FILE, "utf8").split(/\r?\n/);
  const entries = new Map<string, string>();
  for (const line of lines) {
    const m = INDEX_ENTRY_PATTERN.exec(line.trim());
    if (m) entries.set(m[1], line.trim());
  }
  return entries;
}

function writeIndex(entries: Map<string, string>): void {
  const header =
    "# Memory Index\n\n_Auto-managed by agent-memory-mcp. Hand-edits to entries are preserved._\n\n";
  const sorted = Array.from(entries.values()).sort();
  writeFileSync(INDEX_FILE, header + sorted.join("\n") + "\n", "utf8");
}

function upsertIndexEntry(name: string, description: string): void {
  const entries = readIndex();
  entries.set(name, `- [${name}](${name}.md) — ${description}`);
  writeIndex(entries);
}

function removeIndexEntry(name: string): void {
  const entries = readIndex();
  entries.delete(name);
  writeIndex(entries);
}

// -------------------------------------------------------------
// Tool handlers
// -------------------------------------------------------------

function toolSaveMemory(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  const description = String(args.description ?? "").trim();
  const type = String(args.type ?? "project").trim();
  const content = String(args.content ?? "").trim();

  if (!SLUG_PATTERN.test(name)) {
    throw new Error(
      `Invalid name "${name}". Use lowercase (a-z, 0-9, hyphen, underscore), 1-80 chars, must start with letter or digit.`,
    );
  }
  if (!VALID_TYPES.has(type)) {
    throw new Error(
      `Invalid type "${type}". Must be one of: ${Array.from(VALID_TYPES).join(", ")}.`,
    );
  }
  if (!description) throw new Error("description is required");
  if (!content) throw new Error("content is required");

  ensureStorage();

  const frontmatter = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ntype: ${type}\n---\n\n`;
  const fp = memoryFilePath(name);
  const isUpdate = existsSync(fp);
  writeFileSync(fp, frontmatter + content + "\n", "utf8");
  upsertIndexEntry(name, description);

  return `${isUpdate ? "Updated" : "Saved"} memory "${name}" (${type}) at ${fp}`;
}

function toolGetMemory(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  const mem = readMemory(name);
  if (!mem) return `Memory "${name}" not found.`;
  return [
    `# ${mem.name}`,
    `type: ${mem.type}`,
    `description: ${mem.description}`,
    "",
    mem.body,
  ].join("\n");
}

function toolListMemories(args: Record<string, unknown>): string {
  const typeFilter = args.type ? String(args.type) : null;
  const names = listMemoryFiles();
  const memories = names
    .map((n) => readMemory(n))
    .filter((m): m is Memory => m !== null)
    .filter((m) => !typeFilter || m.type === typeFilter)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (memories.length === 0) {
    return typeFilter
      ? `No memories of type "${typeFilter}".`
      : "No memories yet. Use save_memory to create one.";
  }

  const lines = [`Found ${memories.length} memor${memories.length === 1 ? "y" : "ies"}:`, ""];
  for (const m of memories) {
    lines.push(`  ${m.name}  [${m.type}]`);
    lines.push(`    ${m.description}`);
  }
  return lines.join("\n");
}

function toolSearchMemories(args: Record<string, unknown>): string {
  const query = String(args.query ?? "")
    .trim()
    .toLowerCase();
  if (!query) throw new Error("query is required");

  const names = listMemoryFiles();
  const memories = names.map((n) => readMemory(n)).filter((m): m is Memory => m !== null);

  // Naive ranking: name match > description match > body match.
  // Score: name=10, description=5, body=1 per occurrence.
  const scored = memories
    .map((m) => {
      const nameHits = (m.name.toLowerCase().match(new RegExp(escapeRegex(query), "g")) || [])
        .length;
      const descHits = (
        m.description.toLowerCase().match(new RegExp(escapeRegex(query), "g")) || []
      ).length;
      const bodyHits = (m.body.toLowerCase().match(new RegExp(escapeRegex(query), "g")) || [])
        .length;
      const score = nameHits * 10 + descHits * 5 + bodyHits;
      return { mem: m, score, bodyHits };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (scored.length === 0) return `No memories matched "${query}".`;

  const lines = [
    `Found ${scored.length} match${scored.length === 1 ? "" : "es"} for "${query}":`,
    "",
  ];
  for (const r of scored) {
    lines.push(`  ${r.mem.name}  [${r.mem.type}]  (score ${r.score})`);
    lines.push(`    ${r.mem.description}`);
    if (r.bodyHits > 0) {
      const snippet = extractSnippet(r.mem.body, query);
      if (snippet) lines.push(`    ... ${snippet}`);
    }
  }
  return lines.join("\n");
}

function toolDeleteMemory(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  const fp = memoryFilePath(name);
  if (!existsSync(fp)) return `Memory "${name}" not found.`;
  unlinkSync(fp);
  removeIndexEntry(name);
  return `Deleted memory "${name}".`;
}

function extractSnippet(body: string, query: string): string | null {
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + query.length + 40);
  return body.slice(start, end).replace(/\s+/g, " ").trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -------------------------------------------------------------
// Server wiring
// -------------------------------------------------------------

const server = new Server(
  { name: "agent-memory", version: "0.2.0" },
  { capabilities: { tools: {}, resources: {} } },
);

// -------------------------------------------------------------
// Resource URI scheme
// -------------------------------------------------------------
//
//   agent-memory://index              → the MEMORY.md index
//   agent-memory://memory/{name}      → an individual memory file
//
// Clients (Cursor, Claude Desktop, etc.) can pin the index as
// always-visible context. Per-memory URIs are exposed so a client
// can pin specific memories the user marks as "always relevant"
// (e.g. their user profile memory, the project's prime directive).

const URI_INDEX = "agent-memory://index";
const URI_MEMORY_PREFIX = "agent-memory://memory/";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  ensureStorage();
  const memories = listMemoryFiles()
    .map((n) => readMemory(n))
    .filter((m): m is Memory => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    resources: [
      {
        uri: URI_INDEX,
        name: "Memory index",
        description:
          "Auto-managed index of every stored memory. Pin this as always-visible context so the assistant sees what's known before deciding what to look up.",
        mimeType: "text/markdown",
      },
      ...memories.map((m) => ({
        uri: `${URI_MEMORY_PREFIX}${m.name}`,
        name: m.name,
        description: `[${m.type}] ${m.description}`,
        mimeType: "text/markdown",
      })),
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  ensureStorage();

  if (uri === URI_INDEX) {
    const text = readFileSync(INDEX_FILE, "utf8");
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  }

  if (uri.startsWith(URI_MEMORY_PREFIX)) {
    const name = uri.slice(URI_MEMORY_PREFIX.length);
    // Defense in depth: strict slug validation prevents path traversal
    // even though the URI parser should already reject "../" segments.
    if (!SLUG_PATTERN.test(name)) {
      throw new Error(`Invalid memory name in URI: "${name}"`);
    }
    const fp = memoryFilePath(name);
    if (!existsSync(fp)) {
      throw new Error(`Resource not found: ${uri}`);
    }
    const text = readFileSync(fp, "utf8");
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  }

  throw new Error(
    `Unknown resource URI: ${uri}. Supported: ${URI_INDEX}, ${URI_MEMORY_PREFIX}{name}`,
  );
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "save_memory",
      description:
        "Save (or update) a memory. Memories are markdown files with YAML frontmatter, " +
        "stored at the resolved memory dir. Use a short kebab-case name; the description " +
        "is what's shown in the index and used for search ranking.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short kebab-case slug, 1-80 chars (e.g. 'user-prefers-tabs')",
          },
          description: {
            type: "string",
            description: "One-line summary, shown in the index and ranked highly in search",
          },
          type: {
            type: "string",
            enum: ["user", "feedback", "project", "reference"],
            description:
              "Memory type: user (about the person), feedback (rules to follow), project (state/context), reference (external pointers)",
          },
          content: {
            type: "string",
            description:
              "Markdown body. For feedback/project, include **Why:** and **How to apply:** lines.",
          },
        },
        required: ["name", "description", "type", "content"],
      },
    },
    {
      name: "search_memories",
      description:
        "Substring search across all memories (name + description + body). Returns top 10 by relevance.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look for. Case-insensitive substring match.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_memory",
      description: "Fetch a single memory by name.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The memory's name slug" },
        },
        required: ["name"],
      },
    },
    {
      name: "list_memories",
      description: "List all stored memories, optionally filtered by type.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["user", "feedback", "project", "reference"],
            description: "Optional filter — only list memories of this type",
          },
        },
      },
    },
    {
      name: "delete_memory",
      description: "Remove a memory permanently (deletes the file and index entry).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The memory's name slug" },
        },
        required: ["name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result: string;
    switch (name) {
      case "save_memory":
        result = toolSaveMemory(args);
        break;
      case "search_memories":
        result = toolSearchMemories(args);
        break;
      case "get_memory":
        result = toolGetMemory(args);
        break;
      case "list_memories":
        result = toolListMemories(args);
        break;
      case "delete_memory":
        result = toolDeleteMemory(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// -------------------------------------------------------------
// CLI mode
// -------------------------------------------------------------
//
// When invoked with no arguments, the entry point starts the MCP
// stdio server (as MCP clients expect). When invoked with a known
// subcommand as argv[2], it runs CLI mode and exits — making the
// same binary usable from shell scripts, cron, git hooks, etc.

const CLI_COMMANDS = new Set([
  "save",
  "search",
  "get",
  "list",
  "delete",
  "import-claude-code",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

function parseFlags(argv: string[]): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = argv[i + 1];
        i++;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

async function cliMain(command: string, rest: string[]): Promise<number> {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write("agent-memory-mcp 0.2.0\n");
    return 0;
  }

  ensureStorage();
  const { flags, positional } = parseFlags(rest);

  try {
    switch (command) {
      case "save": {
        const name = positional[0];
        if (!name)
          throw new Error(
            "Usage: agent-memory save <name> --type <t> --description <d> [--content <c> | --content-file <path> | --stdin]",
          );
        let content = String(flags.content ?? "");
        if (flags["content-file"]) {
          content = readFileSync(String(flags["content-file"]), "utf8");
        } else if (flags.stdin) {
          content = await readStdin();
        }
        const result = toolSaveMemory({
          name,
          type: String(flags.type ?? "project"),
          description: String(flags.description ?? ""),
          content,
        });
        process.stdout.write(result + "\n");
        return 0;
      }
      case "search": {
        const query = positional[0];
        if (!query) throw new Error("Usage: agent-memory search <query>");
        process.stdout.write(toolSearchMemories({ query }) + "\n");
        return 0;
      }
      case "get": {
        const name = positional[0];
        if (!name) throw new Error("Usage: agent-memory get <name>");
        process.stdout.write(toolGetMemory({ name }) + "\n");
        return 0;
      }
      case "list": {
        process.stdout.write(toolListMemories({ type: flags.type }) + "\n");
        return 0;
      }
      case "delete": {
        const name = positional[0];
        if (!name) throw new Error("Usage: agent-memory delete <name>");
        process.stdout.write(toolDeleteMemory({ name }) + "\n");
        return 0;
      }
      case "import-claude-code": {
        return importClaudeCode({
          source: flags.source ? String(flags.source) : undefined,
          project: flags.project ? String(flags.project) : undefined,
          overwrite: Boolean(flags.overwrite),
          dryRun: Boolean(flags["dry-run"]),
        });
      }
      default:
        throw new Error(`Unknown command: ${command}. Try 'agent-memory help'.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

function printHelp(): void {
  process.stdout.write(
    `agent-memory-mcp · markdown memory for AI agents

USAGE
  agent-memory <command> [args]            CLI mode
  agent-memory-mcp                         MCP server mode (default when no args)

COMMANDS
  save <name> --type <t> --description <d> --content <c>
                                           Save or update a memory.
                                           Type: user | feedback | project | reference
                                           Content sources: --content "..." | --content-file <path> | --stdin
  search <query>                           Substring search (top 10 by relevance)
  get <name>                               Print one memory's full contents
  list [--type <t>]                        List all memories (optionally by type)
  delete <name>                            Remove a memory permanently
  import-claude-code [--source <path>] [--project <pat>] [--overwrite] [--dry-run]
                                           Walk ~/.claude/projects/*/memory/ and
                                           import each memory into the current store.
                                           --project filters by substring match.
  help                                     Show this help
  --version                                Print version

STORAGE
  Memories live in ./.agent-memory/ (per-project, default).
  Set AGENT_MEMORY_SCOPE=global for ~/.agent-memory/.
  Set AGENT_MEMORY_DIR=/path for any custom location.

CURRENT STORE
  ${MEMORY_DIR}

DOCS
  https://github.com/xultrax-web/agent-memory-mcp
`,
  );
}

// -------------------------------------------------------------
// Claude Code import
// -------------------------------------------------------------
//
// Walks ~/.claude/projects/*/memory/, reads each memory file's
// frontmatter (which uses metadata.type, not top-level type),
// flattens the type, and saves through the same tool path the
// MCP server uses.

interface ImportOptions {
  source?: string;
  project?: string;
  overwrite?: boolean;
  dryRun?: boolean;
}

function importClaudeCode(opts: ImportOptions): number {
  const source = opts.source ?? join(homedir(), ".claude", "projects");
  if (!existsSync(source)) {
    process.stderr.write(`error: Claude Code projects dir not found: ${source}\n`);
    return 1;
  }

  const projectDirs = readdirSync(source).filter((d) => {
    const memDir = join(source, d, "memory");
    return existsSync(memDir);
  });

  if (projectDirs.length === 0) {
    process.stderr.write(`no Claude Code projects with memory found at ${source}\n`);
    return 1;
  }

  const filtered = opts.project
    ? projectDirs.filter((d) => d.toLowerCase().includes(opts.project!.toLowerCase()))
    : projectDirs;

  if (filtered.length === 0) {
    process.stderr.write(
      `no projects matched filter "${opts.project}". Available: ${projectDirs.join(", ")}\n`,
    );
    return 1;
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const projectDir of filtered) {
    const memDir = join(source, projectDir, "memory");
    process.stdout.write(`\n[${projectDir}]\n`);

    const files = readdirSync(memDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    for (const file of files) {
      const fp = join(memDir, file);
      const raw = readFileSync(fp, "utf8");

      // Tolerate malformed frontmatter — fall back to filename + raw content.
      let parsedData: Record<string, unknown> = {};
      let parsedContent = raw;
      try {
        const parsed = matter(raw);
        parsedData = parsed.data as Record<string, unknown>;
        parsedContent = parsed.content;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          `  warn  ${file} · frontmatter parse failed (${msg.split("\n")[0]}); importing as-is\n`,
        );
      }

      // The slug comes from the filename — Claude Code's `name` field is
      // a human-readable title, not a slug. We lowercase to enforce our
      // case rule. Special chars rejected downstream by SLUG_PATTERN.
      const name = file.replace(/\.md$/, "").toLowerCase();
      const metadata = (parsedData.metadata as Record<string, unknown> | undefined) ?? {};
      const type = String(parsedData.type ?? metadata.type ?? "project");
      const description = String(
        parsedData.description ?? parsedData.name ?? "(imported from Claude Code)",
      );
      const content = parsedContent.trim();

      if (!SLUG_PATTERN.test(name)) {
        process.stdout.write(`  skip  ${file} · slug "${name}" has unsupported characters\n`);
        skipped++;
        continue;
      }
      if (!VALID_TYPES.has(type)) {
        process.stdout.write(`  skip  ${name} · invalid type "${type}"\n`);
        skipped++;
        continue;
      }
      if (!opts.overwrite && existsSync(memoryFilePath(name))) {
        process.stdout.write(`  skip  ${name} · already exists (use --overwrite to replace)\n`);
        skipped++;
        continue;
      }

      if (opts.dryRun) {
        process.stdout.write(`  would import  ${name} [${type}]\n`);
        imported++;
        continue;
      }

      try {
        toolSaveMemory({ name, type, description, content });
        process.stdout.write(`  imported  ${name} [${type}]\n`);
        imported++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`  error  ${name} · ${msg}\n`);
        errors++;
      }
    }
  }

  process.stdout.write(
    `\n${opts.dryRun ? "dry run" : "import"} complete · imported=${imported} skipped=${skipped} errors=${errors}\n`,
  );
  if (opts.dryRun) {
    process.stdout.write(`(re-run without --dry-run to actually save)\n`);
  }
  return errors > 0 ? 1 : 0;
}

// -------------------------------------------------------------
// Boot · dispatch CLI vs MCP server based on argv
// -------------------------------------------------------------

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command && CLI_COMMANDS.has(command)) {
    const exitCode = await cliMain(command, process.argv.slice(3));
    process.exit(exitCode);
  }

  ensureStorage();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`agent-memory-mcp · storage: ${MEMORY_DIR}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
