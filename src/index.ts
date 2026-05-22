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
 * The five tools (save_memory, search_memories, get_memory,
 * list_memories, delete_memory) are intentionally minimal. The whole
 * point is that the storage is plain markdown — users can grep, edit,
 * commit, and inspect it without going through the server.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;

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
      `Invalid name "${name}". Use lowercase kebab-case (a-z, 0-9, hyphen), 1-80 chars, must start with letter or digit.`,
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
  const query = String(args.query ?? "").trim().toLowerCase();
  if (!query) throw new Error("query is required");

  const names = listMemoryFiles();
  const memories = names
    .map((n) => readMemory(n))
    .filter((m): m is Memory => m !== null);

  // Naive ranking: name match > description match > body match.
  // Score: name=10, description=5, body=1 per occurrence.
  const scored = memories
    .map((m) => {
      const nameHits = (m.name.toLowerCase().match(new RegExp(escapeRegex(query), "g")) || []).length;
      const descHits = (m.description.toLowerCase().match(new RegExp(escapeRegex(query), "g")) || []).length;
      const bodyHits = (m.body.toLowerCase().match(new RegExp(escapeRegex(query), "g")) || []).length;
      const score = nameHits * 10 + descHits * 5 + bodyHits;
      return { mem: m, score, bodyHits };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (scored.length === 0) return `No memories matched "${query}".`;

  const lines = [`Found ${scored.length} match${scored.length === 1 ? "" : "es"} for "${query}":`, ""];
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
          name: { type: "string", description: "Short kebab-case slug, 1-80 chars (e.g. 'user-prefers-tabs')" },
          description: { type: "string", description: "One-line summary, shown in the index and ranked highly in search" },
          type: {
            type: "string",
            enum: ["user", "feedback", "project", "reference"],
            description: "Memory type: user (about the person), feedback (rules to follow), project (state/context), reference (external pointers)",
          },
          content: { type: "string", description: "Markdown body. For feedback/project, include **Why:** and **How to apply:** lines." },
        },
        required: ["name", "description", "type", "content"],
      },
    },
    {
      name: "search_memories",
      description: "Substring search across all memories (name + description + body). Returns top 10 by relevance.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for. Case-insensitive substring match." },
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
// Boot
// -------------------------------------------------------------

async function main(): Promise<void> {
  ensureStorage();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't interfere with stdio transport
  process.stderr.write(`agent-memory-mcp · storage: ${MEMORY_DIR}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
