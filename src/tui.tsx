/**
 * agent-memory-mcp · TUI
 *
 * The visual face of the project — Ink-based terminal UI for browsing,
 * filtering, searching, and editing memories.
 *
 * Layout:
 *   ┌─ agent-memory ──────────────────────────────────────────┐
 *   │ [all] user feedback project reference  ·  N memories     │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ memory list (scrolling)                                  │
 *   │   ▶ highlighted name  [type]  · tags                     │
 *   │     description                                          │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ detail pane for highlighted memory                       │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ key hints footer                                         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Launched via `agent-memory ui`. Dynamic-imported from index.ts so
 * Ink + React only load when the TUI is actually invoked.
 */

import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { spawnSync } from "node:child_process";
import { useEffect, useMemo, useState } from "react";
import Fuse from "fuse.js";
import {
  listMemoryFiles,
  type Memory,
  MEMORY_DIR,
  memoryFilePath,
  readMemory,
  toolDeleteMemory,
} from "./index.js";

type TypeFilter = "all" | "user" | "feedback" | "project" | "reference";
const TYPE_FILTERS: TypeFilter[] = ["all", "user", "feedback", "project", "reference"];

interface AppState {
  memories: Memory[];
  selected: number;
  typeFilter: TypeFilter;
  searchMode: boolean;
  searchQuery: string;
  confirmDelete: string | null;
  status: string | null;
}

