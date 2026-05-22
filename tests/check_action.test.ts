// Tests for the v0.11.3 check_action tool · the protocol enforcement
// point. Verifies Tier-1 deterministic rule matching, Compliance Receipt
// issuance on approve, structured violations on deny, and receipt-gated
// delete_memory.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { cleanupDir, makeTempDir, runCli, runMcp } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  cleanupDir(dir);
});

describe("check_action · Tier 1 deterministic", () => {
  test("approves when no rules match · returns a receipt", async () => {
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: {
            action: "read the contents of a memory",
            action_type: "reads",
          },
        },
      },
    ]);
    const text = (responses[0] as { result: { content: [{ text: string }] } }).result.content[0]
      .text;
    const payload = JSON.parse(text);
    expect(payload.approved).toBe(true);
    expect(payload.hard_violations).toEqual([]);
    expect(payload.receipt).toBeDefined();
    expect(payload.receipt.id).toMatch(/^rcpt_[a-f0-9]{16}$/);
    expect(payload.receipt.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  test("denies on hard rule match · returns structured violation", async () => {
    runCli(dir, [
      "save-rule",
      "no-emojis",
      "--description",
      "Never use emojis.",
      "--severity",
      "hard",
      "--matches",
      "emoji",
      "--enforce-on",
      "chat_responses",
      "--content",
      "No emojis.",
    ]);
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: {
            action: "send a chat response with an emoji",
            action_type: "chat_responses",
          },
        },
      },
    ]);
    const text = (responses[0] as { result: { content: [{ text: string }] } }).result.content[0]
      .text;
    const payload = JSON.parse(text);
    expect(payload.approved).toBe(false);
    expect(payload.receipt).toBeUndefined();
    expect(payload.hard_violations).toHaveLength(1);
    expect(payload.hard_violations[0].rule).toBe("no-emojis");
    expect(payload.hard_violations[0].severity).toBe("hard");
  });

  test("warns on soft rule match · still approves + returns receipt", async () => {
    runCli(dir, [
      "save-rule",
      "prefer-typed",
      "--description",
      "Prefer typed APIs.",
      "--severity",
      "soft",
      "--matches",
      "any\\b",
      "--enforce-on",
      "tool_calls",
      "--content",
      "Prefer typed.",
    ]);
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: {
            action: "call a tool with any-typed arguments",
            action_type: "tool_calls",
          },
        },
      },
    ]);
    const text = (responses[0] as { result: { content: [{ text: string }] } }).result.content[0]
      .text;
    const payload = JSON.parse(text);
    expect(payload.approved).toBe(true);
    expect(payload.receipt).toBeDefined();
    expect(payload.soft_warnings).toHaveLength(1);
    expect(payload.soft_warnings[0].rule).toBe("prefer-typed");
  });

  test("rule with no matching enforce_on category is skipped", async () => {
    runCli(dir, [
      "save-rule",
      "commit-rule",
      "--description",
      "Commit rule.",
      "--severity",
      "hard",
      "--matches",
      "delete",
      "--enforce-on",
      "commits",
      "--content",
      "Body.",
    ]);
    // Action is about deletions, not commits — rule should NOT trigger
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: {
            action: "delete a memory",
            action_type: "deletions",
          },
        },
      },
    ]);
    const text = (responses[0] as { result: { content: [{ text: string }] } }).result.content[0]
      .text;
    const payload = JSON.parse(text);
    expect(payload.approved).toBe(true);
    expect(payload.hard_violations).toEqual([]);
  });

  test("rule with no enforce_on applies universally", async () => {
    runCli(dir, [
      "save-rule",
      "universal-rule",
      "--description",
      "Applies everywhere.",
      "--severity",
      "hard",
      "--matches",
      "forbidden",
      "--content",
      "Body.",
    ]);
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: {
            action: "do a forbidden thing",
            action_type: "anything",
          },
        },
      },
    ]);
    const text = (responses[0] as { result: { content: [{ text: string }] } }).result.content[0]
      .text;
    const payload = JSON.parse(text);
    expect(payload.approved).toBe(false);
    expect(payload.hard_violations).toHaveLength(1);
  });

  test("session_id flows into receipt as a caveat", async () => {
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: {
            action: "read",
            action_type: "reads",
            session_id: "sess_abc123",
          },
        },
      },
    ]);
    const text = (responses[0] as { result: { content: [{ text: string }] } }).result.content[0]
      .text;
    const payload = JSON.parse(text);
    expect(payload.receipt.caveats).toContainEqual({ type: "session", value: "sess_abc123" });
  });
});

