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
  CreateMessageResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Fuse from "fuse.js";
import matter from "gray-matter";
import { spawnSync } from "node:child_process";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
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
// Per-machine ledger of already-used receipt ids (single-use enforcement).
const CONSUMED_RECEIPTS_FILE = join(MEMORY_DIR, ".consumed-receipts.jsonl");
// Rotate the append-only event log past this size so it never grows unbounded.
const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;
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
    // Rotate when the log grows past the cap so it never grows without bound.
    // Keeps one previous generation (.events.jsonl.1); best-effort.
    try {
      if (existsSync(EVENT_LOG) && statSync(EVENT_LOG).size > EVENT_LOG_MAX_BYTES) {
        renameSync(EVENT_LOG, `${EVENT_LOG}.1`);
      }
    } catch {
      /* rotation is best-effort; never block the event write */
    }
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
  // Unique tmp name (pid + random) so concurrent writers — even within the
  // same process — never collide on the temp file before the atomic rename.
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
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

/**
 * js-yaml (gray-matter's parser) auto-coerces ISO-8601 date strings into
 * JavaScript Date objects unless quoted. Normalize to YYYY-MM-DD string
 * regardless of whether the YAML gave us a string or a Date.
 */
function parseLastVerified(input: unknown): string | undefined {
  if (input instanceof Date) {
    return input.toISOString().slice(0, 10);
  }
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  return undefined;
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
    last_verified: parseLastVerified(fm.last_verified),
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

// Lightweight stopwords so token-overlap ranking keys on meaningful words.
const STOPWORDS = new Set(
  "the and or but if then this that these those is are was were be been being do does did have has had how what when where why who which you your our they them my me about can could should would will just not yes for with from".split(
    " ",
  ),
);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t),
  );
}

/**
 * Hybrid lexical ranking: Fuse (typo-tolerant precision) blended with
 * query/body token overlap (recall for reworded queries that share keywords
 * but not exact strings). Surfaces anything with real signal — fixes the case
 * where Fuse alone returns nothing for a paraphrase.
 */
function lexicalRank(
  query: string,
  memories: Memory[],
  max: number,
): Array<{ m: Memory; score: number }> {
  const qTokens = new Set(tokenize(query));
  const fuse = buildFuse(memories);
  const fuseScore = new Map<string, number>();
  for (const r of fuse.search(query)) fuseScore.set(r.item.name, 1 - (r.score ?? 1));

  return memories
    .map((m) => {
      const mset = new Set(tokenize(`${m.name} ${m.description} ${m.body}`));
      let overlap = 0;
      for (const t of qTokens) if (mset.has(t)) overlap++;
      const overlapScore = qTokens.size > 0 ? overlap / qTokens.size : 0;
      const fs = fuseScore.get(m.name) ?? 0;
      return { m, score: Math.min(1, fs * 0.6 + overlapScore * 0.6), overlap, fs };
    })
    .filter((s) => s.fs > 0.2 || s.overlap >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ m, score }) => ({ m, score }));
}

// ---- opt-in semantic recall via a local embeddings endpoint (Ollama) ----
// Set AGENT_MEMORY_EMBED_MODEL (e.g. "nomic-embed-text"); optional
// AGENT_MEMORY_EMBED_URL (default http://localhost:11434). Vectors are cached
// on disk per (model, content-hash) so re-ranking is cheap. Falls back to the
// lexical ranker silently when unset or the endpoint is unreachable.
const EMBED_DIR = join(MEMORY_DIR, ".embeddings");

async function embed(text: string, model: string): Promise<number[] | null> {
  const base = (process.env.AGENT_MEMORY_EMBED_URL ?? "http://localhost:11434").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { embedding?: number[] };
    return Array.isArray(j.embedding) && j.embedding.length > 0 ? j.embedding : null;
  } catch {
    return null;
  }
}

async function embedMemoryCached(m: Memory, model: string): Promise<number[] | null> {
  const key = createHash("sha256")
    .update(model)
    .update("\0")
    .update(m.description)
    .update(m.body)
    .digest("hex")
    .slice(0, 16);
  const dir = join(EMBED_DIR, model.replace(/[^a-z0-9._-]/gi, "_"));
  const fp = join(dir, `${m.name}.json`);
  if (existsSync(fp)) {
    try {
      const cached = JSON.parse(readFileSync(fp, "utf8")) as { key?: string; vec?: number[] };
      if (cached.key === key && Array.isArray(cached.vec)) return cached.vec;
    } catch {
      /* recompute */
    }
  }
  const vec = await embed(`${m.description}\n\n${m.body}`, model);
  if (!vec) return null;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWriteFile(fp, JSON.stringify({ key, vec }));
  } catch {
    /* cache is best-effort */
  }
  return vec;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function embedRank(
  query: string,
  memories: Memory[],
  max: number,
): Promise<Array<{ m: Memory; score: number }> | null> {
  const model = process.env.AGENT_MEMORY_EMBED_MODEL;
  if (!model) return null;
  const qv = await embed(query, model);
  if (!qv) return null; // endpoint down → caller falls back to lexical
  const scored: Array<{ m: Memory; score: number }> = [];
  for (const m of memories) {
    const mv = await embedMemoryCached(m, model);
    if (mv) scored.push({ m, score: cosine(qv, mv) });
  }
  if (scored.length === 0) return null;
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .filter((s) => s.score > 0.25);
}

