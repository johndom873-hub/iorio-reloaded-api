import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Files run one at a time: the database-backed ones share a single test database, and the reconciliation pass they exercise is
    // global (it closes any open position with no open leg and any open leg missing from its held report), so concurrent files
    // sweep each other's rows and fail at random. Serial runs take ~14 s instead of ~3 s; never mask these failures with retries.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/db/migrations/**"],
      reporter: ["text-summary", "json-summary", "json"],
    },
  },
});