function loadAllMemories(): Memory[] {
  return listMemoryFiles()
    .map((n) => readMemory(n))
    .filter((m): m is Memory => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterMemories(memories: Memory[], typeFilter: TypeFilter, query: string): Memory[] {
  let list = memories;
  if (typeFilter !== "all") list = list.filter((m) => m.type === typeFilter);
  if (query.trim()) {
    const fuse = new Fuse(list, {
      includeScore: true,
      threshold: 0.4,
      ignoreLocation: true,
      keys: [
        { name: "name", weight: 3 },
        { name: "description", weight: 2 },
        { name: "body", weight: 1 },
      ],
    });
    return fuse.search(query).map((r) => r.item);
  }
  return list;
}

const typeColor: Record<string, string> = {
  user: "cyan",
  feedback: "yellow",
  project: "green",
  reference: "magenta",
};

const App = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<AppState>({
    memories: loadAllMemories(),
    selected: 0,
    typeFilter: "all",
    searchMode: false,
    searchQuery: "",
    confirmDelete: null,
    status: null,
  });

  const visible = useMemo(
    () => filterMemories(state.memories, state.typeFilter, state.searchQuery),
    [state.memories, state.typeFilter, state.searchQuery],
  );

  // Keep the selection in range when filters shrink the list
  useEffect(() => {
    if (state.selected >= visible.length && visible.length > 0) {
      setState((s) => ({ ...s, selected: Math.max(0, visible.length - 1) }));
    } else if (visible.length === 0 && state.selected !== 0) {
      setState((s) => ({ ...s, selected: 0 }));
    }
  }, [visible.length, state.selected]);

  const current = visible[state.selected];

  const refresh = () =>
    setState((s) => ({ ...s, memories: loadAllMemories(), status: "refreshed" }));

  useInput((input, key) => {
    if (state.searchMode) return; // TextInput component handles search input

    // Delete confirmation flow
    if (state.confirmDelete) {
      if (input === "y" || input === "Y") {
        try {
          toolDeleteMemory({ name: state.confirmDelete });
          setState((s) => ({
            ...s,
            memories: loadAllMemories(),
            confirmDelete: null,
            status: `deleted "${state.confirmDelete}" (in .trash/)`,
          }));
        } catch (err) {
          setState((s) => ({
            ...s,
            confirmDelete: null,
            status: `delete failed: ${(err as Error).message}`,
          }));
        }
      } else if (input === "n" || input === "N" || key.escape) {
        setState((s) => ({ ...s, confirmDelete: null, status: "delete cancelled" }));
      }
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }

    if (key.upArrow || input === "k") {
      setState((s) => ({ ...s, selected: Math.max(0, s.selected - 1), status: null }));
      return;
    }
    if (key.downArrow || input === "j") {
      setState((s) => ({
        ...s,
        selected: Math.min(Math.max(0, visible.length - 1), s.selected + 1),
        status: null,
      }));
      return;
    }

    // Type filter quick-keys
    const typeKeyMap: Record<string, TypeFilter> = {
      "0": "all",
      "1": "user",
      "2": "feedback",
      "3": "project",
      "4": "reference",
    };
    if (typeKeyMap[input]) {
      setState((s) => ({ ...s, typeFilter: typeKeyMap[input], selected: 0, status: null }));
      return;
    }

    if (input === "/") {
      setState((s) => ({ ...s, searchMode: true, status: null }));
      return;
    }

    if (input === "r") {
      refresh();
      return;
    }

    if (input === "e" && current) {
      const editor = process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
      const fp = memoryFilePath(current.name);
      // Suspend Ink rendering, spawn editor, then refresh after exit
      stdout?.write("\x1bc"); // reset terminal to give the editor a clean canvas
      const result = spawnSync(editor, [fp], { stdio: "inherit" });
      setState((s) => ({
        ...s,
        memories: loadAllMemories(),
        status:
          result.status === 0
            ? `edited "${current.name}" in ${editor}`
            : `editor exited with code ${result.status}`,
      }));
      return;
    }

    if (input === "d" && current) {
      setState((s) => ({ ...s, confirmDelete: current.name, status: null }));
      return;
    }
  });

  const onSearchSubmit = () => setState((s) => ({ ...s, searchMode: false, selected: 0 }));
  const onSearchChange = (value: string) => setState((s) => ({ ...s, searchQuery: value }));

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold>agent-memory</Text>
        <Text dimColor> · </Text>
        {TYPE_FILTERS.map((t, i) => (
          <Text
            key={t}
            bold={state.typeFilter === t}
            color={state.typeFilter === t ? "green" : "gray"}
          >
            {i > 0 ? "  " : ""}[{i}] {t}
          </Text>
        ))}
        <Text dimColor>
          {" · "}
          {visible.length} of {state.memories.length}
          {state.searchQuery && ` matching "${state.searchQuery}"`}
        </Text>
      </Box>

      {/* Search input */}
      {state.searchMode && (
        <Box paddingX={1}>
          <Text color="cyan">/ </Text>
          <TextInput
            value={state.searchQuery}
            onChange={onSearchChange}
            onSubmit={onSearchSubmit}
            placeholder="fuzzy search · enter to confirm"
          />
        </Box>
      )}

      {/* Memory list */}
      <Box flexDirection="column" paddingX={1}>
        {visible.length === 0 ? (
          <Text dimColor>(no memories match)</Text>
        ) : (
          visible.slice(0, 12).map((m, i) => {
            const isSelected = i === state.selected;
            return (
              <Box key={m.name}>
                <Text color={isSelected ? "green" : undefined} bold={isSelected}>
                  {isSelected ? "▶ " : "  "}
                  {m.name}
                </Text>
                <Text color={typeColor[m.type] ?? "gray"}> [{m.type}]</Text>
                {m.tags.length > 0 ? (
                  <Text dimColor>
                    {" · "}
                    {m.tags.join(" · ")}
                  </Text>
                ) : null}
              </Box>
            );
          })
        )}
        {visible.length > 12 && (
          <Text dimColor> ... +{visible.length - 12} more (filter down with /)</Text>
        )}
      </Box>

      {/* Detail pane */}
      {current && (
        <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1}>
          <Text bold>{current.name}</Text>
          <Text dimColor>{current.description}</Text>
          <Box marginTop={1} flexDirection="column">
            {current.body
              .split("\n")
              .slice(0, 10)
              .map((line, i) => (
                <Text key={i} dimColor={line.startsWith("#") ? false : true}>
                  {line || " "}
                </Text>
              ))}
            {current.body.split("\n").length > 10 && (
              <Text dimColor>... (truncated · press 'e' to open in editor)</Text>
            )}
          </Box>
        </Box>
      )}

      {/* Footer */}
      <Box paddingX={1} flexDirection="column">
        {state.confirmDelete ? (
          <Text color="yellow">
            Delete "{state.confirmDelete}"? (y/n) · soft-delete, recoverable from .trash/
          </Text>
        ) : (
          <Text dimColor>
            ↑↓/jk navigate · 0-4 type filter · / search · e edit · d delete · r refresh · q quit
          </Text>
        )}
        {state.status && <Text color="cyan">· {state.status}</Text>}
        <Text dimColor>storage: {MEMORY_DIR}</Text>
      </Box>
    </Box>
  );
};

export async function runTui(): Promise<void> {
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