async function toolRelevantMemories(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("query is required");
  const max = args.max ? Math.max(1, Math.min(20, Number(args.max))) : 5;

  const names = listMemoryFiles();
  const memories = names.map((n) => readMemory(n)).filter((m): m is Memory => m !== null);
  if (memories.length === 0) return "No memories available.";

  // Opt-in semantic ranking when an embeddings endpoint is configured;
  // otherwise (and on any failure) the hybrid lexical ranker.
  let ranked = await embedRank(query, memories, max);
  const method = ranked ? "semantic" : "lexical";
  if (!ranked) ranked = lexicalRank(query, memories, max);

  if (ranked.length === 0) return `No memories relevant to "${query}".`;

  const sections: string[] = [`# Memories relevant to "${query}" · ${method}\n`];
  for (const { m, score } of ranked) {
    sections.push(`## ${m.name} · [${m.type}] · relevance ${Math.round(score * 100)}%`);
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

  // v0.12.0 · receipt REQUIRED for delete_memory. The v0.11.x back-compat
  // path (delete without receipt) is removed. Callers MUST first call
  // check_action({action_type: 'deletions'}) to obtain a fresh receipt,
  // then pass it to delete_memory as the `receipt` argument.
  const receipt = parseReceiptArg(args.receipt);
  if (!receipt) {
    logEvent("delete_refused_no_receipt", { name });
    throw new Error(
      `delete_memory refused · receipt required (v0.12.0+). ` +
        `Call check_action({action: 'delete memory ${name}', action_type: 'deletions'}) ` +
        `first, then pass the issued receipt as the 'receipt' argument to delete_memory.`,
    );
  }
  const v = validateReceipt(receipt, {
    required_caveats: [
      { type: "action_type", value: "deletions" },
      // Bind the receipt to deleting THIS memory — not just "some deletion".
      // Without this, a receipt minted for "delete memory A" could delete B.
      { type: "action_hash", value: deletionActionHash(name) },
    ],
  });
  if (!v.valid) {
    logEvent("delete_denied", { name, reason: v.reason, receipt_id: receipt.id });
    throw new Error(
      `delete_memory refused · receipt invalid (${v.reason}). ` +
        `Call check_action({action: 'delete memory ${name}', action_type: 'deletions'}) ` +
        `to get a fresh receipt bound to this memory.`,
    );
  }

  return withLock(() => {
    // Single-use · reject a receipt that already deleted something (replay).
    // Checked + consumed inside the lock so two callers can't double-spend one.
    if (isReceiptConsumed(receipt.id)) {
      logEvent("delete_denied", { name, reason: "receipt already used", receipt_id: receipt.id });
      throw new Error(
        `delete_memory refused · receipt ${receipt.id} was already used. ` +
          `Receipts are single-use — call check_action again for a fresh one.`,
      );
    }
    // Re-check existence inside the lock (it may have moved since the early check).
    if (!existsSync(fp)) return `Memory "${name}" not found.`;
    ensureTrash();
    // Trash filename: <unix-ms>-<name>.md so restore can pick the
    // most recent version and the operator can see when it was binned.
    const ts = Date.now();
    const trashPath = join(TRASH_DIR, `${ts}-${name}.md`);
    renameSync(fp, trashPath);
    removeIndexEntryUnlocked(name);
    consumeReceipt(receipt.id, receipt.expires_at);
    logEvent("delete_approved_via_receipt", { name, receipt_id: receipt.id });
    logEvent("delete", { name, trash: `${ts}-${name}.md`, gated: true });
    log("debug", "delete_memory", { name });
    return `Moved "${name}" to trash (gated by receipt ${receipt.id}). Restore with: agent-memory restore ${name}`;
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
  keyringTracked: boolean; // SECURITY · signing secret committed to git
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

  // SECURITY · if the store is a git repo, the signing key must never be tracked.
  let keyringTracked = false;
  try {
    if (isGitRepo()) {
      const tracked = git(["ls-files", ".keyring"]);
      keyringTracked = tracked.exitCode === 0 && tracked.stdout.trim().length > 0;
    }
  } catch {
    /* best-effort — doctor never throws on the git probe */
  }

  return {
    storageDir: MEMORY_DIR,
    diskFiles,
    indexEntries: indexNames,
    orphans,
    dangling,
    unreadable,
    invalidType,
    keyringTracked,
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

  // SECURITY warning takes priority — surfaced regardless of index issues.
  if (r.keyringTracked) {
    lines.push(c(ANSI.red, "⚠ SECURITY · .keyring is tracked by git — the receipt-signing"));
    lines.push("  secret may be committed/pushed; anyone with repo access can forge receipts.");
    lines.push("  Fix: `agent-memory sync push` (auto-untracks it) + purge it from git history,");
    lines.push("  then `agent-memory rotate-key` to invalidate the exposed key.");
    lines.push("");
  }

  const issueCount =
    r.orphans.length + r.dangling.length + r.unreadable.length + r.invalidType.length;
  if (issueCount === 0) {
    lines.push(
      r.keyringTracked
        ? "No index issues · but resolve the SECURITY warning above."
        : "OK · no issues found",
    );
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

  // Reject match patterns that won't compile or that risk catastrophic
  // backtracking (ReDoS). Failing fast here keeps a dangerous rule out of the
  // store; checkActionAgainstRules also defends at execution time for rules
  // that arrive by hand-edit / import / federation.
  if (matches) {
    for (const pat of matches) {
      if (!isRegexSafe(pat)) {
        throw new Error(
          `Unsafe regex in matches: ${JSON.stringify(pat)}. It risks catastrophic ` +
            `backtracking (ReDoS) — avoid nested unbounded quantifiers like (a+)+ or (.*)*. ` +
            `Rewrite it in a bounded form and try again.`,
        );
      }
      try {
        new RegExp(pat, "i");
      } catch (e) {
        throw new Error(
          `Invalid regex in matches: ${JSON.stringify(pat)} · ${(e as Error).message}`,
        );
      }
    }
  }

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
const ED25519_PRIV_FILE = join(KEYRING_DIR, "ed25519.priv");
const ED25519_PUB_FILE = join(KEYRING_DIR, "ed25519.pub");
const RECEIPT_DEFAULT_TTL_SECONDS = 60;

/**
 * Signing-mode selector. CRP 1.0 = HMAC-SHA256 with shared symmetric secret.
 * CRP 1.1 = Ed25519 asymmetric · enables cross-server federation (validators
 * verify with the issuer's public key, no shared secret needed). Set via
 * the `CRP_SIGNING_MODE` env var. Default stays `hmac` for back-compat.
 */
const CRP_SIGNING_MODE: "hmac" | "ed25519" =
  process.env.CRP_SIGNING_MODE === "ed25519" ? "ed25519" : "hmac";

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
  /** Hex-encoded signature. HMAC-SHA256 (64 hex chars) for CRP 1.0, Ed25519 (128 hex chars) for CRP 1.1. */
  signature: string;
  /** Optional CRP version. Absent or "1.0" → HMAC. "1.1" → Ed25519. */
  version?: "1.0" | "1.1";
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
 * Load or lazily create the Ed25519 keypair for CRP 1.1 receipts. Private
 * key (PEM, mode 0o600) signs · public key (PEM, mode 0o644) verifies and
 * can be shared with other MCP servers for federation. The public key
 * is exportable via the `agent-memory export-pubkey` CLI command.
 */
function loadOrCreateEd25519Keys(): { privateKeyPem: string; publicKeyPem: string } {
  if (!existsSync(KEYRING_DIR)) {
    mkdirSync(KEYRING_DIR, { recursive: true });
  }
  if (existsSync(ED25519_PRIV_FILE) && existsSync(ED25519_PUB_FILE)) {
    return {
      privateKeyPem: readFileSync(ED25519_PRIV_FILE, "utf8"),
      publicKeyPem: readFileSync(ED25519_PUB_FILE, "utf8"),
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const pubPem = publicKey.export({ format: "pem", type: "spki" }) as string;
  writeFileSync(ED25519_PRIV_FILE, privPem, { mode: 0o600 });
  writeFileSync(ED25519_PUB_FILE, pubPem, { mode: 0o644 });
  return { privateKeyPem: privPem, publicKeyPem: pubPem };
}

/**
 * Export the Ed25519 public key (PEM) for sharing with other servers.
 * Returns null when CRP 1.1 hasn't been initialized yet · the keypair is
 * created lazily on first Ed25519 receipt issuance.
 */
export function exportEd25519PublicKey(): string | null {
  if (!existsSync(ED25519_PUB_FILE)) return null;
  return readFileSync(ED25519_PUB_FILE, "utf8");
}

/**
 * Rotate the receipt-signing key material. Overwrites the HMAC key (and, when
 * present or explicitly requested, the Ed25519 keypair) with freshly generated
 * secrets. This is the correct response to a suspected key leak: every
 * outstanding receipt was signed with the old key, so all of them immediately
 * stop verifying. Returns the list of rotated artifacts.
 */
export function rotateSigningKeys(mode: "hmac" | "ed25519" | "both" = "both"): string[] {
  if (!existsSync(KEYRING_DIR)) mkdirSync(KEYRING_DIR, { recursive: true });
  const rotated: string[] = [];
  if (mode === "hmac" || mode === "both") {
    writeFileSync(HMAC_KEY_FILE, randomBytes(32), { mode: 0o600 });
    rotated.push("hmac-key");
  }
  if (mode === "ed25519" || (mode === "both" && existsSync(ED25519_PRIV_FILE))) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(
      ED25519_PRIV_FILE,
      privateKey.export({ format: "pem", type: "pkcs8" }) as string,
      {
        mode: 0o600,
      },
    );
    writeFileSync(ED25519_PUB_FILE, publicKey.export({ format: "pem", type: "spki" }) as string, {
      mode: 0o644,
    });
    rotated.push("ed25519-keypair");
  }
  return rotated;
}

function toolRotateKey(args: Record<string, unknown>): string {
  const modeArg = String(args.mode ?? "both").trim();
  const mode = modeArg === "hmac" || modeArg === "ed25519" ? modeArg : "both";
  const rotated = rotateSigningKeys(mode);
  // Old receipt ids can never be re-presented (their signatures are dead), so
  // the single-use ledger is moot — clear it to reclaim the space.
  try {
    if (existsSync(CONSUMED_RECEIPTS_FILE))
      renameSync(CONSUMED_RECEIPTS_FILE, `${CONSUMED_RECEIPTS_FILE}.bak`);
  } catch {
    /* best-effort */
  }
  logEvent("rotate_key", { mode, rotated });
  return (
    `Rotated signing key material: ${rotated.length ? rotated.join(", ") : "(nothing — keyring absent)"}.\n` +
    `⚠ All previously issued Compliance Receipts are now INVALID (signatures no longer verify).\n` +
    `If the old key was ever committed or pushed, also remove it from the remote's history and audit who had access.`
  );
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
  // Field ordering is significant for the signed canonical form. The
  // version field is included only when present so v1.0 and v1.1 receipts
  // produce distinct signatures (preventing version-downgrade attacks).
  const base: Record<string, unknown> = {
    id: r.id,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    rules_version: r.rules_version,
    caveats: sortedCaveats,
  };
  if (r.version) base.version = r.version;
  return JSON.stringify(base);
}

function signReceipt(r: Omit<ComplianceReceipt, "signature">): string {
  const canonical = canonicalizeReceipt(r);
  if (r.version === "1.1") {
    const { privateKeyPem } = loadOrCreateEd25519Keys();
    const privKey = createPrivateKey(privateKeyPem);
    // Ed25519 signs the raw bytes directly (no separate digest); pass null
    // as the algorithm per Node's API contract.
    return cryptoSign(null, Buffer.from(canonical, "utf8"), privKey).toString("hex");
  }
  // Default CRP 1.0 · HMAC-SHA256
  const key = loadOrCreateHmacKey();
  return createHmac("sha256", key).update(canonical).digest("hex");
}

function verifySignature(receipt: ComplianceReceipt): boolean {
  const canonical = canonicalizeReceipt({
    id: receipt.id,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
    rules_version: receipt.rules_version,
    caveats: receipt.caveats,
    version: receipt.version,
  });
  if (receipt.version === "1.1") {
    try {
      const { publicKeyPem } = loadOrCreateEd25519Keys();
      const pubKey = createPublicKey(publicKeyPem);
      return cryptoVerify(
        null,
        Buffer.from(canonical, "utf8"),
        pubKey,
        Buffer.from(receipt.signature, "hex"),
      );
    } catch {
      return false;
    }
  }
  // CRP 1.0 · HMAC-SHA256 with constant-time compare
  const key = loadOrCreateHmacKey();
  const expected = createHmac("sha256", key).update(canonical).digest();
  const actual = Buffer.from(receipt.signature, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export interface IssueReceiptOptions {
  /** Caveats attached to the receipt. Empty array allowed but rare. */
  caveats: Caveat[];
  /** Seconds until expiry · defaults to 60. Receipts SHOULD be short-lived. */
  ttl_seconds?: number;
}

/**
 * Issue a fresh Compliance Receipt with the given caveats. The receipt is
 * bound to the current rule-store hash; any rule edit invalidates it.
 *
 * Signing mode selected by the `CRP_SIGNING_MODE` env var:
 *   - `hmac` (default) · CRP 1.0 · HMAC-SHA256 with a 256-bit shared secret
 *   - `ed25519` · CRP 1.1 · Ed25519 asymmetric · enables cross-server
 *     federation since validators verify with the issuer's public key
 *     without sharing any secret. Public key exportable via the
 *     `agent-memory export-pubkey` CLI command.
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
    ...(CRP_SIGNING_MODE === "ed25519" ? { version: "1.1" as const } : {}),
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
  // 1. Signature verification · routes to HMAC (CRP 1.0) or Ed25519 (CRP 1.1)
  //    based on the receipt's version field. Both paths use constant-time
  //    comparisons internally to avoid timing leaks.
  if (!verifySignature(receipt)) {
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
// Single-use receipt enforcement (replay protection)
// -------------------------------------------------------------
//
// validateReceipt proves a receipt is authentic + unexpired + matches the
// rule set + carries the required caveats — but on its own a receipt is
// reusable for its whole TTL. For destructive ops we additionally require
// each receipt to be used at most once. Consumed ids are persisted to a
// per-machine ledger (jsonl of {id, expires_at}); expired entries are pruned
// on every read so it never grows without bound. The file is gitignored and
// never synced.

function readConsumedReceipts(): Map<string, number> {
  const live = new Map<string, number>();
  if (!existsSync(CONSUMED_RECEIPTS_FILE)) return live;
  const now = Math.floor(Date.now() / 1000);
  for (const line of readFileSync(CONSUMED_RECEIPTS_FILE, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { id?: unknown; expires_at?: unknown };
      if (typeof e.id === "string" && typeof e.expires_at === "number" && e.expires_at >= now) {
        live.set(e.id, e.expires_at);
      }
    } catch {
      // skip malformed line
    }
  }
  return live;
}

function isReceiptConsumed(id: string): boolean {
  return readConsumedReceipts().has(id);
}

/** Mark a receipt id consumed. Rewrites the ledger pruned of expired ids. */
function consumeReceipt(id: string, expiresAt: number): void {
  const live = readConsumedReceipts();
  live.set(id, expiresAt);
  const body = Array.from(live.entries())
    .map(([rid, exp]) => JSON.stringify({ id: rid, expires_at: exp }))
    .join("\n");
  atomicWriteFile(CONSUMED_RECEIPTS_FILE, body ? body + "\n" : "");
}

/**
 * The action-hash a delete receipt MUST carry, computed the same way
 * check_action hashes its `action` (sha256 → first 16 hex) over the exact
 * canonical string the delete_memory guidance instructs callers to use. This
 * binds a receipt to deleting THIS memory: a receipt minted for "delete
 * memory A" cannot be presented to delete memory B.
 */
function deletionActionHash(name: string): string {
  return createHash("sha256").update(`delete memory ${name}`).digest("hex").slice(0, 16);
}

// -------------------------------------------------------------
// check_action · v0.11.3 · the protocol enforcement point
// -------------------------------------------------------------
//
// The "memory as constraint" wedge made operational. Agent proposes
// an action, we check it against the rule store, and either:
//
//   - Approve → return a Compliance Receipt that destructive tools
//     can require before executing (the receipt encodes WHAT was
//     approved + WHEN it was approved + against WHICH rule set).
//   - Deny → return a structured violation listing the rule(s) that
//     blocked the action.
//
// Tier 1 (deterministic, every client): regex/category match against
// rule.matches + rule.enforce_on.
//
// Tier 2 (Sampling-enriched, optional, v0.11.3.x): if the client
// supports MCP Sampling, call back to the LLM for nuanced judgment
// on rule.applies_when natural-language conditions. Deferred to a
// follow-up release; Tier 1 is the load-bearing path.

export interface RuleViolation {
  /** The rule's slug (matches the memory filename). */
  rule: string;
  /** Severity at the time of the match. */
  severity: "hard" | "soft";
  /** Human-readable reason · usually `"matched pattern: '<regex>'"`. */
  reason: string;
}

export interface CheckActionResult {
  approved: boolean;
  /** Receipt returned only when approved (no hard violations). */
  receipt?: ComplianceReceipt;
  /** Hard violations · these block approval. */
  hard_violations: RuleViolation[];
  /** Soft violations · approval still granted but warned. */
  soft_warnings: RuleViolation[];
  /** Number of rules evaluated (for visibility). */
  rules_evaluated: number;
}

/**
 * Reject regex patterns prone to catastrophic backtracking (ReDoS). Heuristic:
 * flags "star height >= 2" — an unbounded quantifier (*, +, {n,}) applied to a
 * group that already contains an unbounded quantifier, e.g. (a+)+, (a*)*, (.*)+.
 * Conservative (may reject some safe-but-deeply-nested patterns) but never
 * accepts a known-dangerous shape. Escaped metacharacters are ignored.
 */
export function isRegexSafe(pattern: string): boolean {
  if (pattern.length > 1000) return false;
  const src = pattern.replace(/\\./g, ""); // drop escaped metachars (\+, \*, \{)
  const groupHasUnbounded: boolean[] = []; // per open group: contains unbounded quantifier?
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") {
      groupHasUnbounded.push(false);
    } else if (ch === ")") {
      const inner = groupHasUnbounded.pop() ?? false;
      const rest = src.slice(i + 1);
      const quantified = rest[0] === "*" || rest[0] === "+" || /^\{\d*,\}/.test(rest);
      if (quantified && inner) return false; // unbounded quantifier over unbounded inner
      if (quantified && groupHasUnbounded.length > 0)
        groupHasUnbounded[groupHasUnbounded.length - 1] = true;
    } else if (ch === "*" || ch === "+") {
      if (groupHasUnbounded.length > 0) groupHasUnbounded[groupHasUnbounded.length - 1] = true;
    } else if (ch === "{") {
      if (/^\{\d*,\}/.test(src.slice(i)) && groupHasUnbounded.length > 0)
        groupHasUnbounded[groupHasUnbounded.length - 1] = true;
    }
  }
  return true;
}

function safeRegex(pattern: string): RegExp | null {
  // Skip ReDoS-prone patterns rather than risk hanging the event loop. These
  // are blocked at save_rule, but a hand-edited / imported / federated rule
  // file can still carry one, so we defend at execution time too.
  if (!isRegexSafe(pattern)) {
    log("warn", "skipping ReDoS-prone rule pattern", { pattern });
    return null;
  }
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * Deterministic rule check. For each type=rule memory:
 *   1. Skip if rule.enforce_on is non-empty and doesn't include actionType.
 *   2. For each pattern in rule.matches, test against the proposed action.
 *   3. If any pattern matches → violation entry.
 * Hard violations block; soft violations warn.
 */
export function checkActionAgainstRules(
  action: string,
  actionType: string,
): {
  hard: RuleViolation[];
  soft: RuleViolation[];
  rules_evaluated: number;
} {
  const rules = loadAllRules();
  const hard: RuleViolation[] = [];
  const soft: RuleViolation[] = [];
  // Cap the tested string · bounds worst-case regex work regardless of pattern.
  const tested = action.length > 4096 ? action.slice(0, 4096) : action;

  for (const rule of rules) {
    // Scope filter · if enforce_on is specified, the action's type must be
    // listed. Empty enforce_on means "applies everywhere".
    if (rule.enforce_on && rule.enforce_on.length > 0) {
      if (!rule.enforce_on.includes(actionType)) continue;
    }

    // No matches array → this rule has no deterministic pattern, only
    // applies_when (Sampling-only). Skip in Tier 1.
    if (!rule.matches || rule.matches.length === 0) continue;

    for (const pat of rule.matches) {
      const re = safeRegex(pat);
      if (!re) continue;
      if (re.test(tested)) {
        const violation: RuleViolation = {
          rule: rule.name,
          severity: rule.severity ?? "soft",
          reason: `matched pattern '${pat}' on action of type '${actionType}'`,
        };
        if (violation.severity === "hard") hard.push(violation);
        else soft.push(violation);
        break; // one match per rule is enough
      }
    }
  }

  return { hard, soft, rules_evaluated: rules.length };
}

/**
 * Tier-2 Sampling enrichment · runs ONE rule's natural-language
 * applies_when conditions past an LLM via MCP sampling/createMessage.
 * The server makes the request; the client decides (per MCP spec)
 * whether to forward to its LLM, prompt the user, or refuse.
 *
 * On any error (client lacks sampling, user refused, unparseable
 * response), returns null — Tier-2 silently degrades to "no extra
 * violations found" and we ship the Tier-1 result.
 */
function clientSupportsSampling(): boolean {
  // server.getClientCapabilities() is undefined before the MCP initialize
  // handshake; once initialized, returns the capabilities the client
  // declared. We only call Sampling if `sampling` is in there — saves a
  // round-trip and prevents test harnesses (which don't respond to
  // sampling/createMessage) from hanging.
  try {
    const caps = server.getClientCapabilities();
    return !!caps?.sampling;
  } catch {
    return false;
  }
}

async function runTier2Sampling(
  rule: Memory,
  action: string,
  actionType: string,
): Promise<RuleViolation | null> {
  if (!rule.applies_when || rule.applies_when.length === 0) return null;
  if (!clientSupportsSampling()) return null;

  const prompt =
    `You are evaluating whether a proposed action violates an operator rule.\n\n` +
    `RULE:\n` +
    `  name: ${rule.name}\n` +
    `  description: ${rule.description}\n` +
    `  severity: ${rule.severity ?? "soft"}\n` +
    `  applies_when:\n` +
    rule.applies_when.map((s) => `    - ${s}`).join("\n") +
    `\n\nPROPOSED ACTION:\n` +
    `  ${action}\n` +
    `  (category: ${actionType})\n\n` +
    `Does the proposed action match any of the "applies_when" conditions?\n` +
    `Respond with strict JSON only, no commentary: {"violates": true|false, "reason": "..."}.\n` +
    `If the action is ambiguous, answer false.`;

  try {
    const result = await server.request(
      {
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text: prompt } }],
          systemPrompt: "You are a strict policy evaluator. Reply with JSON only.",
          maxTokens: 200,
          modelPreferences: { intelligencePriority: 0.8, speedPriority: 0.4 },
        },
      },
      CreateMessageResultSchema,
    );
    const text = result.content.type === "text" ? result.content.text : "";
    // Tolerate a stray code-fence around the JSON.
    const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(cleaned) as { violates?: boolean; reason?: string };
    if (parsed.violates === true) {
      return {
        rule: rule.name,
        severity: rule.severity ?? "soft",
        reason: `Sampling judgment: ${parsed.reason ?? "applies_when matched"}`,
      };
    }
    return null;
  } catch (err) {
    // Sampling unsupported on this client, user refused, response
    // unparseable, or any other transport-level failure. Degrade
    // silently to Tier-1 only · we never block a check_action call
    // because Tier-2 couldn't run.
    log("debug", "tier2_sampling_skipped", {
      rule: rule.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function toolCheckAction(args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? "").trim();
  const actionType = String(args.action_type ?? "").trim();
  const sessionId = typeof args.session_id === "string" ? args.session_id.trim() : "";
  // Tier-2 Sampling is opt-out: defaults to true on clients that support
  // it; gracefully degrades on clients that don't. Set to false to skip
  // the LLM round-trip entirely (e.g. for batched/script use).
  const tier2Enabled = args.use_sampling !== false;

  if (!action) throw new Error("action is required (the proposed action description)");
  if (!actionType)
    throw new Error(
      "action_type is required (e.g. 'deletions', 'commits', 'file_writes', 'chat_responses')",
    );

  const { hard, soft, rules_evaluated } = checkActionAgainstRules(action, actionType);

  // Tier-2: run Sampling for any rule with applies_when that DIDN'T
  // already match deterministically. Rules already flagged in Tier-1
  // don't need a Sampling round-trip (we know they violate).
  if (tier2Enabled) {
    const tier1HitRules = new Set([...hard.map((v) => v.rule), ...soft.map((v) => v.rule)]);
    const rules = loadAllRules();
    const tier2Candidates = rules.filter(
      (r) =>
        r.applies_when &&
        r.applies_when.length > 0 &&
        !tier1HitRules.has(r.name) &&
        (!r.enforce_on || r.enforce_on.length === 0 || r.enforce_on.includes(actionType)),
    );
    for (const rule of tier2Candidates) {
      const violation = await runTier2Sampling(rule, action, actionType);
      if (violation) {
        if (violation.severity === "hard") hard.push(violation);
        else soft.push(violation);
      }
    }
  }

  if (hard.length > 0) {
    const result: CheckActionResult = {
      approved: false,
      hard_violations: hard,
      soft_warnings: soft,
      rules_evaluated,
    };
    logEvent("check_action_denied", {
      proposed_action: action,
      action_type: actionType,
      hard_count: hard.length,
      soft_count: soft.length,
    });
    return JSON.stringify(result, null, 2);
  }

  // Approved · issue a receipt that downstream tools can require.
  const caveats: Caveat[] = [
    { type: "action_type", value: actionType },
    { type: "action_hash", value: createHash("sha256").update(action).digest("hex").slice(0, 16) },
  ];
  if (sessionId) caveats.push({ type: "session", value: sessionId });

  const receipt = issueReceipt({ caveats });
  const result: CheckActionResult = {
    approved: true,
    receipt,
    hard_violations: [],
    soft_warnings: soft,
    rules_evaluated,
  };
  logEvent("check_action_approved", {
    proposed_action: action,
    action_type: actionType,
    receipt_id: receipt.id,
    soft_count: soft.length,
  });
  return JSON.stringify(result, null, 2);
}

/**
 * Parse a receipt argument · accepts either an already-decoded object or
 * a JSON string (the form check_action returns when the agent calls it).
 * Returns null if missing/unparseable.
 */
function parseReceiptArg(input: unknown): ComplianceReceipt | null {
  if (!input) return null;
  if (typeof input === "object") return input as ComplianceReceipt;
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as ComplianceReceipt;
    } catch {
      return null;
    }
  }
  return null;
}

// -------------------------------------------------------------
// audit · v0.11.4 · daily-rhythm operational health command
// -------------------------------------------------------------
//
// Surfaces what's working and what's drifting in the rule store:
//   - Rule count, broken down by severity
//   - Stale rules (last_verified > 90 days ago, or never verified)
//   - Pattern conflicts (two rules sharing an enforce_on category AND
//     an identical regex in their matches arrays · likely contradiction)
//   - Recent check_action denials (the system blocked something — was
//     that the right call? is a rule too aggressive?)
//   - Recent unreceipted destructive ops (back-compat path · v0.12 will
//     remove it but for v0.11.x audit just flags them)

const STALE_THRESHOLD_DAYS = 90;
const AUDIT_EVENT_TAIL = 50;

export interface AuditRulesSummary {
  total: number;
  hard: number;
  soft: number;
  no_severity: number;
}

export interface StaleRule {
  name: string;
  last_verified: string | null;
  age_days: number | null;
  description: string;
}

export interface RuleConflict {
  rule_a: string;
  rule_b: string;
  shared_pattern: string;
  shared_enforce_on: string;
}

export interface RecentDenial {
  ts: string;
  action: string;
  action_type: string;
  hard_count: number;
}

export interface UnreceiptedDelete {
  ts: string;
  name: string;
}

export interface AuditReport {
  rules: AuditRulesSummary;
  stale_rules: StaleRule[];
  pattern_conflicts: RuleConflict[];
  recent_denials: RecentDenial[];
  recent_unreceipted_deletes: UnreceiptedDelete[];
  healthy: boolean;
}

function summarizeRules(rules: Memory[]): AuditRulesSummary {
  let hard = 0;
  let soft = 0;
  let noSev = 0;
  for (const r of rules) {
    if (r.severity === "hard") hard++;
    else if (r.severity === "soft") soft++;
    else noSev++;
  }
  return { total: rules.length, hard, soft, no_severity: noSev };
}

function findStaleRules(rules: Memory[], thresholdDays: number): StaleRule[] {
  const now = Date.now();
  const stale: StaleRule[] = [];
  for (const r of rules) {
    if (!r.last_verified) {
      stale.push({
        name: r.name,
        last_verified: null,
        age_days: null,
        description: r.description,
      });
      continue;
    }
    const verifiedAt = new Date(r.last_verified).getTime();
    if (Number.isNaN(verifiedAt)) {
      stale.push({
        name: r.name,
        last_verified: r.last_verified,
        age_days: null,
        description: r.description,
      });
      continue;
    }
    const ageDays = Math.floor((now - verifiedAt) / 86400_000);
    if (ageDays > thresholdDays) {
      stale.push({
        name: r.name,
        last_verified: r.last_verified,
        age_days: ageDays,
        description: r.description,
      });
    }
  }
  return stale;
}

function findPatternConflicts(rules: Memory[]): RuleConflict[] {
  const conflicts: RuleConflict[] = [];
  for (let i = 0; i < rules.length; i++) {
    const a = rules[i];
    if (!a.matches || a.matches.length === 0) continue;
    for (let j = i + 1; j < rules.length; j++) {
      const b = rules[j];
      if (!b.matches || b.matches.length === 0) continue;

      // Need overlap in enforce_on (or both empty → universal)
      const aCategories = a.enforce_on ?? [];
      const bCategories = b.enforce_on ?? [];
      const sharedCategories =
        aCategories.length === 0 || bCategories.length === 0
          ? ["(universal)"]
          : aCategories.filter((c) => bCategories.includes(c));
      if (sharedCategories.length === 0) continue;

      // Need at least one identical pattern · low-false-positive heuristic
      const sharedPatterns = a.matches.filter((p) => b.matches!.includes(p));
      if (sharedPatterns.length === 0) continue;

      for (const cat of sharedCategories) {
        for (const pat of sharedPatterns) {
          conflicts.push({
            rule_a: a.name,
            rule_b: b.name,
            shared_pattern: pat,
            shared_enforce_on: cat,
          });
        }
      }
    }
  }
  return conflicts;
}

function recentDenials(): RecentDenial[] {
  const records = readEventLog({ tail: AUDIT_EVENT_TAIL, action: "check_action_denied" });
  return records.map((r) => ({
    ts: String(r.ts),
    action: String(r.proposed_action ?? ""),
    action_type: String(r.action_type ?? ""),
    hard_count: typeof r.hard_count === "number" ? r.hard_count : 0,
  }));
}

function recentUnreceiptedDeletes(): UnreceiptedDelete[] {
  // v0.11.x emitted "delete_without_receipt" when an unreceipted delete
  // succeeded. v0.12.0 emits "delete_refused_no_receipt" when refusing.
  // We surface BOTH event types so an audit run against pre-v0.12 logs
  // still reports historical unreceipted deletes correctly.
  const records = [
    ...readEventLog({ tail: AUDIT_EVENT_TAIL, action: "delete_without_receipt" }),
    ...readEventLog({ tail: AUDIT_EVENT_TAIL, action: "delete_refused_no_receipt" }),
  ];
  return records.map((r) => ({
    ts: String(r.ts),
    name: String(r.name ?? ""),
  }));
}

export function runAudit(): AuditReport {
  const rules = loadAllRules();
  const stale = findStaleRules(rules, STALE_THRESHOLD_DAYS);
  const conflicts = findPatternConflicts(rules);
  const denials = recentDenials();
  const unreceipted = recentUnreceiptedDeletes();
  return {
    rules: summarizeRules(rules),
    stale_rules: stale,
    pattern_conflicts: conflicts,
    recent_denials: denials,
    recent_unreceipted_deletes: unreceipted,
    healthy: stale.length === 0 && conflicts.length === 0 && unreceipted.length === 0,
  };
}

function formatAuditPretty(r: AuditReport): string {
  const lines: string[] = [];
  lines.push(c(ANSI.bold, "agent-memory audit"));
  lines.push("");
  lines.push(
    `  Rules: ${c(ANSI.bold, String(r.rules.total))}  ` +
      `(${c(ANSI.red, String(r.rules.hard) + " hard")} · ` +
      `${c(ANSI.yellow, String(r.rules.soft) + " soft")} · ` +
      `${r.rules.no_severity} unspecified)`,
  );
  lines.push("");

  if (r.stale_rules.length > 0) {
    lines.push(c(ANSI.yellow, `  ${r.stale_rules.length} stale rule(s):`));
    for (const s of r.stale_rules) {
      const age =
        s.age_days === null
          ? c(ANSI.dim, "(never verified)")
          : c(ANSI.dim, `(${s.age_days}d since last_verified)`);
      lines.push(`    ${s.name}  ${age}`);
      lines.push(`      ${c(ANSI.dim, s.description)}`);
    }
    lines.push("");
  } else {
    lines.push(c(ANSI.green, "  All rules verified within 90 days."));
    lines.push("");
  }

  if (r.pattern_conflicts.length > 0) {
    lines.push(c(ANSI.red, `  ${r.pattern_conflicts.length} pattern conflict(s):`));
    for (const conf of r.pattern_conflicts) {
      lines.push(
        `    ${conf.rule_a} <-> ${conf.rule_b}  ` +
          c(ANSI.dim, `(share pattern '${conf.shared_pattern}' on '${conf.shared_enforce_on}')`),
      );
    }
    lines.push("");
  } else {
    lines.push(c(ANSI.green, "  No pattern conflicts detected."));
    lines.push("");
  }

  if (r.recent_denials.length > 0) {
    lines.push(`  Recent denials (${r.recent_denials.length}):`);
    for (const d of r.recent_denials.slice(-5)) {
      lines.push(
        `    ${c(ANSI.dim, d.ts.slice(0, 19))}  ${d.action_type}  ` +
          c(ANSI.red, `(${d.hard_count} hard violation${d.hard_count === 1 ? "" : "s"})`),
      );
      lines.push(`      ${c(ANSI.dim, d.action)}`);
    }
    lines.push("");
  }

  if (r.recent_unreceipted_deletes.length > 0) {
    lines.push(c(ANSI.yellow, `  ${r.recent_unreceipted_deletes.length} unreceipted delete(s):`));
    for (const u of r.recent_unreceipted_deletes.slice(-5)) {
      lines.push(`    ${c(ANSI.dim, u.ts.slice(0, 19))}  ${u.name}`);
    }
    lines.push(
      c(ANSI.dim, `    (v0.11.x back-compat path; v0.12 will require receipts for delete_memory)`),
    );
    lines.push("");
  }

  lines.push(
    r.healthy
      ? c(ANSI.green, "  HEALTHY · no action required")
      : c(ANSI.yellow, "  ATTENTION · review the items above"),
  );
  return lines.join("\n");
}

function toolAudit(args: Record<string, unknown>): string {
  const json = args.json === true || args.format === "json";
  const report = runAudit();
  return json ? JSON.stringify(report, null, 2) : formatAuditPretty(report);
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
  ".trash/\n" +
  // SECURITY · the keyring holds the receipt-signing secret (HMAC key /
  // Ed25519 private key). It must NEVER be committed or pushed — a leaked
  // key lets anyone forge Compliance Receipts. Excluded from sync always.
  ".keyring/\n" +
  // Single-use receipt ledger is per-machine runtime state, not shared.
  ".consumed-receipts.jsonl\n" +
  // Embedding cache is per-machine + model-specific and rebuildable.
  ".embeddings/\n";

/**
 * Defense-in-depth for the sync feature. Rewrites .gitignore to the current
 * policy (so repos created by an older version pick up the `.keyring/`
 * exclusion) and untracks any secret / per-machine file a stale .gitignore
 * may have already committed. `--ignore-unmatch` makes the untrack a no-op
 * when nothing sensitive was ever staged. Call before every `git add`.
 */
function ensureSyncHygiene(): void {
  writeFileSync(join(MEMORY_DIR, ".gitignore"), SYNC_GITIGNORE, "utf8");
  git([
    "rm",
    "-r",
    "--cached",
    "--ignore-unmatch",
    ".keyring",
    ".consumed-receipts.jsonl",
    ".lock",
    ".events.jsonl",
    ".trash",
  ]);
}

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

  ensureSyncHygiene();

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

  // Keep the signing key + per-machine state out of the push (also self-heals
  // repos created before the .keyring exclusion existed).
  ensureSyncHygiene();

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
  { name: "agent-memory", version: "0.13.1" },
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
        "Move a memory to .trash/ (soft delete). The file is removed from the index but recoverable via restore_memory until you manually empty .trash/. " +
        "Receipt REQUIRED and bound to THIS memory: first call check_action({action: 'delete memory <name>', action_type: 'deletions'}) — using that EXACT action string — to obtain a fresh Compliance Receipt, then pass it as `receipt`. " +
        "The receipt must carry {action_type: 'deletions'} AND the matching action_hash for 'delete memory <name>', and is single-use — it cannot be replayed to delete a different memory or the same one twice.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The memory's name slug" },
          receipt: {
            description:
              "REQUIRED · Compliance Receipt (object or JSON string) from check_action with action_type=deletions. Without this, the delete is refused.",
          },
        },
        required: ["name", "receipt"],
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
      name: "rotate_key",
      description:
        "Rotate the receipt-signing key material (HMAC and/or Ed25519). Generates fresh keys and INVALIDATES every outstanding Compliance Receipt. Use after a suspected key leak — e.g. the .keyring was ever committed or synced. Optional `mode`: 'hmac' | 'ed25519' | 'both' (default 'both').",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["hmac", "ed25519", "both"],
            description: "Which key(s) to rotate. Default 'both'.",
          },
        },
      },
    },
    {
      name: "init",
      description:
        "Install a starter guardrail pack — sensible hard/soft rules (protect main, block rm -rf, no prod data destruction, no curl|sh, flag secrets) — and emit them to every tool's companion files. Zero-config protection on day one. Pass force=true to overwrite same-named rules. Pair with `agent-memory install-hooks` so hard rules actually block tool calls.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Overwrite existing starter rules. Default false.",
          },
        },
      },
    },
    {
      name: "validate_receipt",
      description:
        "Validate a CRP 1.1 (Ed25519) Compliance Receipt issued by ANOTHER agent-memory server using that server's published public key — no shared secret (the federation primitive). Checks signature, expiry, and required caveats. Pass `receipt` (object or JSON string) and `public_key` (inline PEM or a file path; the issuer gets theirs via `agent-memory export-pubkey`).",
      inputSchema: {
        type: "object",
        properties: {
          receipt: { description: "The Compliance Receipt to validate (object or JSON string)." },
          public_key: {
            type: "string",
            description: "Issuer's Ed25519 public key · inline PEM or a file path.",
          },
          required_caveats: {
            type: "array",
            description: "Caveats that must be present (each {type, value}).",
          },
        },
        required: ["receipt", "public_key"],
      },
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
      name: "audit",
      description:
        "v0.11.4 · operational health report for the rule store. Surfaces: rule count by severity, stale rules (last_verified > 90 days or null), pattern conflicts (two rules sharing an enforce_on category AND an identical regex pattern), recent check_action denials, and recent unreceipted destructive ops. " +
        "Default returns pretty-printed text; pass {format: 'json'} for structured output. " +
        "Run daily-ish · the report is fast and gives the operator a single view of what's drifting.",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["pretty", "json"],
            description: "Output format. Default 'pretty' (human-readable colored text).",
          },
        },
      },
    },
    {
      name: "check_action",
      description:
        "v0.11.3 · the protocol enforcement point. Pass a proposed action description + its category; the server matches against rule memories (type=rule) and either:\n" +
        "  - APPROVES: returns a short-lived Compliance Receipt (HMAC-signed, 60s default) the agent can pass to destructive tools (e.g. delete_memory) as proof of compliance.\n" +
        "  - DENIES: returns structured hard_violations (severity:hard rules that block) and/or soft_warnings (severity:soft rules that warn but allow).\n\n" +
        "Tier 1 (deterministic) matches the action against rule.matches regexes + rule.enforce_on category filter. Works on every MCP client.\n" +
        "Tier 2 (v0.11.7+) calls back to the client via MCP sampling/createMessage to judge rule.applies_when natural-language conditions. Auto-enabled on clients that declared the sampling capability; silently skipped on clients that didn't.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "Description of the proposed action. Plain prose · 'delete the memory called X', 'push to main branch', 'commit with message Y', etc.",
          },
          action_type: {
            type: "string",
            description:
              "Action category for rule.enforce_on matching. Examples: 'deletions', 'commits', 'pushes', 'file_writes', 'chat_responses', 'tool_calls'.",
          },
          session_id: {
            type: "string",
            description:
              "Optional session identifier · binds the issued receipt to this session via a caveat.",
          },
          use_sampling: {
            type: "boolean",
            description:
              "Opt out of Tier-2 Sampling enrichment (default true). Set false for batched/scripted use where the Sampling round-trip would add latency. CLI invocations default this to false automatically.",
          },
        },
        required: ["action", "action_type"],
      },
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
        result = await toolRelevantMemories(args);
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
      case "check_action":
        result = await toolCheckAction(args);
        break;
      case "audit":
        result = toolAudit(args);
        break;
      case "rotate_key":
        result = toolRotateKey(args);
        break;
      case "init":
        result = toolInit(args);
        break;
      case "validate_receipt":
        result = toolValidateReceipt(args);
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
  "check-action",
  "audit",
  "export-pubkey",
  "ui",
  "import-claude-code",
  "hook",
  "install-hooks",
  "init",
  "validate-receipt",
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

