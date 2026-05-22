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
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Fuse from "fuse.js";
import matter from "gray-matter";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";

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

export const MEMORY_DIR = resolveStorageDir();
const INDEX_FILE = join(MEMORY_DIR, "MEMORY.md");
const TRASH_DIR = join(MEMORY_DIR, ".trash");
const LOCK_FILE = join(MEMORY_DIR, ".lock");
const EVENT_LOG = join(MEMORY_DIR, ".events.jsonl");
const SCHEMA_VERSION = 1;

// -------------------------------------------------------------
// Structured logging · all output to stderr (stdio is reserved
// for MCP JSON-RPC frames in server mode)
// -------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LOG_LEVEL: LogLevel =
  (process.env.AGENT_MEMORY_LOG?.toLowerCase() as LogLevel) ?? "info";

function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[CURRENT_LOG_LEVEL]) return;
  const ts = new Date().toISOString();
  const fieldStr = fields ? " " + JSON.stringify(fields) : "";
  process.stderr.write(`${ts} [${level}] ${message}${fieldStr}\n`);
}

// -------------------------------------------------------------
// Color · ANSI for TTY, respects NO_COLOR / FORCE_COLOR
// -------------------------------------------------------------

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
} as const;

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stderr.isTTY);
}

function c(code: string, text: string): string {
  return useColor() ? `${code}${text}${ANSI.reset}` : text;
}

// -------------------------------------------------------------
// Event log · append-only JSONL audit trail
// -------------------------------------------------------------
//
// Every mutation appends one line. Reads are not logged (would
// dominate the log on hot indexes and adds little forensic value).
// Format is one JSON object per line: { ts, action, ...fields }
//
// `agent-memory log` paginates the file for human consumption.

interface EventRecord {
  ts: string;
  action: string;
  [key: string]: unknown;
}

function logEvent(action: string, fields: Record<string, unknown>): void {
  try {
    ensureStorage();
    const record: EventRecord = { ts: new Date().toISOString(), action, ...fields };
    // Append is safe across processes on POSIX + Windows for small lines
    // (writev guarantees atomicity below pipe buffer size). For larger
    // future events we could move to the lock-wrapped pattern.
    writeFileSync(EVENT_LOG, JSON.stringify(record) + "\n", { flag: "a", encoding: "utf8" });
  } catch (err) {
    // Never let event-log failure break the main operation
    log("warn", "event log write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function readEventLog(opts: { tail?: number; action?: string }): EventRecord[] {
  if (!existsSync(EVENT_LOG)) return [];
  const lines = readFileSync(EVENT_LOG, "utf8").split(/\r?\n/).filter(Boolean);
  let records: EventRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as EventRecord);
    } catch {
      // Skip malformed lines silently — log file may have been
      // hand-edited or truncated mid-write
    }
  }
  if (opts.action) records = records.filter((r) => r.action === opts.action);
  if (opts.tail) records = records.slice(-opts.tail);
  return records;
}

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

function ensureTrash(): void {
  if (!existsSync(TRASH_DIR)) mkdirSync(TRASH_DIR, { recursive: true });
}

function ensureLockTarget(): void {
  ensureStorage();
  // proper-lockfile needs the target file to exist before locking
  if (!existsSync(LOCK_FILE)) writeFileSync(LOCK_FILE, "", "utf8");
}

// -------------------------------------------------------------
// Reliability primitives
// -------------------------------------------------------------
//
// Every mutation goes through these two helpers:
//   atomicWriteFile · tmp-file + rename, so power-loss never leaves
//                     a half-written file on disk
//   withLock        · proper-lockfile around any write transaction,
//                     so MCP server + concurrent CLI invocations
//                     don't corrupt the index

function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, filePath);
}

function withLock<T>(fn: () => T): T {
  ensureLockTarget();
  // proper-lockfile's sync API doesn't support retries — a collision
  // throws immediately. For a single-process MCP server + occasional
  // CLI invocations that's fine; the rare contention case surfaces
  // as a clear error instead of silently corrupting data. The stale
  // timeout means a crashed process's lock gets auto-cleaned.
  const release = lockfile.lockSync(LOCK_FILE, { stale: 10_000 });
  try {
    return fn();
  } finally {
    release();
  }
}

// -------------------------------------------------------------
// Types & validation
// -------------------------------------------------------------

const VALID_TYPES = new Set(["user", "feedback", "project", "reference", "rule"]);
const VALID_RULE_SEVERITIES = new Set(["hard", "soft"]);
// Slug rules: lowercase a-z + digits + hyphen + underscore, start with
// a letter or digit, 1-80 chars. Underscores are allowed because Claude
// Code's memory tree uses them; we want frictionless import.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;

interface MemoryFrontmatter {
  name: string;
  description: string;
  type: string;
  tags?: string[];
  // type=rule extensions · all optional, ignored on other types
  severity?: "hard" | "soft";
  scope?: string[]; // ["global"] | ["project:<name>", ...] | ["tool:<name>", ...]
  applies_when?: string[]; // natural-language judgments for LLM enrichment
  matches?: string[]; // regex patterns for deterministic match
  enforce_on?: string[]; // action types this rule constrains
  last_verified?: string; // YYYY-MM-DD
}

export interface Memory {
  name: string;
  description: string;
  type: string;
  tags: string[];
  body: string;
  filePath: string;
  // type=rule fields surfaced (undefined for non-rule types)
  severity?: "hard" | "soft";
  scope?: string[];
  applies_when?: string[];
  matches?: string[];
  enforce_on?: string[];
  last_verified?: string;
}

// Tags: lowercase, digits, hyphen/underscore. Max 40 chars per tag.
// Same alphabet as slugs but shorter — meant for "container-industry",
// "weekly", "deprecated", etc.
const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// Wiki-links: [[memory-name]] · names follow SLUG_PATTERN rules
const WIKI_LINK_PATTERN = /\[\[([a-z0-9][a-z0-9_-]{0,80})\]\]/g;

export function memoryFilePath(name: string): string {
  return join(MEMORY_DIR, `${name}.md`);
}

function parseStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length > 0 ? out : undefined;
}

export function readMemory(name: string): Memory | null {
  const fp = memoryFilePath(name);
  if (!existsSync(fp)) return null;
  const raw = readFileSync(fp, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as Partial<MemoryFrontmatter>;
  const severity = fm.severity === "hard" || fm.severity === "soft" ? fm.severity : undefined;
  return {
    name: fm.name ?? name,
    description: fm.description ?? "",
    type: fm.type ?? "project",
    tags: Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === "string") : [],
    body: parsed.content.trim(),
    filePath: fp,
    severity,
    scope: parseStringArray(fm.scope),
    applies_when: parseStringArray(fm.applies_when),
    matches: parseStringArray(fm.matches),
    enforce_on: parseStringArray(fm.enforce_on),
    last_verified:
      typeof fm.last_verified === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fm.last_verified)
        ? fm.last_verified
        : undefined,
  };
}

export function listMemoryFiles(): string[] {
  if (!existsSync(MEMORY_DIR)) return [];
  return readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .map((f) => f.replace(/\.md$/, ""));
}

// Tags can arrive as a string array (MCP/CLI args) or a comma-separated
// string (CLI flag). Normalize to a deduped lowercase string[] preserving
// order of first appearance.
function normalizeTags(input: unknown): string[] {
  if (!input) return [];
  let raw: string[];
  if (Array.isArray(input)) {
    raw = input.map((t) => String(t).trim()).filter((t) => t.length > 0);
  } else if (typeof input === "string") {
    raw = input
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}

// Extract [[wiki-link]] targets from a memory body. Returns the set of
// referenced memory names (deduped, lowercase). Self-references stripped.
function extractWikiLinks(body: string, selfName: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  // RegExp with /g flag needs reset of lastIndex per call
  WIKI_LINK_PATTERN.lastIndex = 0;
  while ((m = WIKI_LINK_PATTERN.exec(body)) !== null) {
    const target = m[1].toLowerCase();
    if (target !== selfName) found.add(target);
  }
  return Array.from(found);
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
  atomicWriteFile(INDEX_FILE, header + sorted.join("\n") + "\n");
}

// Unlocked variants · safe to call only from inside a withLock block.

function upsertIndexEntryUnlocked(name: string, description: string): void {
  const entries = readIndex();
  entries.set(name, `- [${name}](${name}.md) — ${description}`);
  writeIndex(entries);
}

function removeIndexEntryUnlocked(name: string): void {
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
  const tags = normalizeTags(args.tags);

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
  for (const tag of tags) {
    if (!TAG_PATTERN.test(tag)) {
      throw new Error(
        `Invalid tag "${tag}". Tags use lowercase (a-z, 0-9, hyphen, underscore), 1-40 chars.`,
      );
    }
  }
  if (!description) throw new Error("description is required");
  if (!content) throw new Error("content is required");

  ensureStorage();

  const tagsLine =
    tags.length > 0 ? `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]\n` : "";
  const frontmatter =
    `---\n` +
    `name: ${name}\n` +
    `description: ${JSON.stringify(description)}\n` +
    `type: ${type}\n` +
    tagsLine +
    `schema: ${SCHEMA_VERSION}\n` +
    `---\n\n`;
  const fp = memoryFilePath(name);
  const isUpdate = existsSync(fp);

  // Conflict detection · only when creating a NEW memory (updates are
  // intentional re-saves and don't need a similarity warning). Fuzzy
  // match against existing names + descriptions; if anything scores
  // above the conflict threshold, warn but don't block — the LLM can
  // decide whether to merge, rename, or proceed.
  let conflictWarning = "";
  if (!isUpdate) {
    const conflicts = detectConflicts({ name, description, type });
    if (conflicts.length > 0) {
      const list = conflicts
        .map((c) => `  - ${c.name} [${c.type}] (${c.similarity}% similar)`)
        .join("\n");
      conflictWarning =
        `\n\nWARNING · potentially similar existing memory(ies):\n${list}\n` +
        `Consider merging or renaming. To proceed anyway, the save has already been completed.`;
    }
  }

  return withLock(() => {
    atomicWriteFile(fp, frontmatter + content + "\n");
    upsertIndexEntryUnlocked(name, description);
    logEvent("save", {
      name,
      type,
      update: isUpdate,
      bytes: content.length,
      conflicts: conflictWarning ? "warned" : undefined,
    });
    log("debug", "save_memory", { name, type, update: isUpdate });
    if (type === "rule") maybeAutoEmitCompanions();
    return `${isUpdate ? "Updated" : "Saved"} memory "${name}" (${type}) at ${fp}${conflictWarning}`;
  });
}

interface ConflictMatch {
  name: string;
  type: string;
  similarity: number;
}

function detectConflicts(candidate: {
  name: string;
  description: string;
  type: string;
}): ConflictMatch[] {
  const names = listMemoryFiles();
  // Skip the candidate name itself (will be an update, not a conflict)
  const others = names.filter((n) => n !== candidate.name);
  if (others.length === 0) return [];

  const existing = others.map((n) => readMemory(n)).filter((m): m is Memory => m !== null);
  if (existing.length === 0) return [];

  // Two separate searches catch different conflict shapes:
  //   - Name-based: matches when the new slug is very close to an
  //     existing slug (e.g. "deploy-process" vs "deployment-strategy")
  //   - Description-based: matches when descriptions are paraphrases
  //     of each other regardless of name
  // We merge results + dedupe. Threshold 0.5 here is intentionally
  // looser than search (0.4) because we'd rather warn on a few false
  // positives than miss an obvious duplicate.
  // Threshold 0.6 catches paraphrases like "deployment-strategy" vs
  // "deploy-process" (Fuse Bitap scores those around 0.5). The 45%
  // similarity floor below then trims out the long tail.
  const nameFuse = new Fuse(existing, {
    includeScore: true,
    threshold: 0.6,
    ignoreLocation: true,
    minMatchCharLength: 3,
    keys: ["name"],
  });
  const descFuse = new Fuse(existing, {
    includeScore: true,
    threshold: 0.6,
    ignoreLocation: true,
    minMatchCharLength: 3,
    keys: ["description"],
  });

  const merged = new Map<string, ConflictMatch>();
  const addHit = (name: string, type: string, score: number) => {
    const existingHit = merged.get(name);
    const similarity = Math.round((1 - score) * 100);
    if (!existingHit || similarity > existingHit.similarity) {
      merged.set(name, { name, type, similarity });
    }
  };

  for (const r of nameFuse.search(candidate.name, { limit: 3 })) {
    addHit(r.item.name, r.item.type, r.score ?? 1);
  }
  for (const r of descFuse.search(candidate.description, { limit: 3 })) {
    addHit(r.item.name, r.item.type, r.score ?? 1);
  }

  return Array.from(merged.values())
    .filter((h) => h.similarity >= 45) // 45%+ similarity = worth surfacing
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);
}

