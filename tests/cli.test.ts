import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupDir, makeTempDir, runCli } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = makeTempDir();
});
afterEach(() => {
  cleanupDir(dir);
});

describe("CLI · roundtrip", () => {
  test("save → list → get → search → delete → restore", () => {
    expect(
      runCli(dir, [
        "save",
        "test-mem",
        "--type",
        "user",
        "--description",
        "Test",
        "--content",
        "Body.",
      ]).exitCode,
    ).toBe(0);

    const list = runCli(dir, ["list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("test-mem");
    expect(list.stdout).toContain("[user]");

    const get = runCli(dir, ["get", "test-mem"]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout).toContain("type: user");
    expect(get.stdout).toContain("Body.");

    const search = runCli(dir, ["search", "test"]);
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("test-mem");
    expect(search.stdout).toMatch(/relevance \d+%/);

    const del = runCli(dir, ["delete", "test-mem"]);
    expect(del.exitCode).toBe(0);
    expect(del.stdout).toContain("Moved");
    expect(runCli(dir, ["list"]).stdout).toContain("No memories yet");

    const restored = runCli(dir, ["restore", "test-mem"]);
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain("Restored");
    expect(runCli(dir, ["list"]).stdout).toContain("test-mem");
  });
});

describe("CLI · validation", () => {
  test("rejects invalid slug", () => {
    const r = runCli(dir, [
      "save",
      "BAD NAME",
      "--type",
      "user",
      "--description",
      "x",
      "--content",
      "y",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Invalid name");
  });

  test("rejects invalid type", () => {
    const r = runCli(dir, [
      "save",
      "ok-name",
      "--type",
      "bogus",
      "--description",
      "x",
      "--content",
      "y",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Invalid type");
  });

  test("missing query for search", () => {
    const r = runCli(dir, ["search"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Usage");
  });
});

describe("CLI · soft delete + restore", () => {
  test("delete moves file to .trash with timestamp prefix", () => {
    runCli(dir, ["save", "to-trash", "--type", "project", "--description", "x", "--content", "y"]);
    runCli(dir, ["delete", "to-trash"]);

    const trashDir = join(dir, ".trash");
    expect(existsSync(trashDir)).toBe(true);
    const trashFiles = readdirSync(trashDir);
    expect(trashFiles).toHaveLength(1);
    expect(trashFiles[0]).toMatch(/^\d+-to-trash\.md$/);
  });

  test("restore picks most recent when multiple trash entries exist", () => {
    runCli(dir, [
      "save",
      "twice",
      "--type",
      "user",
      "--description",
      "first",
      "--content",
      "first body",
    ]);
    runCli(dir, ["delete", "twice"]);
    runCli(dir, [
      "save",
      "twice",
      "--type",
      "user",
      "--description",
      "second",
      "--content",
      "second body",
    ]);
    runCli(dir, ["delete", "twice"]);

    // Two trash entries now exist
    expect(readdirSync(join(dir, ".trash"))).toHaveLength(2);

    runCli(dir, ["restore", "twice"]);
    const get = runCli(dir, ["get", "twice"]);
    expect(get.stdout).toContain("second body");
  });
});

describe("CLI · doctor", () => {
  test("clean store reports OK", () => {
    runCli(dir, ["save", "one", "--type", "user", "--description", "x", "--content", "y"]);
    const r = runCli(dir, ["doctor"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OK · no issues found");
  });

  test("detects orphan files and dangling entries, repairs with --rebuild-index", () => {
    runCli(dir, [
      "save",
      "ok",
      "--type",
      "user",
      "--description",
      "ok desc",
      "--content",
      "ok body",
    ]);

    // Inject an orphan file (not in index)
    const orphanFile = join(dir, "orphan.md");
    const fmt = `---\nname: orphan\ndescription: "orphan desc"\ntype: project\nschema: 1\n---\n\nOrphan body.\n`;
    writeFileSync(orphanFile, fmt, "utf8");

    // Inject dangling index entry by appending to MEMORY.md
    const indexPath = join(dir, "MEMORY.md");
    const existing = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, existing + "- [ghost](ghost.md) — Ghost\n", "utf8");

    const detect = runCli(dir, ["doctor"]);
    expect(detect.stdout).toContain("orphan");
    expect(detect.stdout).toContain("dangling");

    const repair = runCli(dir, ["doctor", "--rebuild-index"]);
    expect(repair.stdout).toContain("rebuilt MEMORY.md");

    const clean = runCli(dir, ["doctor"]);
    expect(clean.stdout).toContain("OK · no issues found");
  });
});

describe("CLI · fuzzy search", () => {
  beforeEach(() => {
    runCli(dir, [
      "save",
      "deploy-process",
      "--type",
      "project",
      "--description",
      "Production deployment",
      "--content",
      "Vercel blue-green.",
    ]);
    runCli(dir, [
      "save",
      "no-emojis",
      "--type",
      "feedback",
      "--description",
      "No emoji anywhere",
      "--content",
      "Scrub all emojis.",
    ]);
  });

  test("typo tolerance: 'depoy' finds 'deploy-process'", () => {
    const r = runCli(dir, ["search", "depoy"]);
    expect(r.stdout).toContain("deploy-process");
  });

  test("singular/plural: 'emoji' finds 'emojis'", () => {
    const r = runCli(dir, ["search", "emoji"]);
    expect(r.stdout).toContain("no-emojis");
  });

  test("no results returns explanatory message", () => {
    const r = runCli(dir, ["search", "xyznosuchword"]);
    expect(r.stdout).toContain("No memories matched");
  });
});

describe("CLI · pagination + stats + events", () => {
  test("list pagination respects --limit", () => {
    for (let i = 0; i < 5; i++) {
      runCli(dir, [
        "save",
        `mem-${i}`,
        "--type",
        "user",
        "--description",
        `Memory ${i}`,
        "--content",
        `Body ${i}`,
      ]);
    }
    const r = runCli(dir, ["list", "--limit", "2"]);
    expect(r.stdout).toContain("Showing 1-2 of 5");
    expect(r.stdout).toContain("3 more");
  });

  test("stats reports correct type counts", () => {
    runCli(dir, ["save", "u1", "--type", "user", "--description", "x", "--content", "y"]);
    runCli(dir, ["save", "u2", "--type", "user", "--description", "x", "--content", "y"]);
    runCli(dir, ["save", "f1", "--type", "feedback", "--description", "x", "--content", "y"]);
    const r = runCli(dir, ["stats"]);
    expect(r.stdout).toMatch(/user\s+2/);
    expect(r.stdout).toMatch(/feedback\s+1/);
    expect(r.stdout).toContain("memories: 3 total");
  });

  test("event log captures save/delete/restore", () => {
    runCli(dir, ["save", "audited", "--type", "user", "--description", "x", "--content", "y"]);
    runCli(dir, ["delete", "audited"]);
    runCli(dir, ["restore", "audited"]);
    const log = runCli(dir, ["log"]);
    expect(log.stdout).toContain("save");
    expect(log.stdout).toContain("delete");
    expect(log.stdout).toContain("restore");
  });
});

describe("CLI · meta", () => {
  test("help prints usage", () => {
    const r = runCli(dir, ["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("USAGE");
    expect(r.stdout).toContain("COMMANDS");
  });

  test("--version prints version", () => {
    const r = runCli(dir, ["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/agent-memory-mcp \d+\.\d+\.\d+/);
  });
});