function pkgVersion(): string {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function cliMain(command: string, rest: string[]): Promise<number> {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`agent-memory-mcp ${pkgVersion()}\n`);
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
          (await toolRelevantMemories({
            query,
            max: flags.max ? Number(flags.max) : undefined,
          })) + "\n",
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
        // v0.12.0+ · delete_memory requires a Compliance Receipt. The CLI
        // is the trusted operator path (a human is running the command,
        // not an AI agent), so we auto-issue a CLI-scoped receipt rather
        // than make the operator chain `check-action` then paste JSON.
        // MCP callers (AI agents) still must go through check_action
        // explicitly — this short-circuit only fires from the CLI binary.
        const receipt = issueReceipt({
          caveats: [
            { type: "action_type", value: "deletions" },
            // Bind to THIS memory so the auto-issued CLI receipt satisfies the
            // same target check the MCP path enforces.
            { type: "action_hash", value: deletionActionHash(name) },
            { type: "issued_by", value: "cli" },
          ],
        });
        process.stdout.write(toolDeleteMemory({ name, receipt: JSON.stringify(receipt) }) + "\n");
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
      case "rotate-key": {
        process.stdout.write(toolRotateKey({ mode: flags.mode }) + "\n");
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
      case "check-action": {
        const action = positional[0];
        const actionType = String(flags.type ?? flags["action-type"] ?? "");
        if (!action || !actionType) {
          throw new Error(
            "Usage: agent-memory check-action '<action description>' --type <action_type> [--session <id>]",
          );
        }
        process.stdout.write(
          (await toolCheckAction({
            action,
            action_type: actionType,
            session_id: flags.session ? String(flags.session) : undefined,
            // CLI invocations don't have a Sampling-capable client attached,
            // so skip Tier 2 to avoid a timeout · keeps the CLI fast.
            use_sampling: false,
          })) + "\n",
        );
        return 0;
      }
      case "audit": {
        process.stdout.write(toolAudit({ format: flags.json ? "json" : "pretty" }) + "\n");
        return 0;
      }
      case "export-pubkey": {
        // CRP 1.1 · print the Ed25519 public key (PEM) so other MCP servers
        // can verify receipts issued by this server without sharing the
        // signing secret. Lazily initializes the keypair if missing.
        const { publicKeyPem } = loadOrCreateEd25519Keys();
        process.stdout.write(publicKeyPem);
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
      case "hook":
        return await runHook();
      case "install-hooks":
        return installHooks({
          global: Boolean(flags.global),
          dryRun: Boolean(flags["dry-run"]),
        });
      case "init":
        return runInit({ force: Boolean(flags.force) });
      case "validate-receipt": {
        let receiptStr = flags.receipt ? String(flags.receipt) : "";
        if (!receiptStr && flags["receipt-file"]) {
          receiptStr = readFileSync(String(flags["receipt-file"]), "utf8");
        }
        if (!receiptStr && flags.stdin) receiptStr = await readStdin();
        process.stdout.write(
          toolValidateReceipt({
            receipt: receiptStr,
            public_key: flags["public-key"] ?? flags.pubkey,
          }) + "\n",
        );
        return 0;
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
  init [--force]                           Install a starter guardrail pack (protect main, block
                                           rm -rf / prod-data destruction / curl|sh, flag secrets)
                                           and emit it to every tool. Zero-config protection.
  install-hooks [--global] [--dry-run]     Wire the enforcement hook into Claude Code's settings so
                                           hard rules actually BLOCK matching tool calls (soft → ask).
  hook                                     (internal) PreToolUse hook · reads a proposed tool call on
                                           stdin and enforces your rules. Registered by install-hooks.
  validate-receipt --public-key <pem|path> [--receipt <json> | --receipt-file <p> | --stdin]
                                           Validate another server's CRP 1.1 (Ed25519) receipt —
                                           the federation primitive (no shared secret).
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
// Real enforcement · PreToolUse hook (v0.15)
// -------------------------------------------------------------
//
// check_action only gates THIS server's own tools (delete_memory). To enforce
// your rules on the agent's REAL actions — the shell commands and file writes
// it runs in Claude Code and compatible hosts — `agent-memory hook` plugs into
// the host's PreToolUse hook. It reads the proposed tool call on stdin, maps it
// to an action + category, runs it through your rule store, and answers in the
// host's hook protocol: a HARD rule denies the call, a SOFT rule asks the user.

interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
}

/**
 * Map a proposed host tool call to (action text, action category) for rule
 * matching. Returns null for tools we never constrain (reads, searches).
 */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { action: string; actionType: string } | null {
  const t = toolName.toLowerCase();
  // Shell — the highest-risk surface.
  if (t === "bash" || t === "shell" || t.includes("terminal") || t.includes("run_command")) {
    const cmd = String(input.command ?? input.cmd ?? input.script ?? "");
    if (!cmd.trim()) return null;
    const lc = cmd.toLowerCase();
    let actionType = "shell";
    if (/git\s+push|--force\b|push\s+-f\b|force-with-lease/.test(lc)) actionType = "pushes";
    else if (
      /\brm\s|\brmdir\b|\bunlink\b|drop\s+(table|database)|delete\s+from|truncate\b/.test(lc)
    )
      actionType = "deletions";
    else if (/git\s+commit/.test(lc)) actionType = "commits";
    return { action: cmd, actionType };
  }
  // File writes / edits.
  if (
    t === "write" ||
    t === "edit" ||
    t === "multiedit" ||
    t === "create_file" ||
    t.includes("str_replace") ||
    t.includes("apply_patch")
  ) {
    const path = String(input.file_path ?? input.path ?? input.filename ?? "");
    return { action: `write file ${path}`.trim(), actionType: "file_writes" };
  }
  return null; // reads/searches/etc. — unconstrained
}

/**
 * PreToolUse hook entry point. Emits the host's structured decision (Claude
 * Code's `hookSpecificOutput.permissionDecision`) AND uses exit codes (2 =
 * block) as a fallback for hosts that only honor exit status.
 */
async function runHook(): Promise<number> {
  const raw = await readStdin();
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return 0; // not a JSON hook payload → allow
  }
  const toolName = String(payload.tool_name ?? "");
  const input = (payload.tool_input ?? {}) as Record<string, unknown>;
  if (!toolName) return 0;

  const classified = classifyToolCall(toolName, input);
  if (!classified) return 0; // unconstrained tool

  let result: { hard: RuleViolation[]; soft: RuleViolation[]; rules_evaluated: number };
  try {
    result = checkActionAgainstRules(classified.action, classified.actionType);
  } catch {
    return 0; // never let the hook break the agent
  }

  if (result.hard.length > 0) {
    const reason =
      `Blocked by agent-memory rule(s): ${result.hard.map((v) => v.rule).join(", ")}. ` +
      `${result.hard[0].reason}. Override requires explicit human action.`;
    logEvent("hook_deny", {
      tool: toolName,
      actionType: classified.actionType,
      rules: result.hard.map((v) => v.rule),
    });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }) + "\n",
    );
    process.stderr.write(reason + "\n");
    return 2; // fallback hard-block for exit-code-only hosts
  }
  if (result.soft.length > 0) {
    const reason =
      `agent-memory soft rule(s) flagged this: ${result.soft.map((v) => v.rule).join(", ")}. ` +
      `Confirm before proceeding.`;
    logEvent("hook_ask", {
      tool: toolName,
      actionType: classified.actionType,
      rules: result.soft.map((v) => v.rule),
    });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: reason,
        },
      }) + "\n",
    );
    return 0;
  }
  return 0; // allowed
}