function toolGetMemory(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  const mem = readMemory(name);
  if (!mem) return `Memory "${name}" not found.`;
  const tagsLine = mem.tags.length > 0 ? `tags        : ${mem.tags.join(", ")}` : "";
  return [
    `# ${mem.name}`,
    `type        : ${mem.type}`,
    tagsLine,
    `description : ${mem.description}`,
    "",
    mem.body,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function toolListMemories(args: Record<string, unknown>): string {
  const typeFilter = args.type ? String(args.type) : null;
  const tagFilter = normalizeTags(args.tags);
  const offset = args.offset ? Math.max(0, Number(args.offset)) : 0;
  const limit = args.limit ? Math.max(1, Number(args.limit)) : 50;

  const names = listMemoryFiles();
  const all = names
    .map((n) => readMemory(n))
    .filter((m): m is Memory => m !== null)
    .filter((m) => !typeFilter || m.type === typeFilter)
    .filter((m) => tagFilter.length === 0 || tagFilter.every((t) => m.tags.includes(t)))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (all.length === 0) {
    const parts: string[] = [];
    if (typeFilter) parts.push(`type "${typeFilter}"`);
    if (tagFilter.length > 0) parts.push(`tags [${tagFilter.join(", ")}]`);
    return parts.length > 0
      ? `No memories matching ${parts.join(" and ")}.`
      : "No memories yet. Use save_memory to create one.";
  }

  const page = all.slice(offset, offset + limit);
  const lines: string[] = [];
  const filterDesc = [
    typeFilter ? `type=${typeFilter}` : null,
    tagFilter.length > 0 ? `tags=[${tagFilter.join(",")}]` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const showing =
    offset === 0 && page.length === all.length
      ? `Found ${all.length} memor${all.length === 1 ? "y" : "ies"}${filterDesc ? ` (${filterDesc})` : ""}:`
      : `Showing ${offset + 1}-${offset + page.length} of ${all.length}${filterDesc ? ` (${filterDesc})` : ""}:`;
  lines.push(showing);
  lines.push("");
  for (const m of page) {
    const tagSuffix = m.tags.length > 0 ? `  ${c(ANSI.dim, `· ${m.tags.join(" · ")}`)}` : "";
    lines.push(`  ${m.name}  [${m.type}]${tagSuffix}`);
    lines.push(`    ${m.description}`);
  }
  if (offset + page.length < all.length) {
    const nextOffset = offset + page.length;
    lines.push("");
    lines.push(`  ... ${all.length - nextOffset} more. Use offset=${nextOffset} to continue.`);
  }
  return lines.join("\n");
}

// -------------------------------------------------------------
// Fuzzy search · Fuse.js with field weighting + snippets
// -------------------------------------------------------------
//
// Why Fuse over BM25 / Lunr: memory documents are small (1-10KB)
// and queries are short (3-5 words). Fuse gives typo tolerance,
// word-order tolerance, and partial-match support out of the box,
// with field weighting that approximates TF-IDF on this data size.
// BM25 would be over-engineering at this scale.
//
// Field weights (name×3 > description×2 > body×1) match the
// natural intuition: a hit in the slug or summary is more
// meaningful than a single hit in 5KB of prose.

function buildFuse(memories: Memory[]): Fuse<Memory> {
  return new Fuse(memories, {
    includeScore: true,
    includeMatches: true,
    threshold: 0.4, // 0=exact, 1=anything; 0.4 is forgiving without going noisy
    ignoreLocation: true,
    minMatchCharLength: 2,
    keys: [
      { name: "name", weight: 3 },
      { name: "description", weight: 2 },
      { name: "body", weight: 1 },
    ],
  });
}

type FuseResultMatch = NonNullable<ReturnType<Fuse<Memory>["search"]>[number]["matches"]>[number];

function extractFuseSnippet(memory: Memory, matches: readonly FuseResultMatch[]): string | null {
  // Prefer a body-field snippet so the operator sees context, not the
  // memory's own description (which is already in the summary line).
  const bodyMatch = matches.find((m) => m.key === "body");
  if (!bodyMatch || !bodyMatch.indices?.length) return null;
  const text = memory.body;
  const [start, end] = bodyMatch.indices[0];
  const ctxStart = Math.max(0, start - 40);
  const ctxEnd = Math.min(text.length, end + 1 + 40);
  let snippet = text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim();
  if (ctxStart > 0) snippet = "... " + snippet;
  if (ctxEnd < text.length) snippet = snippet + " ...";
  return snippet;
}

function toolSearchMemories(args: Record<string, unknown>): string {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const limit = args.limit ? Math.max(1, Number(args.limit)) : 10;

  const names = listMemoryFiles();
  const memories = names.map((n) => readMemory(n)).filter((m): m is Memory => m !== null);
  if (memories.length === 0) return "No memories to search.";

  const fuse = buildFuse(memories);
  const results = fuse.search(query, { limit });

  if (results.length === 0) {
    return `No memories matched "${query}". (Fuzzy threshold 0.4; try a shorter or simpler query.)`;
  }

  const lines: string[] = [];
  lines.push(`Found ${results.length} match${results.length === 1 ? "" : "es"} for "${query}":`);
  lines.push("");
  for (const r of results) {
    const m = r.item;
    // Fuse score: 0 = perfect, 1 = no match. Invert + scale for human display.
    const relevance = Math.round((1 - (r.score ?? 0)) * 100);
    lines.push(
      `  ${c(ANSI.bold, m.name)}  [${m.type}]  ${c(ANSI.dim, `· relevance ${relevance}%`)}`,
    );
    lines.push(`    ${m.description}`);
    const snippet = extractFuseSnippet(m, r.matches ?? []);
    if (snippet) lines.push(`    ${c(ANSI.dim, snippet)}`);
  }
  return lines.join("\n");
}

// -------------------------------------------------------------
// Relevant memories · for LLM consumption (full content)
// -------------------------------------------------------------
//
// Where search_memories returns human-readable matches with snippets,
// relevant_memories returns the FULL memory bodies. The intended
// caller is an LLM asking "what do I know about X?" so it can pull
// just-in-time context without a second round trip.
//
// Default max=5 keeps the context window cost bounded.

function toolRelevantMemories(args: Record<string, unknown>): string {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const max = args.max ? Math.max(1, Math.min(20, Number(args.max))) : 5;

  const names = listMemoryFiles();
  const memories = names.map((n) => readMemory(n)).filter((m): m is Memory => m !== null);
  if (memories.length === 0) return "No memories available.";

  const fuse = buildFuse(memories);
  const results = fuse.search(query, { limit: max });

  if (results.length === 0) {
    return `No memories relevant to "${query}".`;
  }

  // Emit each memory as a markdown section so the LLM can ingest
  // multiple memories in one shot without further parsing.
  const sections: string[] = [];
  sections.push(`# Memories relevant to "${query}"\n`);
  for (const r of results) {
    const m = r.item;
    const relevance = Math.round((1 - (r.score ?? 0)) * 100);
    sections.push(`## ${m.name} · [${m.type}] · relevance ${relevance}%`);
    sections.push(`> ${m.description}`);
    sections.push("");
    sections.push(m.body);
    sections.push("");
    sections.push("---");
  }
  return sections.join("\n");
}

export function toolDeleteMemory(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  if (!SLUG_PATTERN.test(name)) throw new Error(`Invalid name "${name}".`);
  const fp = memoryFilePath(name);
  if (!existsSync(fp)) return `Memory "${name}" not found.`;

  return withLock(() => {
    ensureTrash();
    // Trash filename: <unix-ms>-<name>.md so restore can pick the
    // most recent version and the operator can see when it was binned.
    const ts = Date.now();
    const trashPath = join(TRASH_DIR, `${ts}-${name}.md`);
    renameSync(fp, trashPath);
    removeIndexEntryUnlocked(name);
    logEvent("delete", { name, trash: `${ts}-${name}.md` });
    log("debug", "delete_memory", { name });
    return `Moved "${name}" to trash. Restore with: agent-memory restore ${name}`;
  });
}

function toolRestoreMemory(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  if (!SLUG_PATTERN.test(name)) throw new Error(`Invalid name "${name}".`);
  ensureTrash();

  // Most recent trash entry wins (timestamp prefix sorts lexically).
  const matches = readdirSync(TRASH_DIR)
    .filter((f) => f.endsWith(`-${name}.md`))
    .sort()
    .reverse();
  if (matches.length === 0) return `No trashed memory named "${name}" found.`;

  return withLock(() => {
    const trashPath = join(TRASH_DIR, matches[0]);
    const fp = memoryFilePath(name);
    if (existsSync(fp)) {
      throw new Error(
        `Cannot restore: "${name}" already exists in the active store. ` +
          `Delete it first (it'll get its own trash entry) then restore.`,
      );
    }
    renameSync(trashPath, fp);
    // Re-add to index using the restored file's frontmatter description.
    const mem = readMemory(name);
    if (mem) upsertIndexEntryUnlocked(name, mem.description);
    const binnedAt = new Date(Number(matches[0].split("-")[0])).toISOString();
    logEvent("restore", { name, binnedAt });
    log("debug", "restore_memory", { name });
    return `Restored "${name}" from trash (was binned ${binnedAt}).`;
  });
}

// -------------------------------------------------------------
// Doctor · integrity check + repair
// -------------------------------------------------------------

interface DoctorReport {
  storageDir: string;
  diskFiles: string[];
  indexEntries: string[];
  orphans: string[]; // on disk, not in index
  dangling: string[]; // in index, no file
  unreadable: string[]; // parse errors
  invalidType: string[]; // type not in VALID_TYPES
  rebuilt: boolean;
}

function runDoctor(rebuildIndex: boolean): DoctorReport {
  ensureStorage();
  const diskFiles = listMemoryFiles();
  const indexEntries = readIndex();
  const indexNames = Array.from(indexEntries.keys());

  const orphans = diskFiles.filter((n) => !indexEntries.has(n));
  const dangling = indexNames.filter((n) => !diskFiles.includes(n));

  const unreadable: string[] = [];
  const invalidType: string[] = [];
  for (const name of diskFiles) {
    try {
      const mem = readMemory(name);
      if (!mem) {
        unreadable.push(name);
      } else if (!VALID_TYPES.has(mem.type)) {
        invalidType.push(`${name} (type="${mem.type}")`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      unreadable.push(`${name} (${msg.split("\n")[0]})`);
    }
  }

  let rebuilt = false;
  if (rebuildIndex && (orphans.length > 0 || dangling.length > 0)) {
    withLock(() => {
      const newEntries = new Map<string, string>();
      for (const name of diskFiles) {
        const mem = readMemory(name);
        if (mem) {
          newEntries.set(name, `- [${name}](${name}.md) — ${mem.description}`);
        }
      }
      writeIndex(newEntries);
    });
    rebuilt = true;
  }

  return {
    storageDir: MEMORY_DIR,
    diskFiles,
    indexEntries: indexNames,
    orphans,
    dangling,
    unreadable,
    invalidType,
    rebuilt,
  };
}

function formatDoctorReport(r: DoctorReport, rebuildRequested: boolean): string {
  const lines: string[] = [];
  lines.push(`agent-memory doctor`);
  lines.push(`storage : ${r.storageDir}`);
  lines.push(`on disk : ${r.diskFiles.length} memor${r.diskFiles.length === 1 ? "y" : "ies"}`);
  lines.push(`indexed : ${r.indexEntries.length}`);
  lines.push("");

  const issueCount =
    r.orphans.length + r.dangling.length + r.unreadable.length + r.invalidType.length;
  if (issueCount === 0) {
    lines.push("OK · no issues found");
    return lines.join("\n");
  }

  lines.push(`Found ${issueCount} issue${issueCount === 1 ? "" : "s"}:`);
  for (const o of r.orphans) lines.push(`  orphan   · ${o}.md exists on disk but not in MEMORY.md`);
  for (const d of r.dangling) lines.push(`  dangling · ${d} indexed but file missing`);
  for (const u of r.unreadable) lines.push(`  bad      · ${u}`);
  for (const v of r.invalidType) lines.push(`  type     · ${v}`);

  lines.push("");
  if (r.rebuilt) {
    lines.push(`Fixed · rebuilt MEMORY.md from disk (${r.diskFiles.length} entries).`);
    lines.push(`Note · unreadable / invalid-type files were NOT removed. Inspect and fix by hand.`);
  } else if (!rebuildRequested) {
    lines.push("Re-run with --rebuild-index to reconstruct MEMORY.md from disk.");
  }
  return lines.join("\n");
}

function toolDoctor(args: Record<string, unknown>): string {
  const rebuild = Boolean(args["rebuild-index"]);
  const report = runDoctor(rebuild);
  return formatDoctorReport(report, rebuild);
}

// -------------------------------------------------------------
// verify_memory · re-evaluate a memory's claims
// -------------------------------------------------------------
//
// Static analysis only (no network calls — MCP servers may run
// offline). Extracts URLs + dates + file paths from the body and
// returns a structured report the LLM can act on. Pairs with the
// audit_stale prompt to triage memory hygiene.

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/g;
const DATE_PATTERN = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const FILE_PATH_PATTERN = /\b(?:[A-Za-z]:\\|\/)?(?:[\w.-]+[\\/])+[\w.-]+\.\w+\b/g;

function toolVerifyMemory(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  if (!SLUG_PATTERN.test(name)) throw new Error(`Invalid name "${name}".`);
  const mem = readMemory(name);
  if (!mem) return `Memory "${name}" not found.`;

  const urls = Array.from(new Set(mem.body.match(URL_PATTERN) ?? []));
  const dates = Array.from(new Set((mem.body.match(DATE_PATTERN) ?? []).map((d) => d)));
  const filePaths = Array.from(new Set(mem.body.match(FILE_PATH_PATTERN) ?? []));

  // Staleness heuristic: if any date in the body is more than 60 days
  // old AND the memory type is project, flag it for review.
  const now = Date.now();
  const SIXTY_DAYS = 60 * 24 * 3600 * 1000;
  const oldDates = dates.filter((d) => {
    const parsed = Date.parse(d);
    return !isNaN(parsed) && now - parsed > SIXTY_DAYS;
  });

  const lines: string[] = [];
  lines.push(c(ANSI.bold, `verify_memory · ${mem.name}`));
  lines.push(`type        : ${mem.type}`);
  lines.push(`description : ${mem.description}`);
  lines.push("");
  lines.push(c(ANSI.bold, "Static signals:"));
  lines.push(`  URLs found        : ${urls.length}`);
  lines.push(
    `  Dates referenced  : ${dates.length}${oldDates.length > 0 ? ` (${oldDates.length} > 60 days old)` : ""}`,
  );
  lines.push(`  File-path refs    : ${filePaths.length}`);

  if (urls.length > 0) {
    lines.push("");
    lines.push(c(ANSI.bold, "URLs to verify:"));
    for (const u of urls.slice(0, 10)) lines.push(`  - ${u}`);
    if (urls.length > 10) lines.push(`  ... +${urls.length - 10} more`);
  }

  if (oldDates.length > 0) {
    lines.push("");
    lines.push(c(ANSI.yellow, "Stale-date signals (consider whether claims are still current):"));
    for (const d of oldDates.slice(0, 5)) lines.push(`  - ${d}`);
  }

  if (filePaths.length > 0 && filePaths.length <= 10) {
    lines.push("");
    lines.push(c(ANSI.bold, "File paths referenced:"));
    for (const fp of filePaths) lines.push(`  - ${fp}`);
  }

  lines.push("");
  lines.push(c(ANSI.bold, "Type-specific verification heuristics:"));
  switch (mem.type) {
    case "reference":
      lines.push("  - HEAD-check each URL above (200 = alive, 404 = dead, 410 = gone)");
      lines.push("  - Verify the resource still says what the memory claims it says");
      break;
    case "project":
      lines.push("  - Check if any dates above are stale relative to current project state");
      lines.push("  - Cross-reference any names/people mentioned against current org chart");
      lines.push("  - Verify any deadlines or commitments haven't already passed");
      break;
    case "feedback":
      lines.push("  - Confirm the rule still applies (operator hasn't changed their mind)");
      lines.push(
        "  - Check the **Why:** is still load-bearing — if the original reason is gone, the rule may be obsolete",
      );
      break;
    case "user":
      lines.push(
        "  - User preferences drift over time; ask the operator if a 6+ month old memory still holds",
      );
      break;
  }

  lines.push("");
  lines.push(c(ANSI.dim, "Memory body for review:"));
  lines.push("");
  lines.push(mem.body);

  return lines.join("\n");
}

// -------------------------------------------------------------
// Backlinks · which memories link to this one via [[wiki-link]]
// -------------------------------------------------------------

function toolFindBacklinks(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  if (!SLUG_PATTERN.test(name)) throw new Error(`Invalid name "${name}".`);

  const target = name.toLowerCase();
  const all = listMemoryFiles()
    .map((n) => readMemory(n))
    .filter((m): m is Memory => m !== null);

  const backlinks: Memory[] = [];
  for (const m of all) {
    if (m.name === name) continue;
    const links = extractWikiLinks(m.body, m.name);
    if (links.includes(target)) backlinks.push(m);
  }

  if (backlinks.length === 0) return `No memories link to [[${name}]].`;

  const lines: string[] = [];
  lines.push(
    c(
      ANSI.bold,
      `Found ${backlinks.length} memor${backlinks.length === 1 ? "y" : "ies"} linking to [[${name}]]:`,
    ),
  );
  lines.push("");
  for (const m of backlinks.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  ${m.name}  [${m.type}]`);
    lines.push(`    ${m.description}`);
  }
  return lines.join("\n");
}

// -------------------------------------------------------------
// find_related · the discovery layer
// -------------------------------------------------------------
//
// Surfaces memories related to a given one via three signals:
//   1. Wiki-links     · outbound [[refs]] from this memory
//   2. Backlinks      · memories that link TO this one
//   3. Shared tags    · memories sharing ≥1 tag
//   4. Content sim    · Fuse score against name + description
// Each signal contributes points; results ranked by total score.

interface RelatedHit {
  name: string;
  type: string;
  tags: string[];
  description: string;
  score: number;
  reasons: string[];
}

function toolFindRelated(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  if (!SLUG_PATTERN.test(name)) throw new Error(`Invalid name "${name}".`);
  const mem = readMemory(name);
  if (!mem) return `Memory "${name}" not found.`;

  const max = args.max ? Math.max(1, Math.min(20, Number(args.max))) : 8;

  const others = listMemoryFiles()
    .filter((n) => n !== name)
    .map((n) => readMemory(n))
    .filter((m): m is Memory => m !== null);

  if (others.length === 0) return `No other memories to compare against.`;

  const outbound = new Set(extractWikiLinks(mem.body, mem.name));
  const myTags = new Set(mem.tags);

  // Fuzzy similarity against name + description only (body content is
  // too noisy for relatedness; we already cover semantic overlap via
  // search_memories).
  const fuse = new Fuse(others, {
    includeScore: true,
    threshold: 0.7,
    ignoreLocation: true,
    minMatchCharLength: 3,
    keys: [
      { name: "name", weight: 2 },
      { name: "description", weight: 1 },
    ],
  });
  const fuzzy = new Map<string, number>();
  const query = `${mem.name} ${mem.description}`;
  for (const r of fuse.search(query, { limit: 20 })) {
    fuzzy.set(r.item.name, 1 - (r.score ?? 1));
  }

  const scored = new Map<string, RelatedHit>();
  for (const other of others) {
    let score = 0;
    const reasons: string[] = [];

    if (outbound.has(other.name)) {
      score += 5;
      reasons.push("linked from this memory");
    }
    const otherOutbound = extractWikiLinks(other.body, other.name);
    if (otherOutbound.includes(mem.name)) {
      score += 5;
      reasons.push("links to this memory");
    }
    const sharedTags = other.tags.filter((t) => myTags.has(t));
    if (sharedTags.length > 0) {
      score += sharedTags.length * 3;
      reasons.push(`shared tags: ${sharedTags.join(", ")}`);
    }
    if (other.type === mem.type) {
      score += 1;
    }
    const sim = fuzzy.get(other.name);
    if (sim && sim > 0.3) {
      score += Math.round(sim * 4);
      reasons.push(`content similarity ${Math.round(sim * 100)}%`);
    }

    if (score > 0) {
      scored.set(other.name, {
        name: other.name,
        type: other.type,
        tags: other.tags,
        description: other.description,
        score,
        reasons,
      });
    }
  }

  const ranked = Array.from(scored.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, max);

  if (ranked.length === 0) return `No memories related to "${name}" found.`;

  const lines: string[] = [];
  lines.push(c(ANSI.bold, `Memories related to ${name}:`));
  lines.push("");
  for (const r of ranked) {
    lines.push(`  ${r.name}  [${r.type}]  ${c(ANSI.dim, `· score ${r.score}`)}`);
    lines.push(`    ${r.description}`);
    for (const reason of r.reasons) {
      lines.push(`    ${c(ANSI.dim, `· ${reason}`)}`);
    }
  }
  return lines.join("\n");
}

// -------------------------------------------------------------
// Rule memories · the v0.11 "memory as constraint" wedge
// -------------------------------------------------------------
//
// Rules are first-class memories with type=rule. They differ from
// other types in that they're meant to constrain agent behavior,
// not just be retrievable facts. Three things differentiate them:
//
//   1. Frontmatter has severity / scope / applies_when / matches /
//      enforce_on / last_verified · all optional, gracefully fall
//      back when absent.
//
//   2. Companion-file emission · all type=rule memories project out
//      to AGENTS.md (Linux-Foundation-stewarded universal standard
//      read natively by Claude Code, Codex CLI, Cursor, Aider, Devin,
//      Copilot, Gemini CLI, Windsurf, and Amazon Q as of late 2025).
//      One source of truth, regenerated from the rule store.
//
//   3. `save_rule` is a convenience wrapper around save_memory that
//      validates rule-specific fields, then auto-emits companions
//      when AGENT_MEMORY_AUTO_EMIT_DIR is set in the environment
//      (opt-in to avoid surprise file creation in arbitrary CWDs).

function loadAllRules(): Memory[] {
  return listMemoryFiles()
    .map((n) => readMemory(n))
    .filter((m): m is Memory => m !== null && m.type === "rule")
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatRuleAsMarkdown(rule: Memory): string {
  const lines: string[] = [];
  const sev = rule.severity ? ` _(${rule.severity})_` : "";
  lines.push(`### ${rule.name}${sev}`);
  lines.push("");
  if (rule.description) lines.push(rule.description);
  if (rule.scope && rule.scope.length > 0) {
    lines.push(`- **Scope:** ${rule.scope.join(", ")}`);
  }
  if (rule.enforce_on && rule.enforce_on.length > 0) {
    lines.push(`- **Enforce on:** ${rule.enforce_on.join(", ")}`);
  }
  if (rule.applies_when && rule.applies_when.length > 0) {
    lines.push(`- **Applies when:**`);
    for (const a of rule.applies_when) lines.push(`  - ${a}`);
  }
  if (rule.matches && rule.matches.length > 0) {
    lines.push(
      `- **Pattern matches:** \`${rule.matches.map((m) => m.replace(/`/g, "\\`")).join("` · `")}\``,
    );
  }
  if (rule.last_verified) lines.push(`- _Last verified: ${rule.last_verified}_`);
  if (rule.body) {
    lines.push("");
    lines.push(rule.body);
  }
  lines.push("");
  return lines.join("\n");
}

function buildAgentsMdContent(rules: Memory[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const head = [
    `# Operator rules`,
    ``,
    `> Auto-generated by agent-memory-mcp from \`${MEMORY_DIR}\` on ${today}.`,
    `> Edit the source memory files at that path — not this file — and rerun \`agent-memory emit-companions\` to refresh.`,
    `>`,
    `> ${rules.length} rule${rules.length === 1 ? "" : "s"} active.`,
    ``,
  ];

  if (rules.length === 0) {
    head.push(`No rules defined yet. Run \`agent-memory save-rule …\` to add the first one.`);
    return head.join("\n") + "\n";
  }

  const hard = rules.filter((r) => r.severity === "hard");
  const soft = rules.filter((r) => r.severity !== "hard");

  const parts = [...head];
  if (hard.length > 0) {
    parts.push(`## Hard rules · always obey`);
    parts.push(``);
    for (const r of hard) parts.push(formatRuleAsMarkdown(r));
  }
  if (soft.length > 0) {
    parts.push(`## Conventions · prefer to obey`);
    parts.push(``);
    for (const r of soft) parts.push(formatRuleAsMarkdown(r));
  }
  return parts.join("\n");
}

// Companion target keys · keep this stable, downstream consumers (audit,
// CI scripts, etc.) check the emitted-files list against these names.
export type CompanionTarget = "agents" | "claude" | "cursor" | "gemini";
export const ALL_COMPANION_TARGETS: CompanionTarget[] = ["agents", "claude", "cursor", "gemini"];

interface EmitCompanionsResult {
  outDir: string;
  emitted: string[];
  rules_count: number;
  targets: CompanionTarget[];
}

function resolveCompanionDir(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const envOverride = process.env.AGENT_MEMORY_COMPANION_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride.trim();
  return process.cwd();
}

// CLAUDE.md content · same body as AGENTS.md but with a Claude-Code-specific
// header. Claude Code's 5-level hierarchy (managed/global/project/local/subdir)
// reads any CLAUDE.md it finds; we generate the project-root file by default.
function buildClaudeMdContent(rules: Memory[]): string {
  const body = buildAgentsMdContent(rules);
  // Replace the AGENTS.md-specific header sentence with a CLAUDE.md one
  return body.replace(
    /^# Operator rules\n/,
    `# Operator rules · Claude Code\n\n> This is your CLAUDE.md — Claude Code reads it on session start.\n\n`,
  );
}

// .gemini/instructions.md content · same body as AGENTS.md, slightly different
// header.
function buildGeminiInstructionsContent(rules: Memory[]): string {
  const body = buildAgentsMdContent(rules);
  return body.replace(
    /^# Operator rules\n/,
    `# Operator rules · Gemini CLI\n\n> Loaded by Gemini CLI from .gemini/instructions.md on session start.\n\n`,
  );
}

interface CursorMdcFile {
  filename: string;
  content: string;
}

// Cursor consumes .cursor/rules/*.mdc files with their own YAML frontmatter.
// Per spec: each file <150 lines, alwaysApply file <50 lines, dir total <500.
// Strategy: one file per severity (hard / soft) — hard is alwaysApply, soft
// is description-driven so the agent pulls it in when relevant.
function buildCursorMdcFiles(rules: Memory[]): CursorMdcFile[] {
  const hard = rules.filter((r) => r.severity === "hard");
  const soft = rules.filter((r) => r.severity !== "hard");
  const files: CursorMdcFile[] = [];

  if (hard.length > 0) {
    const fm = [
      "---",
      `description: "Operator hard rules · always obey · auto-generated from agent-memory-mcp"`,
      "alwaysApply: true",
      "---",
      "",
      "# Operator hard rules",
      "",
      "These rules MUST be obeyed. Violations should be flagged and blocked.",
      "",
    ].join("\n");
    files.push({
      filename: "operator-hard.mdc",
      content: fm + hard.map((r) => formatRuleAsMarkdown(r)).join("\n"),
    });
  }

  if (soft.length > 0) {
    const fm = [
      "---",
      `description: "Operator conventions · prefer to obey · pulled in by agent on relevance"`,
      "alwaysApply: false",
      "---",
      "",
      "# Operator conventions",
      "",
      "Soft rules · prefer to obey. The agent may consult these when the context warrants.",
      "",
    ].join("\n");
    files.push({
      filename: "operator-conventions.mdc",
      content: fm + soft.map((r) => formatRuleAsMarkdown(r)).join("\n"),
    });
  }

  return files;
}

interface EmitOptions {
  outDir?: string;
  targets?: CompanionTarget[];
}

function emitCompanions(opts: EmitOptions = {}): EmitCompanionsResult {
  const outDir = resolveCompanionDir(opts.outDir);
  const targets = opts.targets && opts.targets.length > 0 ? opts.targets : ALL_COMPANION_TARGETS;
  const rules = loadAllRules();

  // Best-effort directory creation; mkdirSync recursive is idempotent.
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    // Ignore — atomicWriteFile surfaces a clearer error if needed.
  }

  const emitted: string[] = [];

  if (targets.includes("agents")) {
    const fp = join(outDir, "AGENTS.md");
    atomicWriteFile(fp, buildAgentsMdContent(rules));
    emitted.push(fp);
  }
  if (targets.includes("claude")) {
    const fp = join(outDir, "CLAUDE.md");
    atomicWriteFile(fp, buildClaudeMdContent(rules));
    emitted.push(fp);
  }
  if (targets.includes("cursor")) {
    const cursorDir = join(outDir, ".cursor", "rules");
    try {
      mkdirSync(cursorDir, { recursive: true });
    } catch {
      // Ignore — atomicWriteFile surfaces clearer error if needed.
    }
    const files = buildCursorMdcFiles(rules);
    if (files.length === 0) {
      // No rules yet — drop a placeholder so the tool knows where to put them
      const placeholderPath = join(cursorDir, "operator-rules.mdc");
      const placeholder = [
        "---",
        `description: "Operator rules · auto-generated · no rules defined yet"`,
        "alwaysApply: false",
        "---",
        "",
        "No rules defined yet. Run `agent-memory save-rule` to add the first one.",
        "",
      ].join("\n");
      atomicWriteFile(placeholderPath, placeholder);
      emitted.push(placeholderPath);
    } else {
      for (const f of files) {
        const fp = join(cursorDir, f.filename);
        atomicWriteFile(fp, f.content);
        emitted.push(fp);
      }
    }
  }
  if (targets.includes("gemini")) {
    const geminiDir = join(outDir, ".gemini");
    try {
      mkdirSync(geminiDir, { recursive: true });
    } catch {
      // Ignore — atomicWriteFile surfaces clearer error if needed.
    }
    const fp = join(geminiDir, "instructions.md");
    atomicWriteFile(fp, buildGeminiInstructionsContent(rules));
    emitted.push(fp);
  }

  logEvent("emit_companions", {
    outDir,
    rules_count: rules.length,
    targets,
    files: emitted.map((p) => p.replace(outDir, "").replace(/^[\\/]/, "")),
  });
  return { outDir, emitted, rules_count: rules.length, targets };
}

function maybeAutoEmitCompanions(): void {
  const autoDir = process.env.AGENT_MEMORY_AUTO_EMIT_DIR;
  if (!autoDir || autoDir.trim().length === 0) return;
  try {
    emitCompanions({ outDir: autoDir });
  } catch (err) {
    log("warn", "auto_emit_failed", {
      outDir: autoDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function toolEmitCompanions(args: Record<string, unknown>): string {
  const outDir = typeof args.out_dir === "string" ? args.out_dir : undefined;
  let targets: CompanionTarget[] | undefined;
  if (Array.isArray(args.targets)) {
    targets = (args.targets as unknown[])
      .filter((t): t is string => typeof t === "string")
      .filter((t): t is CompanionTarget => (ALL_COMPANION_TARGETS as string[]).includes(t));
    if (targets.length === 0) targets = undefined;
  }
  const r = emitCompanions({ outDir, targets });
  const files = r.emitted.map((p) => p.replace(r.outDir, "").replace(/^[\\/]/, "")).join(", ");
  if (r.rules_count === 0) {
    return `Emitted ${r.emitted.length} placeholder file(s) to ${r.outDir} (${files}) · no rules yet · run save_rule to add the first one.`;
  }
  return `Emitted ${r.rules_count} rule${r.rules_count === 1 ? "" : "s"} across ${r.targets.length} target${r.targets.length === 1 ? "" : "s"} (${r.targets.join(", ")}) → ${r.emitted.length} file${r.emitted.length === 1 ? "" : "s"} at ${r.outDir}: ${files}`;
}

function toolListRules(_args: Record<string, unknown>): string {
  const rules = loadAllRules();
  if (rules.length === 0) return "No rules defined yet. Use save_rule to add one.";
  const lines: string[] = [];
  lines.push(c(ANSI.bold, `${rules.length} rule${rules.length === 1 ? "" : "s"} active:`));
  lines.push("");
  for (const r of rules) {
    const sev = r.severity ? ` [${r.severity}]` : "";
    const scope = r.scope && r.scope.length > 0 ? ` · scope: ${r.scope.join(", ")}` : "";
    const stale =
      r.last_verified && Date.now() - new Date(r.last_verified).getTime() > 90 * 86400_000
        ? c(ANSI.yellow, " · STALE >90d")
        : "";
    lines.push(`  ${r.name}${sev}${scope}${stale}`);
    lines.push(`    ${r.description}`);
  }
  return lines.join("\n");
}

function toolSaveRule(args: Record<string, unknown>): string {
  const name = String(args.name ?? "").trim();
  const description = String(args.description ?? "").trim();
  const content = String(args.content ?? "").trim();
  const severity = String(args.severity ?? "soft").trim();
  if (!VALID_RULE_SEVERITIES.has(severity)) {
    throw new Error(
      `Invalid severity "${severity}". Must be one of: ${Array.from(VALID_RULE_SEVERITIES).join(", ")}.`,
    );
  }
  const scope = parseStringArray(args.scope);
  const applies_when = parseStringArray(args.applies_when);
  const matches = parseStringArray(args.matches);
  const enforce_on = parseStringArray(args.enforce_on);
  const last_verified =
    typeof args.last_verified === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.last_verified)
      ? args.last_verified
      : new Date().toISOString().slice(0, 10);

  if (!SLUG_PATTERN.test(name)) {
    throw new Error(
      `Invalid name "${name}". Use lowercase (a-z, 0-9, hyphen, underscore), 1-80 chars, must start with letter or digit.`,
    );
  }
  if (!description) throw new Error("description is required");
  if (!content) throw new Error("content is required");

  ensureStorage();

  const extras: string[] = [];
  extras.push(`severity: ${severity}`);
  if (scope) extras.push(`scope: [${scope.map((s) => JSON.stringify(s)).join(", ")}]`);
  if (applies_when)
    extras.push(`applies_when: [${applies_when.map((s) => JSON.stringify(s)).join(", ")}]`);
  if (matches) extras.push(`matches: [${matches.map((s) => JSON.stringify(s)).join(", ")}]`);
  if (enforce_on)
    extras.push(`enforce_on: [${enforce_on.map((s) => JSON.stringify(s)).join(", ")}]`);
  extras.push(`last_verified: ${last_verified}`);

  const frontmatter =
    `---\n` +
    `name: ${name}\n` +
    `description: ${JSON.stringify(description)}\n` +
    `type: rule\n` +
    extras.map((e) => `${e}\n`).join("") +
    `schema: ${SCHEMA_VERSION}\n` +
    `---\n\n`;

  const fp = memoryFilePath(name);
  const isUpdate = existsSync(fp);

  return withLock(() => {
    atomicWriteFile(fp, frontmatter + content + "\n");
    upsertIndexEntryUnlocked(name, description);
    logEvent("save_rule", {
      name,
      severity,
      update: isUpdate,
      bytes: content.length,
    });
    log("debug", "save_rule", { name, severity, update: isUpdate });
    maybeAutoEmitCompanions();
    return `${isUpdate ? "Updated" : "Saved"} rule "${name}" (${severity}) at ${fp}`;
  });
}

// -------------------------------------------------------------
// Compliance Receipts · v0.11.2 · the novel protocol primitive
// -------------------------------------------------------------
//
// Receipts are short-lived, HMAC-signed bearer tokens with caveats
// (attenuations). Macaroon-style. Issued by `check_action` (v0.11.3),
// validated before our own destructive tools execute. Prior art:
//
//   Birgisson et al · "Macaroons: Cookies with Contextual Caveats for
//   Decentralized Authorization in the Cloud" · Google Research,
//   NDSS 2014 · https://research.google/pubs/pub41892/
//
// Why receipts work where MCP Sampling doesn't:
//   - MCP Sampling is unsupported on Claude Code / Cursor / Cline /
//     Codex CLI (the primary coding clients) per the MCP client matrix.
//   - Receipts are server-issued protocol artifacts — they work on every
//     client because the server controls both ends (issue + validate).
//   - Receipts bind to: action + session + rules-version-hash + expiry.
//     Tampering breaks the HMAC. Rule changes invalidate stale receipts.
//
// Storage:
//   HMAC key lives at <MEMORY_DIR>/.keyring/hmac-key · 32 random bytes
//   created on first use with mode 0o600 (owner read/write only).
//   Caller-rotatable via `agent-memory rotate-key` (a v0.11.x follow-up).
//
// v0.11.2 ships the PRIMITIVE only — issuance + validation +
// canonicalization. Tool wiring (delete_memory + check_action) lands
// in v0.11.3.

const KEYRING_DIR = join(MEMORY_DIR, ".keyring");
const HMAC_KEY_FILE = join(KEYRING_DIR, "hmac-key");
const RECEIPT_DEFAULT_TTL_SECONDS = 60;

export interface Caveat {
  /** Caveat kind. Reserved: "action", "session", "scope", "expires_before". Custom kinds are allowed. */
  type: string;
  /** Type-specific value. Compared with exact-string equality. */
  value: string;
}

export interface ComplianceReceipt {
  /** Unique receipt id · "rcpt_" + 16 hex chars. Logged for audit. */
  id: string;
  /** Unix epoch seconds when the receipt was issued. */
  issued_at: number;
  /** Unix epoch seconds after which the receipt is no longer valid. */
  expires_at: number;
  /** sha256 (first 16 hex chars) of the rule-store contents at issue time. */
  rules_version: string;
  /** Constraints attached to this receipt. Validation requires all required caveats to be present. */
  caveats: Caveat[];
  /** Hex-encoded HMAC-SHA256 of the canonical form (excluding this field). */
  signature: string;
}

function loadOrCreateHmacKey(): Buffer {
  if (existsSync(HMAC_KEY_FILE)) {
    return readFileSync(HMAC_KEY_FILE);
  }
  if (!existsSync(KEYRING_DIR)) {
    mkdirSync(KEYRING_DIR, { recursive: true });
  }
  const key = randomBytes(32); // 256 bits · plenty for HMAC-SHA256
  // mode 0o600 is owner-only on POSIX; Windows ignores mode but ACLs
  // default to the user, so practically equivalent for our threat model.
  writeFileSync(HMAC_KEY_FILE, key, { mode: 0o600 });
  return key;
}

/**
 * Compute the rules-version hash · first 16 hex chars of SHA-256 over
 * the concatenated bytes of every type=rule memory file, in sorted
 * filename order. Any rule add / edit / remove changes this hash,
 * which invalidates outstanding receipts (they were issued against a
 * different rule set).
 */
function computeRulesVersion(): string {
  const rules = loadAllRules();
  const sortedPaths = rules.map((r) => r.filePath).sort();
  const hash = createHash("sha256");
  for (const fp of sortedPaths) {
    try {
      hash.update(readFileSync(fp));
    } catch {
      // File disappeared between listMemoryFiles + read; skip it.
      // Next computation will reflect the change.
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Deterministic canonical form for HMAC input · caveats sorted by
 * (type, value) so the order in which the caller listed them doesn't
 * change the signature. JSON with no whitespace (single line) so the
 * exact byte sequence is reproducible across platforms.
 */
function canonicalizeReceipt(r: Omit<ComplianceReceipt, "signature">): string {
  const sortedCaveats = [...r.caveats].sort((a, b) =>
    a.type === b.type ? a.value.localeCompare(b.value) : a.type.localeCompare(b.type),
  );
  return JSON.stringify({
    id: r.id,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    rules_version: r.rules_version,
    caveats: sortedCaveats,
  });
}

function signReceipt(r: Omit<ComplianceReceipt, "signature">): string {
  const key = loadOrCreateHmacKey();
  return createHmac("sha256", key).update(canonicalizeReceipt(r)).digest("hex");
}

export interface IssueReceiptOptions {
  /** Caveats attached to the receipt. Empty array allowed but rare. */
  caveats: Caveat[];
  /** Seconds until expiry · defaults to 60. Receipts SHOULD be short-lived. */
  ttl_seconds?: number;
}

/**
 * Issue a fresh Compliance Receipt with the given caveats. The receipt
 * is bound to the current rule-store hash; any rule edit invalidates it.
 */
export function issueReceipt(opts: IssueReceiptOptions): ComplianceReceipt {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(1, opts.ttl_seconds ?? RECEIPT_DEFAULT_TTL_SECONDS);
  const base: Omit<ComplianceReceipt, "signature"> = {
    id: "rcpt_" + randomBytes(8).toString("hex"),
    issued_at: now,
    expires_at: now + ttl,
    rules_version: computeRulesVersion(),
    caveats: opts.caveats,
  };
  return { ...base, signature: signReceipt(base) };
}

export interface ValidateReceiptOptions {
  /** Caveats that MUST be present on the receipt. Each must exact-match by (type, value). */
  required_caveats?: Caveat[];
  /** Override the current rules version (for tests). Default: recompute live. */
  current_rules_version?: string;
}

export interface ValidateReceiptResult {
  valid: boolean;
  /** Reason for rejection · only present when valid=false. */
  reason?: string;
}

/**
 * Validate a Compliance Receipt against the current rule store + caller's
 * required caveats. Returns {valid: true} on success, otherwise
 * {valid: false, reason: <human-readable>}.
 */
export function validateReceipt(
  receipt: ComplianceReceipt,
  opts: ValidateReceiptOptions = {},
): ValidateReceiptResult {
  // 1. HMAC verification · constant-time compare to avoid timing leaks.
  const expected = signReceipt({
    id: receipt.id,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
    rules_version: receipt.rules_version,
    caveats: receipt.caveats,
  });
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(receipt.signature, "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: "invalid signature" };
  }

  // 2. Expiry · receipts past their expires_at are dead.
  const now = Math.floor(Date.now() / 1000);
  if (now > receipt.expires_at) {
    return { valid: false, reason: "receipt expired" };
  }

  // 3. Rules-version binding · any rule edit since issuance invalidates.
  const currentRulesVersion = opts.current_rules_version ?? computeRulesVersion();
  if (receipt.rules_version !== currentRulesVersion) {
    return {
      valid: false,
      reason: `rules changed since receipt issued (was ${receipt.rules_version}, now ${currentRulesVersion})`,
    };
  }

  // 4. Required-caveat check · each required pair must appear on the receipt.
  if (opts.required_caveats) {
    for (const required of opts.required_caveats) {
      const found = receipt.caveats.find(
        (c) => c.type === required.type && c.value === required.value,
      );
      if (!found) {
        return {
          valid: false,
          reason: `missing required caveat: ${required.type}=${required.value}`,
        };
      }
    }
  }

  return { valid: true };
}

// -------------------------------------------------------------
// Git sync · multi-machine memory via git remote
// -------------------------------------------------------------
//
// The killer feature for file-based memory: every dev machine has git,
// and markdown files merge cleanly. Convert .agent-memory/ into a git
// repo, point it at a (private) GitHub repo, and `sync push` / `sync
// pull` becomes the multi-machine story.
//
// Usage flow:
//   agent-memory sync init git@github.com:you/agent-memory.git
//   ... save some memories ...
//   agent-memory sync push                # commit + push
//   # later, on another machine:
//   agent-memory sync pull                # pull updates
//   agent-memory sync status              # ahead/behind/clean
//
// Files we EXCLUDE from sync (per-machine state):
//   .lock          · proper-lockfile per-process lock
//   .events.jsonl  · per-machine audit log
//   .trash/        · per-machine soft-delete staging

const SYNC_GITIGNORE =
  "# Per-machine state · do not sync across devices\n" +
  ".lock\n" +
  ".events.jsonl\n" +
  ".trash/\n";

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function git(args: string[]): GitResult {
  // Inject a default commit identity so machines without `git config
  // --global user.email` can still sync. Env vars are git's highest-
  // precedence identity source, so they override any later config —
  // fine for automated memory-sync where per-commit attribution
  // doesn't matter. Honors operator overrides if set in the environment.
  const result = spawnSync("git", args, {
    cwd: MEMORY_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "agent-memory",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "agent-memory@local",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "agent-memory",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "agent-memory@local",
    },
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    exitCode: result.status ?? -1,
  };
}

function isGitRepo(): boolean {
  return existsSync(join(MEMORY_DIR, ".git"));
}

function requireRepo(): void {
  if (!isGitRepo()) {
    throw new Error(
      `${MEMORY_DIR} is not a git repo. Run 'agent-memory sync init <remote-url>' first.`,
    );
  }
}

function toolSyncInit(args: Record<string, unknown>): string {
  const remoteUrl = String(args.remote ?? args.url ?? "").trim();
  if (!remoteUrl) {
    throw new Error(
      "Usage: agent-memory sync init <remote-url>\nExample: agent-memory sync init git@github.com:you/agent-memory.git",
    );
  }
  ensureStorage();
  if (isGitRepo()) {
    return `${MEMORY_DIR} is already a git repo. Use 'sync push' or 'sync pull'.`;
  }

  const init = git(["init", "-b", "main"]);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);

  writeFileSync(join(MEMORY_DIR, ".gitignore"), SYNC_GITIGNORE, "utf8");

  const addRemote = git(["remote", "add", "origin", remoteUrl]);
  if (addRemote.exitCode !== 0) throw new Error(`git remote add failed: ${addRemote.stderr}`);

  const add = git(["add", "-A"]);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const commit = git(["commit", "-m", "agent-memory · initial sync"]);
  // commit can fail if there's nothing to commit (empty store) — that's OK
  if (commit.exitCode !== 0 && !commit.stderr.includes("nothing to commit")) {
    log("warn", "initial commit had no changes", { stderr: commit.stderr });
  }

  const push = git(["push", "-u", "origin", "main"]);
  logEvent("sync_init", { remote: remoteUrl, pushed: push.exitCode === 0 });

  const lines = [
    c(ANSI.green, "✓ initialized memory sync"),
    `  storage : ${MEMORY_DIR}`,
    `  remote  : ${remoteUrl}`,
    `  branch  : main`,
  ];
  if (push.exitCode !== 0) {
    lines.push("");
    lines.push(c(ANSI.yellow, "Initial push failed (remote may not exist yet):"));
    lines.push(`  ${push.stderr.split("\n")[0]}`);
    lines.push("");
    lines.push("Create the empty remote on GitHub (or your git host), then run:");
    lines.push("  agent-memory sync push");
  } else {
    lines.push("");
    lines.push("Future commands: 'sync push' / 'sync pull' / 'sync status' / 'sync log'");
  }
  return lines.join("\n");
}

function toolSyncStatus(_args: Record<string, unknown>): string {
  if (!isGitRepo()) {
    return `${MEMORY_DIR} is not a git repo. Use 'sync init <remote-url>' to set it up.`;
  }

  const remote = git(["remote", "get-url", "origin"]);
  const branch = git(["branch", "--show-current"]);
  const fetch = git(["fetch", "origin", "--quiet"]);
  const offline = fetch.exitCode !== 0;

  const status = git(["status", "--porcelain"]);
  const localChanges = status.stdout.split("\n").filter(Boolean).length;

  const lines: string[] = [];
  lines.push(c(ANSI.bold, "agent-memory sync · status"));
  lines.push(`  storage : ${MEMORY_DIR}`);
  lines.push(`  remote  : ${remote.stdout || c(ANSI.yellow, "(none configured)")}`);
  lines.push(`  branch  : ${branch.stdout || "(unknown)"}`);
  if (offline) {
    lines.push(`  fetch   : ${c(ANSI.yellow, "offline — couldn't reach remote")}`);
  }
  lines.push("");
  lines.push(c(ANSI.bold, "local state:"));
  if (localChanges === 0) {
    lines.push(`  ${c(ANSI.green, "✓ clean")} — no uncommitted changes`);
  } else {
    lines.push(
      `  ${c(ANSI.yellow, `${localChanges} file(s) uncommitted`)} — run 'sync push' to commit + send`,
    );
  }

  if (!offline && branch.stdout) {
    const ahead = git(["rev-list", "--count", `origin/${branch.stdout}..HEAD`]);
    const behind = git(["rev-list", "--count", `HEAD..origin/${branch.stdout}`]);
    const aheadN = Number(ahead.stdout || "0");
    const behindN = Number(behind.stdout || "0");
    lines.push("");
    lines.push(c(ANSI.bold, "vs origin:"));
    if (aheadN === 0 && behindN === 0) {
      lines.push(`  ${c(ANSI.green, "✓ in sync")}`);
    } else {
      if (aheadN > 0)
        lines.push(`  ${c(ANSI.cyan, `↑ ${aheadN} commit(s) ahead`)} — run 'sync push'`);
      if (behindN > 0)
        lines.push(`  ${c(ANSI.cyan, `↓ ${behindN} commit(s) behind`)} — run 'sync pull'`);
    }
  }
  return lines.join("\n");
}

function toolSyncPush(args: Record<string, unknown>): string {
  requireRepo();

  const message = args.message
    ? String(args.message)
    : `agent-memory · sync ${new Date().toISOString().slice(0, 19).replace("T", " ")}Z`;

  const add = git(["add", "-A"]);
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);

  const status = git(["status", "--porcelain"]);
  const hadChanges = status.stdout.length > 0;

  if (hadChanges) {
    const commit = git(["commit", "-m", message]);
    if (commit.exitCode !== 0) throw new Error(`commit failed: ${commit.stderr}`);
  }

  const push = git(["push"]);
  if (push.exitCode !== 0) throw new Error(`push failed: ${push.stderr}`);

  logEvent("sync_push", { hadChanges, commitMessage: hadChanges ? message : null });

  return hadChanges
    ? c(ANSI.green, `✓ committed local changes + pushed to remote\n  message: ${message}`)
    : c(ANSI.green, `✓ nothing new locally; pushed any unpushed commits`);
}

function toolSyncPull(_args: Record<string, unknown>): string {
  requireRepo();

  const status = git(["status", "--porcelain"]);
  if (status.stdout) {
    return (
      c(ANSI.yellow, "Local changes uncommitted.") +
      "\nRun 'agent-memory sync push' first to commit them, then pull."
    );
  }

  const pull = git(["pull", "--ff-only"]);
  if (pull.exitCode !== 0) {
    return (
      c(ANSI.red, "✗ pull failed:") +
      `\n  ${pull.stderr.split("\n").slice(0, 3).join("\n  ")}\n\n` +
      `Likely diverged history (commits on both sides). Resolve manually:\n` +
      `  cd ${MEMORY_DIR}\n` +
      `  git pull   # do the merge by hand`
    );
  }

  logEvent("sync_pull", { output: pull.stdout.split("\n")[0] });

  return c(ANSI.green, "✓ pulled from remote") + (pull.stdout ? `\n${pull.stdout}` : "");
}

function toolSyncLog(args: Record<string, unknown>): string {
  if (!isGitRepo()) return `${MEMORY_DIR} is not a git repo.`;
  const limit = args.limit ? Number(args.limit) : 20;
  const log = git(["log", `--max-count=${limit}`, "--pretty=format:%h %ci %s", "--no-decorate"]);
  if (log.exitCode !== 0) return `git log failed: ${log.stderr}`;
  if (!log.stdout) return "No sync history yet.";

  const lines: string[] = [];
  lines.push(c(ANSI.bold, `Recent sync history (last ${limit}):`));
  lines.push("");
  for (const line of log.stdout.split("\n")) {
    // Format: <short-sha> <iso-date> <subject>
    const m = line.match(/^(\S+)\s+(\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (m) {
      lines.push(`  ${c(ANSI.cyan, m[1])}  ${c(ANSI.dim, m[2])}  ${m[3]}`);
    } else {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}

// -------------------------------------------------------------
// Stats · operator dashboard
// -------------------------------------------------------------

function toolStats(_args: Record<string, unknown>): string {
  ensureStorage();
  const diskFiles = listMemoryFiles();
  const memories = diskFiles.map((n) => readMemory(n)).filter((m): m is Memory => m !== null);

  const byType: Record<string, number> = {};
  for (const t of VALID_TYPES) byType[t] = 0;
  for (const m of memories) byType[m.type] = (byType[m.type] ?? 0) + 1;

  // File sizes via stat on each file (read body length doesn't include
  // frontmatter bytes — stat gives the on-disk truth).
  let totalBytes = 0;
  let largestBytes = 0;
  let largestName = "";
  for (const n of diskFiles) {
    const fp = memoryFilePath(n);
    try {
      const stats = readFileSync(fp, "utf8").length;
      totalBytes += stats;
      if (stats > largestBytes) {
        largestBytes = stats;
        largestName = n;
      }
    } catch {
      // skip unreadable
    }
  }

  // Oldest/newest by file mtime would need a stat call; use the
  // index ordering as a proxy (alphabetical) for simplicity. Real
  // mtime-based age would need `statSync` which adds an N read.
  // Skipping that for v0.4; defer to a `--detailed` flag if asked.

  const events = readEventLog({});
  const trashCount = existsSync(TRASH_DIR)
    ? readdirSync(TRASH_DIR).filter((f) => f.endsWith(".md")).length
    : 0;

  const lines: string[] = [];
  lines.push(c(ANSI.bold, "agent-memory stats"));
  lines.push(c(ANSI.dim, `storage : ${MEMORY_DIR}`));
  lines.push("");
  lines.push(c(ANSI.bold, `memories: ${memories.length} total`));
  for (const t of ["user", "feedback", "project", "reference"]) {
    const count = byType[t] ?? 0;
    const bar = count > 0 ? "█".repeat(Math.min(count, 40)) : "";
    lines.push(`  ${t.padEnd(10)} ${String(count).padStart(4)}  ${c(ANSI.cyan, bar)}`);
  }
  lines.push("");
  lines.push(c(ANSI.bold, "storage:"));
  lines.push(`  total size  ${fmtBytes(totalBytes)}`);
  lines.push(`  avg size    ${memories.length > 0 ? fmtBytes(totalBytes / memories.length) : "—"}`);
  if (largestName) {
    lines.push(`  largest     ${fmtBytes(largestBytes)}  (${largestName})`);
  }
  lines.push("");
  lines.push(c(ANSI.bold, "audit:"));
  lines.push(`  events logged   ${events.length}`);
  lines.push(`  items in trash  ${trashCount}`);
  if (events.length > 0) {
    lines.push(
      `  last event      ${events[events.length - 1].ts} (${events[events.length - 1].action})`,
    );
  }
  return lines.join("\n");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// -------------------------------------------------------------
// Log browser · paginated audit-trail view
// -------------------------------------------------------------

function toolLogEvents(args: Record<string, unknown>): string {
  const tail = args.tail ? Number(args.tail) : 20;
  const action = args.action ? String(args.action) : undefined;
  const events = readEventLog({ tail, action });
  if (events.length === 0) {
    return action ? `No events of action "${action}" in the log.` : "No events logged yet.";
  }

  const lines: string[] = [];
  lines.push(
    c(
      ANSI.bold,
      `Last ${events.length} event${events.length === 1 ? "" : "s"}${action ? ` (action=${action})` : ""}:`,
    ),
  );
  lines.push("");
  for (const e of events) {
    const { ts, action: a, ...rest } = e;
    const tsStr = c(
      ANSI.dim,
      String(ts)
        .replace("T", " ")
        .replace(/\.\d+Z$/, "Z"),
    );
    const actionStr = c(actionColor(String(a)), String(a).padEnd(7));
    const fields = Object.entries(rest)
      .map(([k, v]) => `${c(ANSI.dim, k + "=")}${String(v)}`)
      .join("  ");
    lines.push(`  ${tsStr}  ${actionStr}  ${fields}`);
  }
  return lines.join("\n");
}

function actionColor(action: string): string {
  if (action === "save") return ANSI.green;
  if (action === "delete") return ANSI.yellow;
  if (action === "restore") return ANSI.cyan;
  return ANSI.dim;
}

// -------------------------------------------------------------
// Server wiring
// -------------------------------------------------------------

const server = new Server(
  { name: "agent-memory", version: "0.11.2" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
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

// -------------------------------------------------------------
// Prompts · slash-command workflows the client surfaces
// -------------------------------------------------------------
//
// MCP Prompts are NOT tools — they're structured prompt templates
// the client offers to the user. When invoked, we return a message
// array that the client passes back to the LLM. This is how memory
// becomes ACTIVE: workflows like "extract memories from this
// conversation" or "summarize what we know about X" stop being
// something the operator has to remember to phrase manually.

interface PromptDefinition {
  name: string;
  description: string;
  arguments?: { name: string; description: string; required: boolean }[];
}

const PROMPTS: PromptDefinition[] = [
  {
    name: "extract_memories",
    description:
      "Scan the current conversation for things worth remembering. Returns a structured prompt asking the LLM to identify candidate memories and call save_memory for each one.",
  },
  {
    name: "summarize_topic",
    description:
      "Pull memories relevant to a topic and ask the LLM to synthesize them into a single coherent summary.",
    arguments: [
      { name: "topic", description: "What to summarize what's known about.", required: true },
    ],
  },
  {
    name: "prepare_handoff",
    description:
      "Generate a project state snapshot from all project-type memories matching a filter. Useful for rotating on-call, end-of-day handoffs, or onboarding a collaborator.",
    arguments: [
      {
        name: "project",
        description: "Substring to filter project memories by (matches name + description + tags).",
        required: false,
      },
    ],
  },
  {
    name: "audit_stale",
    description:
      "Walk recent project and reference memories and ask the LLM to flag which ones are likely stale or contradicted by current state. Pairs with verify_memory for follow-up.",
  },
];

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS,
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  ensureStorage();

  switch (name) {
    case "extract_memories":
      return {
        description: PROMPTS[0].description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                "Scan the current conversation for facts, rules, preferences, decisions, or context that would be useful to remember across future sessions. Focus on things that:",
                "",
                "- Reflect the operator's stable preferences or working style (type=user)",
                "- Represent rules the assistant should follow going forward (type=feedback)",
                "- Capture current-state context not derivable from code or docs (type=project)",
                "- Point at external resources the operator references (type=reference)",
                "",
                "For each candidate, call the save_memory tool with:",
                "  - name: a short kebab-case slug (a-z, 0-9, -, _)",
                "  - type: one of user | feedback | project | reference",
                "  - description: a one-line summary used in the index",
                "  - content: the memory body in markdown. For feedback/project, include `**Why:**` and `**How to apply:**` lines.",
                "",
                "Before saving each one, briefly explain why it's worth remembering. Skip anything that's already obvious from code or that's only relevant to the current session.",
                "",
                "If there's nothing worth saving, say so plainly and stop.",
              ].join("\n"),
            },
          },
        ],
      };

    case "summarize_topic": {
      const topic = String(args.topic ?? "").trim();
      if (!topic) throw new Error("summarize_topic requires a 'topic' argument");
      return {
        description: PROMPTS[1].description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Call the relevant_memories tool with query="${topic}" (max=10).`,
                "",
                "Then synthesize the returned memories into a single coherent summary covering:",
                "",
                "1. What's established / known",
                "2. Open questions or unresolved tensions across the memories",
                "3. Any stale or contradicted claims worth flagging",
                "",
                "Keep it tight — aim for one paragraph per section unless the material is genuinely dense. Cite the source memory names inline as `[memory-name]`.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    case "prepare_handoff": {
      const project = String(args.project ?? "").trim();
      const filterClause = project
        ? `filtered to project memories matching "${project}"`
        : "across all project memories";
      return {
        description: PROMPTS[2].description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Generate a project handoff document ${filterClause}.`,
                "",
                project
                  ? `Start by calling list_memories with type="project", then filter the results by substring match against "${project}".`
                  : `Start by calling list_memories with type="project" to get the full set.`,
                "",
                "For each relevant memory, call get_memory to load its full body. Then produce a single handoff document with these sections:",
                "",
                "## Current state",
                "What's in flight or recently shipped, distilled from project memories.",
                "",
                "## Open items",
                "Anything explicitly noted as pending, waiting, or unresolved.",
                "",
                "## Watch-outs",
                "Constraints, deadlines, or hidden gotchas captured in memory.",
                "",
                "## Reference material",
                "Links and external resources the next person should know about (from reference memories if they're relevant to the project).",
                "",
                "Cite source memories inline as `[memory-name]`. Keep prose dense; this is meant to be read by an experienced operator, not explained from scratch.",
              ].join("\n"),
            },
          },
        ],
      };
    }

    case "audit_stale":
      return {
        description: PROMPTS[3].description,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                'Call list_memories with type="project", then list_memories with type="reference". For each memory returned, evaluate whether its claims are likely still true based on:',
                "",
                "- Dates in the body (anything more than 30 days old in a `project` memory deserves scrutiny)",
                "- References to people, dependencies, or systems that may have changed",
                "- Claims about external state (URLs, dashboards, APIs) that you can't verify without external access",
                "",
                "Produce a triage list with three buckets:",
                "",
                "**Likely stale** (high confidence they're outdated) — explain why, suggest action.",
                "**Worth verifying** (claims you can't evaluate without external access) — suggest using the verify_memory tool.",
                "**Still fresh** (nothing in the content suggests staleness).",
                "",
                "Be conservative on the 'likely stale' bucket — false positives there create work for the operator.",
              ].join("\n"),
            },
          },
        ],
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
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
            enum: ["user", "feedback", "project", "reference", "rule"],
            description:
              "Memory type: user (about the person), feedback (lessons + corrections), project (state/context), reference (external pointers), rule (constraint enforced via companion files — prefer the save_rule tool which validates rule-specific fields)",
          },
          content: {
            type: "string",
            description:
              "Markdown body. For feedback/project, include **Why:** and **How to apply:** lines.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional tags for cross-cutting categorization. Lowercase, kebab/underscore, max 40 chars each. Queryable in list_memories + search_memories.",
          },
        },
        required: ["name", "description", "type", "content"],
      },
    },
    {
      name: "search_memories",
      description:
        "Fuzzy search across name, description, and body. Tolerates typos, word-order shifts, and partial matches. Returns top matches with relevance scores (0-100) and body-context snippets. Use this for human-readable browsing.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to look for. Fuzzy match (typo-tolerant).",
          },
          limit: { type: "number", description: "Max results to return (default 10)." },
        },
        required: ["query"],
      },
    },
    {
      name: "relevant_memories",
      description:
        "Find memories relevant to a query and return their FULL content (not summaries). Designed for LLM ingestion — call this when the assistant needs context on a topic and the memory index alone isn't specific enough. Returns up to `max` memories as a markdown document.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The topic the assistant needs context on." },
          max: {
            type: "number",
            description: "Max memories to include (default 5, capped at 20).",
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
      description: "List stored memories, optionally filtered by type and/or tags. Paginated.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["user", "feedback", "project", "reference"],
            description: "Optional filter — only list memories of this type",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional tag filter — memories must have ALL listed tags (intersection). Can also be passed as a comma-separated string.",
          },
          offset: { type: "number", description: "Skip this many results (default 0)." },
          limit: { type: "number", description: "Max results per page (default 50)." },
        },
      },
    },
    {
      name: "delete_memory",
      description:
        "Move a memory to .trash/ (soft delete). The file is removed from the index but recoverable via restore_memory until you manually empty .trash/.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The memory's name slug" },
        },
        required: ["name"],
      },
    },
    {
      name: "restore_memory",
      description:
        "Restore a memory from .trash/ back into the active store. Picks the most recent trash entry for the name.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The memory's name slug" },
        },
        required: ["name"],
      },
    },
    {
      name: "doctor",
      description:
        "Check storage integrity. Reports orphan files (on disk but not indexed), dangling index entries (no file), unreadable files, and invalid types. Pass rebuild-index=true to reconstruct MEMORY.md from disk.",
      inputSchema: {
        type: "object",
        properties: {
          "rebuild-index": {
            type: "boolean",
            description: "If true, rewrite MEMORY.md to match what's on disk.",
          },
        },
      },
    },
    {
      name: "stats",
      description:
        "Dashboard of memory-store state: counts per type, total size, largest memory, audit-log size, trash count.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "log_events",
      description:
        "Read recent entries from the audit event log (.events.jsonl). Returns the last N events, optionally filtered by action.",
      inputSchema: {
        type: "object",
        properties: {
          tail: { type: "number", description: "How many recent events to return (default 20)" },
          action: {
            type: "string",
            description: "Filter by action (save | delete | restore)",
          },
        },
      },
    },
    {
      name: "verify_memory",
      description:
        "Re-evaluate a memory's claims against signals in its content. Extracts URLs, dates, and file paths from the body; flags stale-date signals on project-type memories; returns type-specific verification heuristics for the LLM or operator to act on. Pairs with the audit_stale prompt.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The memory's name slug" },
        },
        required: ["name"],
      },
    },
    {
      name: "find_backlinks",
      description:
        "List memories that link to the given memory via [[wiki-link]] syntax in their bodies. Useful for building a 'what references this' view.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The memory's name slug" },
        },
        required: ["name"],
      },
    },
    {
      name: "find_related",
      description:
        "Surface memories related to a given one. Ranks by combining: outbound [[wiki-links]], inbound backlinks, shared tags, same type, and content similarity (name + description). Use this to navigate the memory graph by association rather than by exact lookup.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The starting memory's name slug" },
          max: {
            type: "number",
            description: "Max related memories to return (default 8, capped at 20).",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "sync_status",
      description:
        "Report the git-sync state of the memory store: remote URL, branch, local uncommitted files, commits ahead/behind origin. Use this before opening a new session to know if you have stale memories from another machine.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sync_push",
      description:
        "Commit any local memory changes and push to the configured git remote. Auto-generates a timestamped commit message if none provided. Use at the end of a session to make memories available on your other machines.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Optional commit message. Defaults to a timestamp.",
          },
        },
      },
    },
    {
      name: "sync_pull",
      description:
        "Pull memory updates from the configured git remote (fast-forward only). Run at the start of a session to get memories saved on other machines. Refuses to pull if there are uncommitted local changes.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "save_rule",
      description:
        "Save (or update) a rule memory · the 'memory as constraint' wedge. " +
        "Rules constrain agent behavior, not just store facts. Severity 'hard' = " +
        "must obey; 'soft' = prefer to obey. Rules auto-project out to AGENTS.md " +
        "(read by Claude Code, Codex CLI, Cursor, Aider, Devin, Copilot, Gemini CLI, " +
        "Windsurf, and Amazon Q natively) when AGENT_MEMORY_AUTO_EMIT_DIR is set, or " +
        "via the emit_companions tool on demand.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Short kebab-case slug, 1-80 chars (e.g. 'no-emojis-ever', 'tests-before-commit')",
          },
          description: {
            type: "string",
            description: "One-line summary of what the rule constrains",
          },
          content: {
            type: "string",
            description:
              "Markdown body. Lead with the rule itself, then **Why:** and **How to apply:** lines.",
          },
          severity: {
            type: "string",
            enum: ["hard", "soft"],
            description:
              "hard = must obey (rule violations are blocked when enforced); soft = prefer to obey (warned but allowed). Defaults to soft.",
          },
          scope: {
            type: "array",
            items: { type: "string" },
            description:
              "Where this rule applies. Examples: ['global'], ['project:prefixcheck'], ['tool:git'].",
          },
          applies_when: {
            type: "array",
            items: { type: "string" },
            description:
              "Natural-language conditions for when the rule triggers. Used by Sampling-enriched check_action on supporting clients.",
          },
          matches: {
            type: "array",
            items: { type: "string" },
            description:
              "Regex patterns that deterministically signal a violation. Used by Tier-1 check_action on every client.",
          },
          enforce_on: {
            type: "array",
            items: { type: "string" },
            description:
              "Action categories this rule constrains. Examples: 'file_writes', 'commits', 'pushes', 'chat_responses'.",
          },
          last_verified: {
            type: "string",
            description: "ISO date (YYYY-MM-DD) of last verification. Defaults to today.",
          },
        },
        required: ["name", "description", "content"],
      },
    },
    {
      name: "list_rules",
      description:
        "List every active rule memory with severity, scope, and staleness markers (>90 days since last_verified). Use this to audit which rules are currently constraining the agent.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "emit_companions",
      description:
        "Regenerate companion rule files from the current rule memories. " +
        "Writes one or more of: AGENTS.md (universal cross-tool standard, Linux Foundation), " +
        "CLAUDE.md (Claude Code's 5-level hierarchy), .cursor/rules/*.mdc (Cursor's MDC format · hard rules get alwaysApply:true, soft rules become description-driven), " +
        ".gemini/instructions.md (Gemini CLI). " +
        "Default writes ALL four targets. Use `targets` to filter. Output dir resolves from `out_dir`, then AGENT_MEMORY_COMPANION_DIR env, then process.cwd().",
      inputSchema: {
        type: "object",
        properties: {
          out_dir: {
            type: "string",
            description:
              "Optional output directory. Defaults to AGENT_MEMORY_COMPANION_DIR env, then process.cwd().",
          },
          targets: {
            type: "array",
            items: {
              type: "string",
              enum: ["agents", "claude", "cursor", "gemini"],
            },
            description:
              "Which companion files to emit. Omit (or pass empty) to emit all four. Examples: ['agents'] for AGENTS.md only, ['claude','cursor'] for Claude Code + Cursor.",
          },
        },
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
      case "relevant_memories":
        result = toolRelevantMemories(args);
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
      case "restore_memory":
        result = toolRestoreMemory(args);
        break;
      case "doctor":
        result = toolDoctor(args);
        break;
      case "stats":
        result = toolStats(args);
        break;
      case "log_events":
        result = toolLogEvents(args);
        break;
      case "verify_memory":
        result = toolVerifyMemory(args);
        break;
      case "find_backlinks":
        result = toolFindBacklinks(args);
        break;
      case "find_related":
        result = toolFindRelated(args);
        break;
      case "sync_status":
        result = toolSyncStatus(args);
        break;
      case "sync_push":
        result = toolSyncPush(args);
        break;
      case "sync_pull":
        result = toolSyncPull(args);
        break;
      case "save_rule":
        result = toolSaveRule(args);
        break;
      case "list_rules":
        result = toolListRules(args);
        break;
      case "emit_companions":
        result = toolEmitCompanions(args);
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
  "relevant",
  "get",
  "list",
  "delete",
  "restore",
  "doctor",
  "stats",
  "log",
  "verify",
  "backlinks",
  "related",
  "sync",
  "save-rule",
  "list-rules",
  "emit-companions",
  "ui",
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
          tags: flags.tags,
        });
        process.stdout.write(result + "\n");
        return 0;
      }
      case "search": {
        const query = positional[0];
        if (!query) throw new Error("Usage: agent-memory search <query> [--limit N]");
        process.stdout.write(
          toolSearchMemories({
            query,
            limit: flags.limit ? Number(flags.limit) : undefined,
          }) + "\n",
        );
        return 0;
      }
      case "relevant": {
        const query = positional[0];
        if (!query) throw new Error("Usage: agent-memory relevant <query> [--max N]");
        process.stdout.write(
          toolRelevantMemories({
            query,
            max: flags.max ? Number(flags.max) : undefined,
          }) + "\n",
        );
        return 0;
      }
      case "get": {
        const name = positional[0];
        if (!name) throw new Error("Usage: agent-memory get <name>");
        process.stdout.write(toolGetMemory({ name }) + "\n");
        return 0;
      }
      case "list": {
        process.stdout.write(
          toolListMemories({
            type: flags.type,
            tags: flags.tags,
            offset: flags.offset ? Number(flags.offset) : undefined,
            limit: flags.limit ? Number(flags.limit) : undefined,
          }) + "\n",
        );
        return 0;
      }
      case "delete": {
        const name = positional[0];
        if (!name) throw new Error("Usage: agent-memory delete <name>");
        process.stdout.write(toolDeleteMemory({ name }) + "\n");
        return 0;
      }
      case "restore": {
        const name = positional[0];
        if (!name) throw new Error("Usage: agent-memory restore <name>");
        process.stdout.write(toolRestoreMemory({ name }) + "\n");
        return 0;
      }
      case "doctor": {
        process.stdout.write(
          toolDoctor({ "rebuild-index": Boolean(flags["rebuild-index"]) }) + "\n",
        );
        return 0;
      }
      case "stats": {
        process.stdout.write(toolStats({}) + "\n");
        return 0;
      }
      case "verify": {
        const name = positional[0];
        if (!name) throw new Error("Usage: agent-memory verify <name>");
        process.stdout.write(toolVerifyMemory({ name }) + "\n");
        return 0;
      }
      case "backlinks": {
        const name = positional[0];
        if (!name) throw new Error("Usage: agent-memory backlinks <name>");
        process.stdout.write(toolFindBacklinks({ name }) + "\n");
        return 0;
      }
      case "related": {
        const name = positional[0];
        if (!name) throw new Error("Usage: agent-memory related <name> [--max N]");
        process.stdout.write(
          toolFindRelated({
            name,
            max: flags.max ? Number(flags.max) : undefined,
          }) + "\n",
        );
        return 0;
      }
      case "sync": {
        const sub = positional[0];
        if (!sub) {
          throw new Error(
            "Usage: agent-memory sync <init|push|pull|status|log>\n" +
              "  init <remote-url>       set up a new memory-sync repo\n" +
              "  push [--message X]      commit + push local changes\n" +
              "  pull                    fast-forward pull from remote\n" +
              "  status                  show local + remote state\n" +
              "  log [--limit N]         recent sync commit history",
          );
        }
        switch (sub) {
          case "init":
            process.stdout.write(toolSyncInit({ remote: positional[1] }) + "\n");
            return 0;
          case "push":
            process.stdout.write(toolSyncPush({ message: flags.message }) + "\n");
            return 0;
          case "pull":
            process.stdout.write(toolSyncPull({}) + "\n");
            return 0;
          case "status":
            process.stdout.write(toolSyncStatus({}) + "\n");
            return 0;
          case "log":
            process.stdout.write(
              toolSyncLog({ limit: flags.limit ? Number(flags.limit) : undefined }) + "\n",
            );
            return 0;
          default:
            throw new Error(`Unknown sync subcommand: ${sub}. Try 'sync' for help.`);
        }
      }
      case "log": {
        process.stdout.write(
          toolLogEvents({
            tail: flags.tail ? Number(flags.tail) : undefined,
            action: flags.action ? String(flags.action) : undefined,
          }) + "\n",
        );
        return 0;
      }
      case "save-rule": {
        const name = positional[0];
        if (!name)
          throw new Error(
            "Usage: agent-memory save-rule <name> --description <d> [--severity hard|soft] " +
              "[--scope a,b,c] [--applies-when a,b] [--matches a,b] [--enforce-on a,b] " +
              "[--content <c> | --content-file <path> | --stdin]",
          );
        let content = String(flags.content ?? "");
        if (flags["content-file"]) {
          content = readFileSync(String(flags["content-file"]), "utf8");
        } else if (flags.stdin) {
          content = await readStdin();
        }
        const csv = (v: unknown): string[] | undefined => {
          if (typeof v !== "string" || v.trim().length === 0) return undefined;
          return v
            .split(",")
            .map((x) => x.trim())
            .filter((x) => x.length > 0);
        };
        const result = toolSaveRule({
          name,
          description: String(flags.description ?? ""),
          content,
          severity: String(flags.severity ?? "soft"),
          scope: csv(flags.scope),
          applies_when: csv(flags["applies-when"]),
          matches: csv(flags.matches),
          enforce_on: csv(flags["enforce-on"]),
          last_verified: flags["last-verified"] ? String(flags["last-verified"]) : undefined,
        });
        process.stdout.write(result + "\n");
        return 0;
      }
      case "list-rules": {
        process.stdout.write(toolListRules({}) + "\n");
        return 0;
      }
      case "emit-companions": {
        const out = flags.out ? String(flags.out) : undefined;
        const target = flags.target;
        let targets: string[] | undefined;
        if (typeof target === "string" && target.length > 0) {
          targets = target
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        }
        process.stdout.write(toolEmitCompanions({ out_dir: out, targets }) + "\n");
        return 0;
      }
      case "ui": {
        // Dynamic import so Ink + React only load when the TUI runs,
        // keeping cold-start fast for MCP server + every other CLI command.
        const { runTui } = await import("./tui.js");
        await runTui();
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
  save <name> --type <t> --description <d> --content <c> [--tags "a,b,c"]
                                           Save or update a memory.
                                           Type: user | feedback | project | reference
                                           Content sources: --content "..." | --content-file <path> | --stdin
                                           Tags: comma-separated, lowercase, max 40 chars each.
  search <query> [--limit N]               Fuzzy search (typo-tolerant), top N (default 10)
  relevant <query> [--max N]               Top N matches as full markdown for LLM ingestion
  get <name>                               Print one memory's full contents
  list [--type <t>] [--tags "a,b"] [--offset N] [--limit N]
                                           List memories (paginated, default limit 50)
                                           Tag filter requires ALL listed tags (intersection).
  delete <name>                            Soft-delete: move to .trash/, removable later
  restore <name>                           Restore the most recent trash entry for <name>
  doctor [--rebuild-index]                 Check storage integrity (orphans, dangling
                                           index entries, unreadable files). With
                                           --rebuild-index, regenerates MEMORY.md from disk.
  stats                                    Dashboard: counts per type, sizes, audit/trash counts.
  log [--tail N] [--action save|delete|restore]
                                           Recent audit-log entries.
  verify <name>                            Re-evaluate a memory's claims (URLs, dates, file refs,
                                           type-specific staleness heuristics). Static analysis;
                                           no network calls.
  backlinks <name>                         List memories that link to <name> via [[wiki-links]].
  related <name> [--max N]                 Surface related memories via outbound + inbound links,
                                           shared tags, type match, content similarity.
  sync <init|push|pull|status|log>         Multi-machine memory via git remote.
    sync init <remote-url>                   Initialize .agent-memory/ as a git repo + push.
    sync push [--message X]                  Commit local changes + push to remote.
    sync pull                                Fast-forward pull from remote.
    sync status                              Show local + ahead/behind state.
    sync log [--limit N]                     Recent sync commit history.
  ui                                       Launch the TUI · browse, filter, search, edit memories
                                           in a clean terminal interface (Ink-based).
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

// Only auto-run main() when invoked directly. Importing this file
// (e.g. from src/tui.tsx) should not trigger the dispatch.
const isEntryPoint = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
