import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanupDir, makeTempDir, runMcp } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  cleanupDir(dir);
});

describe("MCP · server protocol", () => {
  test("tools/list returns all 24 tools", async () => {
    const responses = await runMcp(dir, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(responses).toHaveLength(1);
    const tools = (responses[0] as { result: { tools: { name: string }[] } }).result.tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "audit",
      "check_action",
      "delete_memory",
      "doctor",
      "emit_companions",
      "find_backlinks",
      "find_related",
      "get_memory",
      "init",
      "list_memories",
      "list_rules",
      "log_events",
      "relevant_memories",
      "restore_memory",
      "rotate_key",
      "save_memory",
      "save_rule",
      "search_memories",
      "stats",
      "sync_pull",
      "sync_push",
      "sync_status",
      "validate_receipt",
      "verify_memory",
    ]);
  });

  test("prompts/list returns 4 starter prompts", async () => {
    const responses = await runMcp(dir, [{ jsonrpc: "2.0", id: 1, method: "prompts/list" }]);
    expect(responses).toHaveLength(1);
    const prompts = (responses[0] as { result: { prompts: { name: string }[] } }).result.prompts;
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([
      "audit_stale",
      "extract_memories",
      "prepare_handoff",
      "summarize_topic",
    ]);
  });

  test("prompts/get returns a structured message", async () => {
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "prompts/get",
        params: { name: "summarize_topic", arguments: { topic: "deployment" } },
      },
    ]);
    expect(responses).toHaveLength(1);
    const result = (
      responses[0] as { result: { messages: { role: string; content: { text: string } }[] } }
    ).result;
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.text).toContain("deployment");
  });

  test("save → resources/list → resources/read round-trip", async () => {
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "save_memory",
          arguments: {
            name: "mcp-test",
            type: "user",
            description: "MCP round-trip test",
            content: "MCP body content",
          },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "agent-memory://memory/mcp-test" },
      },
    ]);

    expect(responses).toHaveLength(3);

    const listed = (responses[1] as { result: { resources: { uri: string }[] } }).result.resources;
    expect(listed.some((r) => r.uri === "agent-memory://index")).toBe(true);
    expect(listed.some((r) => r.uri === "agent-memory://memory/mcp-test")).toBe(true);

    const read = (responses[2] as { result: { contents: { text: string }[] } }).result.contents[0];
    expect(read.text).toContain("MCP body content");
    expect(read.text).toContain("schema: 1");
  });

  test("path traversal in resource URI is rejected", async () => {
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "agent-memory://memory/../etc/passwd" },
      },
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toHaveProperty("error");
    const err = (responses[0] as { error: { message: string } }).error;
    expect(err.message).toMatch(/Invalid memory name/i);
  });

  test("unknown resource URI returns error", async () => {
    const responses = await runMcp(dir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "agent-memory://nonsense/foo" },
      },
    ]);
    expect(responses[0]).toHaveProperty("error");
  });
});