/**
 * Register the PreToolUse hook in Claude Code's settings.json (project-local by
 * default, or ~/.claude with --global). Idempotent: replaces any prior
 * agent-memory hook entry. Uses the exact node + script path that's running
 * this command so the hook resolves regardless of PATH.
 */
function installHooks(opts: { global?: boolean; dryRun?: boolean }): number {
  const dir = opts.global ? join(homedir(), ".claude") : join(process.cwd(), ".claude");
  const settingsPath = join(dir, "settings.json");
  const scriptPath = process.argv[1] ? resolve(process.argv[1]) : "agent-memory";
  const hookCommand = `"${process.execPath}" "${scriptPath}" hook`;

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      process.stderr.write(`error: ${settingsPath} is not valid JSON; refusing to overwrite.\n`);
      return 1;
    }
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as Array<Record<string, unknown>>)
    : [];
  // Drop any existing agent-memory hook so re-running is idempotent.
  const cleaned = pre.filter(
    (m) =>
      !(Array.isArray(m.hooks) ? (m.hooks as Array<Record<string, unknown>>) : []).some(
        (h) =>
          typeof h.command === "string" &&
          h.command.includes("hook") &&
          /agent-memory/i.test(h.command),
      ),
  );
  cleaned.push({
    matcher: "Bash|Write|Edit|MultiEdit",
    hooks: [{ type: "command", command: hookCommand }],
  });
  hooks.PreToolUse = cleaned;
  settings.hooks = hooks;

  const out = JSON.stringify(settings, null, 2) + "\n";
  if (opts.dryRun) {
    process.stdout.write(`would write ${settingsPath}:\n\n${out}\n`);
    return 0;
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFile(settingsPath, out);
  process.stdout.write(
    c(ANSI.green, `✓ installed PreToolUse hook`) +
      `\n  settings : ${settingsPath}\n  guards   : Bash · Write · Edit · MultiEdit\n` +
      `\nHard rules now BLOCK matching tool calls; soft rules ASK. Restart your agent session to load it.\n` +
      `Tip: run \`agent-memory init\` to drop in a starter guardrail pack.\n`,
  );
  return 0;
}

