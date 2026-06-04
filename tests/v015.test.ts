// v0.15 feature tests:
//   1. hook — real enforcement: a hard rule denies a matching Bash command.
//   2. init — starter guardrail pack (installed + idempotent).
//   3. install-hooks — dry-run shows the PreToolUse wiring.
//   4. validate-receipt — CRP 1.1 federation: validate with the issuer's pubkey; tamper fails.
//   5. relevant — hybrid recall surfaces a paraphrase Fuse alone would miss.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { BIN, cleanupDir, makeTempDir } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  cleanupDir(dir);
});

function run(
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("node", [BIN, ...args], {
    input: opts.input,
    env: {
      ...process.env,
      AGENT_MEMORY_DIR: dir,
      AGENT_MEMORY_COMPANION_DIR: dir, // keep companion files inside the temp store
      NO_COLOR: "1",
      ...(opts.env ?? {}),
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

describe("init · starter guardrails", () => {
  test("installs the pack and is idempotent", () => {
    const r = run(["init"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/protect-main-branch/);

    const list = run(["list-rules"]);
    expect(list.stdout).toContain("protect-main-branch");
    expect(list.stdout).toContain("no-rm-rf");

    const again = run(["init"]);
    expect(again.stdout.toLowerCase()).toMatch(/skipped/);
  });
});

describe("hook · real enforcement", () => {
  test("a hard rule denies a matching Bash command, allows benign ones", () => {
    run([
      "save-rule",
      "no-rmrf",
      "--severity",
      "hard",
      "--enforce-on",
      "deletions,shell",
      "--matches",
      "rm\\s+-rf",
      "--description",
      "no rm -rf",
      "--content",
      "blocked",
    ]);

    const deny = run(["hook"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/data" },
      }),
    });
    expect(deny.status).toBe(2); // exit-code block fallback
    expect((deny.stdout + deny.stderr).toLowerCase()).toMatch(/deny|blocked|no-rmrf/);

    const ok = run(["hook"], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
    });
    expect(ok.status).toBe(0);
  });
});

describe("install-hooks · dry-run", () => {
  test("shows the PreToolUse hook it would register", () => {
    const r = run(["install-hooks", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PreToolUse/);
    expect(r.stdout).toMatch(/Bash\|Write\|Edit\|MultiEdit/);
    expect(r.stdout).toMatch(/hook/);
  });
});

describe("validate-receipt · CRP 1.1 federation", () => {
  test("validates an Ed25519 receipt with the issuer's public key; tamper fails", () => {
    // Issue an Ed25519 (CRP 1.1) receipt — this also creates the keyring.
    const ca = run(["check-action", "do something safe", "--type", "reads"], {
      env: { CRP_SIGNING_MODE: "ed25519" },
    });
    const payload = JSON.parse(ca.stdout);
    expect(payload.approved).toBe(true);
    expect(payload.receipt.version).toBe("1.1");

    const pubFile = join(dir, ".keyring", "ed25519.pub");
    expect(existsSync(pubFile)).toBe(true);

    const v = run([
      "validate-receipt",
      "--public-key",
      pubFile,
      "--receipt",
      JSON.stringify(payload.receipt),
    ]);
    expect(JSON.parse(v.stdout).valid).toBe(true);

    // Tamper the signature → invalid.
    const sig: string = payload.receipt.signature;
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === "a" ? "b" : "a");
    const tampered = { ...payload.receipt, signature: flipped };
    const v2 = run([
      "validate-receipt",
      "--public-key",
      pubFile,
      "--receipt",
      JSON.stringify(tampered),
    ]);
    expect(JSON.parse(v2.stdout).valid).toBe(false);
  });
});

describe("relevant · hybrid recall", () => {
  test("a reworded query surfaces a keyword-overlapping memory", () => {
    run([
      "save",
      "memserver-check",
      "--type",
      "project",
      "--description",
      "Functional test of the memory server",
      "--content",
      "Verifies the memory server works end to end.",
    ]);
    const r = run(["relevant", "how do I know the memory server works", "--max", "3"]);
    expect(r.stdout).toContain("memserver-check");
  });
});