describe("delete_memory · receipt-gated path", () => {
  test("delete with valid receipt succeeds", async () => {
    runCli(dir, ["save", "to-delete", "--type", "project", "--description", "x", "--content", "y"]);
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: {
            action: "delete memory to-delete",
            action_type: "deletions",
          },
        },
      },
    ]);
    const checkText = (responses[0] as { result: { content: [{ text: string }] } }).result
      .content[0].text;
    const check = JSON.parse(checkText);
    expect(check.approved).toBe(true);

    const delResponses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "delete_memory",
          arguments: { name: "to-delete", receipt: JSON.stringify(check.receipt) },
        },
      },
    ]);
    const delText = (delResponses[0] as { result: { content: [{ text: string }] } }).result
      .content[0].text;
    expect(delText).toContain("Moved");
    expect(delText).toContain("gated by receipt");
  });

  test("delete with tampered receipt is refused", async () => {
    runCli(dir, ["save", "to-delete", "--type", "project", "--description", "x", "--content", "y"]);
    const checkResp = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: { action: "delete to-delete", action_type: "deletions" },
        },
      },
    ]);
    const check = JSON.parse(
      (checkResp[0] as { result: { content: [{ text: string }] } }).result.content[0].text,
    );
    // Tamper signature · bit-flip the last byte (guaranteed different;
    // see receipts.test.ts for the 1/256 flakiness rationale).
    const lastByte = parseInt(check.receipt.signature.slice(-2), 16);
    const flipped = (lastByte ^ 0x01).toString(16).padStart(2, "0");
    check.receipt.signature = check.receipt.signature.slice(0, -2) + flipped;

    const delResp = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "delete_memory",
          arguments: { name: "to-delete", receipt: JSON.stringify(check.receipt) },
        },
      },
    ]);
    // Error response carries the refusal reason
    const delText = (delResp[0] as { result: { content: [{ text: string }] }; isError?: boolean })
      .result.content[0].text;
    expect(delText.toLowerCase()).toMatch(/refused|invalid|signature/);
  });

  test("delete with wrong-action-type receipt is refused", async () => {
    runCli(dir, ["save", "to-delete", "--type", "project", "--description", "x", "--content", "y"]);
    // Get a receipt for action_type='commits' (wrong category)
    const checkResp = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_action",
          arguments: { action: "commit something", action_type: "commits" },
        },
      },
    ]);
    const check = JSON.parse(
      (checkResp[0] as { result: { content: [{ text: string }] } }).result.content[0].text,
    );

    const delResp = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "delete_memory",
          arguments: { name: "to-delete", receipt: JSON.stringify(check.receipt) },
        },
      },
    ]);
    const delText = (delResp[0] as { result: { content: [{ text: string }] } }).result.content[0]
      .text;
    expect(delText.toLowerCase()).toMatch(/refused|missing required caveat/);
  });

  test("delete without receipt is REFUSED (v0.12.0 breaking change)", async () => {
    runCli(dir, ["save", "to-delete", "--type", "project", "--description", "x", "--content", "y"]);
    const delResp = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_memory", arguments: { name: "to-delete" } },
      },
    ]);
    const delText = (delResp[0] as { result: { content: [{ text: string }] } }).result.content[0]
      .text;
    expect(delText.toLowerCase()).toContain("receipt required");
  });
});

describe("check_action · CLI command", () => {
  test("CLI returns parseable JSON for an approved action", () => {
    const r = runCli(dir, ["check-action", "do something safe", "--type", "reads"]);
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.approved).toBe(true);
    expect(payload.receipt).toBeDefined();
  });

  test("CLI returns denial JSON when hard rule matches", () => {
    runCli(dir, [
      "save-rule",
      "no-curl",
      "--description",
      "Never use curl.",
      "--severity",
      "hard",
      "--matches",
      "curl",
      "--enforce-on",
      "shell",
      "--content",
      "Body.",
    ]);
    const r = runCli(dir, ["check-action", "run curl example.com", "--type", "shell"]);
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.approved).toBe(false);
    expect(payload.hard_violations[0].rule).toBe("no-curl");
  });
});