// -------------------------------------------------------------
// init · starter guardrail pack (v0.15)
// -------------------------------------------------------------
//
// Zero-config value: write a handful of sensible hard/soft rules so a new user
// is protected the moment they install, before writing a single rule of their
// own. All patterns are ReDoS-safe and scoped to the highest-risk categories.

interface StarterRule {
  name: string;
  description: string;
  severity: "hard" | "soft";
  enforce_on: string[];
  matches: string[];
  content: string;
}

const STARTER_RULES: StarterRule[] = [
  {
    name: "protect-main-branch",
    description: "Never force-push to main or master.",
    severity: "hard",
    enforce_on: ["pushes"],
    matches: [
      "push\\s+.*--force.*\\b(main|master)\\b",
      "push\\s+.*\\b(main|master)\\b.*--force",
      "push\\s+-f\\b",
    ],
    content:
      "Force-pushing main/master rewrites shared history and can destroy teammates' work.\n\n**Why:** It's almost never what you want from an autonomous agent.\n**How to apply:** Block it; require an explicit human override.",
  },
  {
    name: "no-rm-rf",
    description: "Block recursive force-deletes (rm -rf).",
    severity: "hard",
    enforce_on: ["deletions", "shell"],
    matches: ["rm\\s+-[a-z]*r[a-z]*f", "rm\\s+-[a-z]*f[a-z]*r"],
    content:
      "`rm -rf` is the classic foot-gun — one bad path argument wipes the wrong tree.\n\n**Why:** Irreversible, and agents get paths wrong.\n**How to apply:** Block it; delete specific paths deliberately instead.",
  },
  {
    name: "no-prod-data-destruction",
    description: "Never drop/truncate tables or mass-delete rows.",
    severity: "hard",
    enforce_on: ["deletions", "shell"],
    matches: ["drop\\s+(table|database)", "truncate\\s+table", "delete\\s+from\\s+\\w+\\s*;"],
    content:
      "Schema and bulk-data destruction must be a deliberate, reviewed migration — never an ad-hoc agent action.\n\n**How to apply:** Block; route through a real migration with a human in the loop.",
  },
  {
    name: "no-curl-pipe-shell",
    description: "Don't pipe network scripts straight into a shell.",
    severity: "hard",
    enforce_on: ["shell"],
    matches: ["(curl|wget)\\s+[^|]*\\|\\s*(sudo\\s+)?(bash|sh|zsh)"],
    content:
      "`curl ... | sh` runs unreviewed remote code with your privileges.\n\n**How to apply:** Block; download, read, then run.",
  },
  {
    name: "no-secrets-in-commits",
    description: "Flag obvious secrets/keys before they're written or committed.",
    severity: "soft",
    enforce_on: ["commits", "file_writes"],
    matches: [
      "BEGIN\\s+(RSA|EC|OPENSSH|PGP)\\s+PRIVATE\\s+KEY",
      "AKIA[0-9A-Z]{16}",
      "sk-[a-zA-Z0-9]{20,}",
    ],
    content:
      "This looks like a real credential.\n\n**How to apply:** Ask before proceeding — confirm it's a placeholder, not a live secret.",
  },
];

