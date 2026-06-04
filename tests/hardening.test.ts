// Security-hardening regression tests.
//
// Covers the holes closed in the hardening pass:
//   1. Compliance Receipts are bound to their specific target — a receipt
//      minted for "delete memory A" cannot delete memory B.
//   2. Receipts are single-use — a valid receipt cannot be replayed.
//   3. ReDoS-prone rule patterns are rejected at save_rule.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cleanupDir, makeTempDir, runCli, runMcp } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  cleanupDir(dir);
});

function textOf(resp: Record<string, unknown>): string {
  return (resp as { result: { content: [{ text: string }] } }).result.content[0].text;
}

async function receiptForDeleting(memDir: string, name: string): Promise<unknown> {
  const resp = await runMcp(memDir, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "check_action",
        arguments: { action: `delete memory ${name}`, action_type: "deletions" },
      },
    },
  ]);
  return JSON.parse(textOf(resp[0])).receipt;
}

async function tryDelete(memDir: string, name: string, receipt: unknown): Promise<string> {
  const resp = await runMcp(memDir, [
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delete_memory", arguments: { name, receipt: JSON.stringify(receipt) } },
    },
  ]);
  return textOf(resp[0]);
}

describe("receipts are bound to their target", () => {
  test("a deletions receipt for memory A cannot delete memory B", async () => {
    runCli(dir, ["save", "alpha", "--type", "project", "--description", "a", "--content", "x"]);
    runCli(dir, ["save", "beta", "--type", "project", "--description", "b", "--content", "y"]);

    const receiptForAlpha = await receiptForDeleting(dir, "alpha");

    // Reusing alpha's receipt against beta must be refused...
    const wrong = await tryDelete(dir, "beta", receiptForAlpha);
    expect(wrong.toLowerCase()).toMatch(/refused|invalid|missing required caveat/);
    expect(runCli(dir, ["get", "beta"]).stdout).toContain("beta"); // beta survived

    // ...but it still correctly deletes its real target.
    const right = await tryDelete(dir, "alpha", receiptForAlpha);
    expect(right).toContain("Moved");
  });
});

describe("receipts are single-use (replay protection)", () => {
  test("the same receipt cannot delete twice", async () => {
    runCli(dir, ["save", "gamma", "--type", "project", "--description", "g", "--content", "z"]);
    const receipt = await receiptForDeleting(dir, "gamma");

    expect(await tryDelete(dir, "gamma", receipt)).toContain("Moved");
    runCli(dir, ["restore", "gamma"]); // bring it back so a replay *could* delete it

    const replay = await tryDelete(dir, "gamma", receipt);
    expect(replay.toLowerCase()).toMatch(/already used|single-use|refused/);
    expect(runCli(dir, ["get", "gamma"]).stdout).toContain("gamma"); // survived the replay
  });
});

describe("ReDoS-prone rule patterns are rejected", () => {
  test("save_rule refuses a catastrophic-backtracking pattern", () => {
    const r = runCli(dir, [
      "save-rule",
      "redos-rule",
      "--description",
      "bad pattern",
      "--severity",
      "soft",
      "--matches",
      "(a+)+$",
      "--content",
      "body",
    ]);
    expect(r.exitCode).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toMatch(/redos|backtrack|unsafe/);
    expect(runCli(dir, ["list"]).stdout).not.toContain("redos-rule");
  });

  test("save_rule accepts a safe pattern", () => {
    const r = runCli(dir, [
      "save-rule",
      "safe-rule",
      "--description",
      "ok",
      "--severity",
      "soft",
      "--matches",
      "force-push",
      "--content",
      "body",
    ]);
    expect(r.exitCode).toBe(0);
  });
});
