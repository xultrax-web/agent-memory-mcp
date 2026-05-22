import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests spawn child processes that do filesystem IO. Run them
    // serially so per-test temp dirs don't collide.
    fileParallelism: false,
    testTimeout: 15_000,
    include: ["tests/**/*.test.ts"],
  },
});