function toolInit(args: Record<string, unknown>): string {
  const force = Boolean(args.force);
  ensureStorage();
  let added = 0;
  let skipped = 0;
  for (const r of STARTER_RULES) {
    if (!force && existsSync(memoryFilePath(r.name))) {
      skipped++;
      continue;
    }
    toolSaveRule({
      name: r.name,
      description: r.description,
      content: r.content,
      severity: r.severity,
      enforce_on: r.enforce_on,
      matches: r.matches,
      scope: ["global"],
    });
    added++;
  }
  // Surface the rules to every tool immediately.
  const emit = emitCompanions();
  return [
    `✓ starter guardrails installed`,
    `  added    : ${added}${skipped ? ` · skipped ${skipped} existing (force=true to overwrite)` : ""}`,
    `  rules    : ${STARTER_RULES.map((r) => r.name).join(", ")}`,
    `  emitted  : ${emit.emitted.length} companion file(s) → ${emit.outDir}`,
    ``,
    `Next: \`agent-memory install-hooks\` so hard rules actually BLOCK matching tool calls in Claude Code.`,
  ].join("\n");
}

function runInit(opts: { force?: boolean }): number {
  process.stdout.write(toolInit({ force: opts.force }) + "\n");
  return 0;
}

// -------------------------------------------------------------
// CRP federation · validate another server's receipt (v0.15)
// -------------------------------------------------------------
//
// CRP 1.1 (Ed25519) makes receipts portable: server A issues "delete X",
// server B validates with A's PUBLIC key — no shared secret. This is the
// primitive that turns Compliance Receipts from a feature into a standard.

