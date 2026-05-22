// Tests for the v0.11.2 Compliance Receipts primitive · HMAC keyring,
// receipt issuance, canonical encoding, and validation. The primitive
// is exercised directly (not via MCP) because tool wiring lands in v0.11.3.
//
// Each test uses an isolated AGENT_MEMORY_DIR so the keyring + rule-store
// hash are independent across runs.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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

// Helper · import the receipt functions in a child Node process scoped
// to `dir` (so the HMAC keyring lands in the test memory dir). Returns
// the JSON value the script logged.
function runReceiptScript(memoryDir: string, script: string): unknown {
  const fullScript = `
    process.env.AGENT_MEMORY_DIR = ${JSON.stringify(memoryDir)};
    const mod = await import("./dist/index.js");
    const result = await (async () => { ${script} })();
    process.stdout.write(JSON.stringify(result));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", fullScript], {
    env: { ...process.env, AGENT_MEMORY_DIR: memoryDir, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0) {
    throw new Error(`Receipt script failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

describe("Compliance Receipts · issuance", () => {
  test("issueReceipt produces a receipt with the expected shape", () => {
    const r = runReceiptScript(
      dir,
      `return mod.issueReceipt({ caveats: [{ type: "action", value: "delete_memory" }] });`,
    ) as Record<string, unknown>;
    expect(r.id).toMatch(/^rcpt_[a-f0-9]{16}$/);
    expect(typeof r.issued_at).toBe("number");
    expect(typeof r.expires_at).toBe("number");
    expect((r.expires_at as number) - (r.issued_at as number)).toBe(60);
    expect(r.rules_version).toMatch(/^[a-f0-9]{16}$/);
    expect(r.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(Array.isArray(r.caveats)).toBe(true);
  });

  test("issueReceipt respects custom ttl_seconds", () => {
    const r = runReceiptScript(
      dir,
      `return mod.issueReceipt({ caveats: [], ttl_seconds: 120 });`,
    ) as Record<string, unknown>;
    expect((r.expires_at as number) - (r.issued_at as number)).toBe(120);
  });

  test("two receipts have different ids (random)", () => {
    const r1 = runReceiptScript(dir, `return mod.issueReceipt({ caveats: [] });`) as Record<
      string,
      unknown
    >;
    const r2 = runReceiptScript(dir, `return mod.issueReceipt({ caveats: [] });`) as Record<
      string,
      unknown
    >;
    expect(r1.id).not.toBe(r2.id);
    expect(r1.signature).not.toBe(r2.signature);
  });

  test("HMAC key file is created with restrictive perms (POSIX) or just created (Windows)", () => {
    runReceiptScript(dir, `return mod.issueReceipt({ caveats: [] });`);
    const keyPath = join(dir, ".keyring", "hmac-key");
    expect(existsSync(keyPath)).toBe(true);
    if (process.platform !== "win32") {
      // POSIX: 0o600 means only owner can read/write.
      const mode = statSync(keyPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe("Compliance Receipts · validation", () => {
  test("freshly-issued receipt validates", () => {
    const result = runReceiptScript(
      dir,
      `
      const r = mod.issueReceipt({ caveats: [{ type: "action", value: "delete_memory" }] });
      return mod.validateReceipt(r, {});
    `,
    ) as Record<string, unknown>;
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("tampered signature is rejected", () => {
    const result = runReceiptScript(
      dir,
      `
      const r = mod.issueReceipt({ caveats: [] });
      // Flip one bit in the last byte · guaranteed-different signature
      // (replacing with "00" had a 1/256 chance of being an identity op
      // when the random last byte already was 00; bit-flip is always
      // different).
      const lastByte = parseInt(r.signature.slice(-2), 16);
      const flipped = (lastByte ^ 0x01).toString(16).padStart(2, '0');
      r.signature = r.signature.slice(0, -2) + flipped;
      return mod.validateReceipt(r, {});
    `,
    ) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(String(result.reason).toLowerCase()).toContain("signature");
  });

  test("expired receipt is rejected", () => {
    const result = runReceiptScript(
      dir,
      `
      const r = mod.issueReceipt({ caveats: [], ttl_seconds: 1 });
      // Sleep past expires_at + a margin to avoid second-boundary edge cases
      // (Math.floor on Date.now()/1000 means a TTL=1 receipt issued at 1.99s
      // expires at second N+1; we need to land in N+2 to be unambiguously
      // past expiry).
      await new Promise((r) => setTimeout(r, 2500));
      return mod.validateReceipt(r, {});
    `,
    ) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(String(result.reason).toLowerCase()).toContain("expired");
  });

  test("receipt invalidated when rules change after issuance", () => {
    const result = runReceiptScript(
      dir,
      `
      const r = mod.issueReceipt({ caveats: [] });
      // Save a new rule via the CLI (not the import — would create circular
      // dependency). Instead, use the toolSaveRule function directly which is
      // re-exported from index.js. If it's not exported we fall back to writing
      // a rule file directly.
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const rulePath = join(${JSON.stringify(dir)}, "new-rule.md");
      writeFileSync(rulePath, '---\\nname: new-rule\\ndescription: "test"\\ntype: rule\\nseverity: hard\\nschema: 1\\n---\\n\\nbody\\n');
      return mod.validateReceipt(r, {});
    `,
    ) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(String(result.reason).toLowerCase()).toContain("rules changed");
  });

  test("required caveat missing from receipt rejects", () => {
    const result = runReceiptScript(
      dir,
      `
      const r = mod.issueReceipt({ caveats: [{ type: "action", value: "save_rule" }] });
      return mod.validateReceipt(r, {
        required_caveats: [{ type: "action", value: "delete_memory" }],
      });
    `,
    ) as Record<string, unknown>;
    expect(result.valid).toBe(false);
    expect(String(result.reason).toLowerCase()).toContain("missing required caveat");
  });

  test("required caveat present on receipt validates", () => {
    const result = runReceiptScript(
      dir,
      `
      const r = mod.issueReceipt({
        caveats: [
          { type: "action", value: "delete_memory" },
          { type: "session", value: "abc123" },
        ],
      });
      return mod.validateReceipt(r, {
        required_caveats: [{ type: "action", value: "delete_memory" }],
      });
    `,
    ) as Record<string, unknown>;
    expect(result.valid).toBe(true);
  });

  test("caveat ordering does not change signature (canonical form is sorted)", () => {
    const result = runReceiptScript(
      dir,
      `
      const r1 = mod.issueReceipt({
        caveats: [
          { type: "action", value: "delete_memory" },
          { type: "session", value: "abc" },
        ],
      });
      // Reorder caveats on the receipt — signature should still validate
      // because canonical form sorts caveats deterministically before HMAC.
      const r2 = { ...r1, caveats: [...r1.caveats].reverse() };
      return mod.validateReceipt(r2, {});
    `,
    ) as Record<string, unknown>;
    expect(result.valid).toBe(true);
  });
});

describe("Compliance Receipts · rules-version stability", () => {
  test("receipt still validates when an unrelated non-rule memory is added", () => {
    runCli(dir, [
      "save-rule",
      "a-rule",
      "--description",
      "first rule",
      "--severity",
      "hard",
      "--content",
      "body",
    ]);
    const result = runReceiptScript(
      dir,
      `
      const r = mod.issueReceipt({ caveats: [] });
      // Save a NON-rule memory (project type) — should NOT change rules_version.
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      writeFileSync(
        join(${JSON.stringify(dir)}, "some-project.md"),
        '---\\nname: some-project\\ndescription: "x"\\ntype: project\\nschema: 1\\n---\\n\\nbody\\n',
      );
      return mod.validateReceipt(r, {});
    `,
    ) as Record<string, unknown>;
    expect(result.valid).toBe(true);
  });
});
