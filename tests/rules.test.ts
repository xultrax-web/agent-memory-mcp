// Tests for the v0.11 "memory as constraint" surface · type=rule
// memories, the save_rule / list_rules / emit_companions tools, and
// the AGENTS.md companion file emitter.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cleanupDir, makeTempDir, runCli } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  cleanupDir(dir);
});

describe("rules · save-rule + list-rules", () => {
  test("save-rule writes a memory with type=rule + severity frontmatter", () => {
    const r = runCli(dir, [
      "save-rule",
      "no-emojis-ever",
      "--description",
      "Never use emojis in any user-visible output.",
      "--severity",
      "hard",
      "--scope",
      "global",
      "--enforce-on",
      "chat_responses,commits",
      "--content",
      "No emojis. Anywhere. Ever.",
    ]);
    expect(r.exitCode).toBe(0);
    const fp = join(dir, "no-emojis-ever.md");
    expect(existsSync(fp)).toBe(true);
    const raw = readFileSync(fp, "utf8");
    expect(raw).toContain("type: rule");
    expect(raw).toContain("severity: hard");
    expect(raw).toContain('scope: ["global"]');
    expect(raw).toContain('enforce_on: ["chat_responses", "commits"]');
  });

  test("save-rule defaults severity to soft", () => {
    const r = runCli(dir, [
      "save-rule",
      "use-typed-tools",
      "--description",
      "Prefer typed tool calls.",
      "--content",
      "Use the typed API.",
    ]);
    expect(r.exitCode).toBe(0);
    const raw = readFileSync(join(dir, "use-typed-tools.md"), "utf8");
    expect(raw).toContain("severity: soft");
  });

  test("save-rule rejects unknown severity", () => {
    const r = runCli(dir, [
      "save-rule",
      "bad-sev",
      "--description",
      "x",
      "--severity",
      "kinda-hard",
      "--content",
      "y",
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("severity");
  });

  test("list-rules surfaces saved rules with severity + scope", () => {
    runCli(dir, [
      "save-rule",
      "a-rule",
      "--description",
      "first rule",
      "--severity",
      "hard",
      "--scope",
      "global",
      "--content",
      "body",
    ]);
    runCli(dir, [
      "save-rule",
      "b-rule",
      "--description",
      "second rule",
      "--severity",
      "soft",
      "--content",
      "body",
    ]);
    const r = runCli(dir, ["list-rules"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("a-rule");
    expect(r.stdout).toContain("[hard]");
    expect(r.stdout).toContain("b-rule");
    expect(r.stdout).toContain("[soft]");
    expect(r.stdout).toContain("2 rules active");
  });

  test("list-rules with empty store returns 'No rules defined yet'", () => {
    const r = runCli(dir, ["list-rules"]);
    expect(r.stdout).toContain("No rules defined yet");
  });
});

describe("companion files · emit-companions", () => {
  test("emit-companions writes AGENTS.md with both hard and soft sections", () => {
    runCli(dir, [
      "save-rule",
      "no-emojis",
      "--description",
      "No emojis in output.",
      "--severity",
      "hard",
      "--content",
      "Never use emojis.",
    ]);
    runCli(dir, [
      "save-rule",
      "prefer-typed",
      "--description",
      "Prefer typed APIs.",
      "--severity",
      "soft",
      "--content",
      "Use the typed API.",
    ]);
    const out = makeTempDir();
    try {
      const r = runCli(dir, ["emit-companions", "--out", out]);
      expect(r.exitCode).toBe(0);
      const agents = readFileSync(join(out, "AGENTS.md"), "utf8");
      expect(agents).toContain("# Operator rules");
      expect(agents).toContain("Hard rules");
      expect(agents).toContain("no-emojis");
      expect(agents).toContain("Conventions");
      expect(agents).toContain("prefer-typed");
      expect(agents).toContain("2 rules active");
    } finally {
      cleanupDir(out);
    }
  });

  test("emit-companions on empty store writes a placeholder AGENTS.md", () => {
    const out = makeTempDir();
    try {
      const r = runCli(dir, ["emit-companions", "--out", out]);
      expect(r.exitCode).toBe(0);
      const agents = readFileSync(join(out, "AGENTS.md"), "utf8");
      expect(agents).toContain("No rules defined yet");
    } finally {
      cleanupDir(out);
    }
  });

  test("AGENTS.md round-trips rule body content", () => {
    runCli(dir, [
      "save-rule",
      "tests-before-commit",
      "--description",
      "Run the full test suite before every commit.",
      "--severity",
      "hard",
      "--applies-when",
      "user requests a commit,git commit is proposed",
      "--matches",
      "git commit",
      "--enforce-on",
      "commits",
      "--content",
      "Always run `npm test` (or the project's equivalent) before committing.",
    ]);
    const out = makeTempDir();
    try {
      runCli(dir, ["emit-companions", "--out", out]);
      const agents = readFileSync(join(out, "AGENTS.md"), "utf8");
      expect(agents).toContain("tests-before-commit");
      expect(agents).toContain("Run the full test suite before every commit.");
      expect(agents).toContain("Always run");
      expect(agents).toContain("npm test");
      expect(agents).toContain("Enforce on:");
      expect(agents).toContain("commits");
      expect(agents).toContain("Pattern matches:");
    } finally {
      cleanupDir(out);
    }
  });
});

describe("rule type · interaction with existing memory tools", () => {
  test("list with --type rule returns only rule memories", () => {
    runCli(dir, ["save-rule", "a-rule", "--description", "rule memory", "--content", "body"]);
    runCli(dir, [
      "save",
      "a-project",
      "--type",
      "project",
      "--description",
      "project memory",
      "--content",
      "body",
    ]);
    const r = runCli(dir, ["list", "--type", "rule"]);
    expect(r.stdout).toContain("a-rule");
    expect(r.stdout).not.toContain("a-project");
  });

  test("save_memory with type=rule is accepted (back-compat path)", () => {
    const r = runCli(dir, [
      "save",
      "manual-rule",
      "--type",
      "rule",
      "--description",
      "rule via save",
      "--content",
      "body",
    ]);
    expect(r.exitCode).toBe(0);
    const raw = readFileSync(join(dir, "manual-rule.md"), "utf8");
    expect(raw).toContain("type: rule");
  });
});