/**
 * Validate a CRP 1.1 (Ed25519) receipt against a supplied public key (PEM).
 * Skips the rules-version check by default (the issuer's rule set is foreign);
 * verifies signature, expiry, and any required caveats.
 */
export function validateReceiptWithPublicKey(
  receipt: ComplianceReceipt,
  publicKeyPem: string,
  opts: { required_caveats?: Caveat[]; check_expiry?: boolean } = {},
): ValidateReceiptResult {
  if (receipt.version !== "1.1") {
    return { valid: false, reason: "federation requires a CRP 1.1 (Ed25519) receipt" };
  }
  const canonical = canonicalizeReceipt({
    id: receipt.id,
    issued_at: receipt.issued_at,
    expires_at: receipt.expires_at,
    rules_version: receipt.rules_version,
    caveats: receipt.caveats,
    version: receipt.version,
  });
  let ok = false;
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(canonical, "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(receipt.signature, "hex"),
    );
  } catch {
    return { valid: false, reason: "signature verification failed (bad key or receipt)" };
  }
  if (!ok) return { valid: false, reason: "invalid signature for the supplied public key" };
  if (opts.check_expiry !== false && Math.floor(Date.now() / 1000) > receipt.expires_at) {
    return { valid: false, reason: "receipt expired" };
  }
  for (const required of opts.required_caveats ?? []) {
    if (!receipt.caveats.find((cv) => cv.type === required.type && cv.value === required.value)) {
      return {
        valid: false,
        reason: `missing required caveat: ${required.type}=${required.value}`,
      };
    }
  }
  return { valid: true };
}

