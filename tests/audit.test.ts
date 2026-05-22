// Tests for the v0.11.4 audit command · rule count, staleness, pattern
// conflicts, recent denials, unreceipted deletes. Exercises both JSON
// and pretty-printed output formats.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cleanupDir, makeTempDir, runCli, runMcp } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  cleanupDir(dir);
});

function auditJson(memoryDir: string): Record<string, unknown> {
  const r = runCli(memoryDir, ["audit", "--json"]);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe("audit · rule summary", () => {
  test("empty store reports zero rules and healthy state", () => {
    const report = auditJson(dir) as {
      rules: { total: number; hard: number; soft: number };
      healthy: boolean;
    };
    expect(report.rules.total).toBe(0);
    expect(report.rules.hard).toBe(0);
    expect(report.rules.soft).toBe(0);
    expect(report.healthy).toBe(true);
  });

  test("counts rules by severity", () => {
    runCli(dir, [
      "save-rule",
      "h1",
      "--description",
      "h1",
      "--severity",
      "hard",
      "--content",
      "body",
    ]);
    runCli(dir, [
      "save-rule",
      "h2",
      "--description",
      "h2",
      "--severity",
      "hard",
      "--content",
      "body",
    ]);
    runCli(dir, [
      "save-rule",
      "s1",
      "--description",
      "s1",
      "--severity",
      "soft",
      "--content",
      "body",
    ]);
    const report = auditJson(dir) as { rules: { total: number; hard: number; soft: number } };
    expect(report.rules.total).toBe(3);
    expect(report.rules.hard).toBe(2);
    expect(report.rules.soft).toBe(1);
  });
});

describe("audit · staleness detection", () => {
  test("rule with last_verified > 90 days ago is flagged stale", () => {
    // Write a rule file directly with an old last_verified
    const oldDate = new Date(Date.now() - 100 * 86400_000).toISOString().slice(0, 10);
    writeFileSync(
      join(dir, "old-rule.md"),
      `---
name: old-rule
description: "Stale rule"
type: rule
severity: hard
last_verified: ${oldDate}
schema: 1
---

body
`,
    );
    const report = auditJson(dir) as {
      stale_rules: { name: string; age_days: number | null }[];
      healthy: boolean;
    };
    expect(report.stale_rules).toHaveLength(1);
    expect(report.stale_rules[0].name).toBe("old-rule");
    expect(report.stale_rules[0].age_days).toBeGreaterThanOrEqual(99);
    expect(report.healthy).toBe(false);
  });

  test("rule with no last_verified is flagged stale", () => {
    writeFileSync(
      join(dir, "no-verify.md"),
      `---
name: no-verify
description: "Never verified"
type: rule
severity: soft
schema: 1
---

body
`,
    );
    const report = auditJson(dir) as { stale_rules: { name: string; age_days: null }[] };
    expect(report.stale_rules).toHaveLength(1);
    expect(report.stale_rules[0].name).toBe("no-verify");
    expect(report.stale_rules[0].age_days).toBeNull();
  });

  test("freshly saved rule is NOT flagged stale (today's date defaults in)", () => {
    runCli(dir, [
      "save-rule",
      "fresh",
      "--description",
      "fresh",
      "--severity",
      "hard",
      "--content",
      "body",
    ]);
    const report = auditJson(dir) as { stale_rules: unknown[] };
    expect(report.stale_rules).toHaveLength(0);
  });
});

describe("audit · pattern conflict detection", () => {
  test("two rules sharing enforce_on category + identical pattern are flagged", () => {
    runCli(dir, [
      "save-rule",
      "rule-a",
      "--description",
      "first",
      "--severity",
      "hard",
      "--enforce-on",
      "commits",
      "--matches",
      "fast",
      "--content",
      "body",
    ]);
    runCli(dir, [
      "save-rule",
      "rule-b",
      "--description",
      "second",
      "--severity",
      "soft",
      "--enforce-on",
      "commits",
      "--matches",
      "fast",
      "--content",
      "body",
    ]);
    const report = auditJson(dir) as { pattern_conflicts: { rule_a: string; rule_b: string }[] };
    expect(report.pattern_conflicts).toHaveLength(1);
    const conf = report.pattern_conflicts[0];
    expect([conf.rule_a, conf.rule_b].sort()).toEqual(["rule-a", "rule-b"]);
  });

  test("rules with non-overlapping enforce_on are NOT conflicting even with same pattern", () => {
    runCli(dir, [
      "save-rule",
      "ca",
      "--description",
      "a",
      "--severity",
      "hard",
      "--enforce-on",
      "commits",
      "--matches",
      "x",
      "--content",
      "body",
    ]);
    runCli(dir, [
      "save-rule",
      "cb",
      "--description",
      "b",
      "--severity",
      "hard",
      "--enforce-on",
      "deletions",
      "--matches",
      "x",
      "--content",
      "body",
    ]);
    const report = auditJson(dir) as { pattern_conflicts: unknown[] };
    expect(report.pattern_conflicts).toHaveLength(0);
  });

  test("rules with overlapping enforce_on but no shared pattern are NOT flagged", () => {
    runCli(dir, [
      "save-rule",
      "p1",
      "--description",
      "a",
      "--severity",
      "hard",
      "--enforce-on",
      "commits",
      "--matches",
      "alpha",
      "--content",
      "body",
    ]);
    runCli(dir, [
      "save-rule",
      "p2",
      "--description",
      "b",
      "--severity",
      "soft",
      "--enforce-on",
      "commits",
      "--matches",
      "beta",
      "--content",
      "body",
    ]);
    const report = auditJson(dir) as { pattern_conflicts: unknown[] };
    expect(report.pattern_conflicts).toHaveLength(0);
  });
});

describe("audit · denial + unreceipted-delete surfaces", () => {
  test("recent check_action denial appears in audit", async () => {
    runCli(dir, [
      "save-rule",
      "block-rule",
      "--description",
      "block",
      "--severity",
      "hard",
      "--matches",
      "danger",
      "--enforce-on",
      "ops",
      "--content",
      "body",
    ]);
    const resp = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: { action: "do something danger", action_type: "ops" },
        },
      },
    ]);
    // Confirm check_action actually denied (so we know the event WAS logged)
    const text = (resp[0] as { result?: { content?: [{ text?: string }] } })?.result?.content?.[0]
      ?.text;
    const payload = text ? JSON.parse(text) : null;
    expect(payload?.approved).toBe(false);

    const report = auditJson(dir) as {
      recent_denials: { action_type: string; hard_count: number }[];
    };
    expect(report.recent_denials.length).toBeGreaterThanOrEqual(1);
    expect(report.recent_denials[0].action_type).toBe("ops");
    expect(report.recent_denials[0].hard_count).toBe(1);
  });

  test("unreceipted delete is surfaced", async () => {
    runCli(dir, ["save", "tmp", "--type", "project", "--description", "x", "--content", "y"]);
    await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_memory", arguments: { name: "tmp" } },
      },
    ]);
    const report = auditJson(dir) as { recent_unreceipted_deletes: { name: string }[] };
    expect(report.recent_unreceipted_deletes.length).toBeGreaterThanOrEqual(1);
    expect(report.recent_unreceipted_deletes[0].name).toBe("tmp");
  });
});

describe("audit · output formats", () => {
  test("pretty output includes 'agent-memory audit' header + section labels", () => {
    runCli(dir, [
      "save-rule",
      "r",
      "--description",
      "r",
      "--severity",
      "hard",
      "--content",
      "body",
    ]);
    const r = runCli(dir, ["audit"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("agent-memory audit");
    expect(r.stdout).toContain("Rules:");
    expect(r.stdout).toMatch(/HEALTHY|ATTENTION/);
  });

  test("JSON output is parseable and contains all sections", () => {
    const report = auditJson(dir);
    expect(report).toHaveProperty("rules");
    expect(report).toHaveProperty("stale_rules");
    expect(report).toHaveProperty("pattern_conflicts");
    expect(report).toHaveProperty("recent_denials");
    expect(report).toHaveProperty("recent_unreceipted_deletes");
    expect(report).toHaveProperty("healthy");
  });
});
