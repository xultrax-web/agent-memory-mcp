// Shared test helpers: spawn the built binary as either a CLI command
// or an MCP stdio server. Each test gets its own temp memory dir.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const BIN = join(HERE, "..", "dist", "index.js");

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-test-"));
  return dir;
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — Windows file locks sometimes prevent immediate cleanup
  }
}

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run the CLI synchronously. Resolves to stdout/stderr/exitCode. */
export function runCli(memoryDir: string, args: string[]): CliResult {
  const result = spawnSync("node", [BIN, ...args], {
    env: { ...process.env, AGENT_MEMORY_DIR: memoryDir, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

/**
 * Send a list of JSON-RPC requests to the MCP server over stdio and
 * collect all responses. Resolves when the server exits (it exits
 * cleanly when stdin closes).
 */
export function runMcp(
  memoryDir: string,
  requests: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BIN], {
      env: { ...process.env, AGENT_MEMORY_DIR: memoryDir, NO_COLOR: "1" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("close", () => {
      const responses: Record<string, unknown>[] = [];
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        try {
          responses.push(JSON.parse(line));
        } catch {
          // skip non-JSON noise
        }
      }
      resolve(responses);
    });

    child.on("error", reject);

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + "\n");
    }
    child.stdin.end();
  });
}