function readPublicKeyArg(arg: unknown): string | null {
  if (typeof arg !== "string" || !arg.trim()) return null;
  const v = arg.trim();
  if (v.includes("BEGIN PUBLIC KEY")) return v; // inline PEM
  if (existsSync(v)) {
    try {
      return readFileSync(v, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

function toolValidateReceipt(args: Record<string, unknown>): string {
  const receipt = parseReceiptArg(args.receipt);
  if (!receipt) throw new Error("receipt required (object or JSON string)");
  const pem = readPublicKeyArg(args.public_key ?? args.pubkey);
  if (!pem) {
    throw new Error(
      "public_key required · pass the issuer's Ed25519 public key as inline PEM or a file path " +
        "(get yours with `agent-memory export-pubkey`).",
    );
  }
  const required = Array.isArray(args.required_caveats)
    ? (args.required_caveats as Caveat[])
    : undefined;
  const v = validateReceiptWithPublicKey(receipt, pem, { required_caveats: required });
  return JSON.stringify({ valid: v.valid, reason: v.reason }, null, 2);
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
// (e.g. from src/tui.tsx) should not trigger the dispatch. Resolve symlinks on
// both sides first: when installed globally, process.argv[1] is the bin SYMLINK
// path while import.meta.url is the real file, so a raw string compare wrongly
// returns false and main() never runs — the CLI and MCP server silently no-op.
function resolvePathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
const isEntryPoint =
  !!process.argv[1] &&
  resolvePathSafe(process.argv[1]) === resolvePathSafe(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
