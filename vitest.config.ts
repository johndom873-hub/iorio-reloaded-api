import { globSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const testFilePattern = "src/**/*.test.ts";

// Files that connect to the shared test database run one at a time: the reconciliation pass they exercise is global (it closes any
// open position with no open leg and any open leg missing from its held report), so concurrent files sweep each other's rows and fail
// at random; never mask these failures with retries. A file is one of them when it names the test database's URL or the knexfile;
// files on a private schema (createIsolatedTestDatabase) don't, and run in parallel with every other file.
const sharedTestDatabaseReference = /TEST_DATABASE_URL|testDatabaseUrl|knexfile/;
const sharedTestDatabaseFiles = globSync(testFilePattern).filter((file) => sharedTestDatabaseReference.test(readFileSync(file, "utf8")));

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: "parallel", include: [testFilePattern], exclude: sharedTestDatabaseFiles } },
      { extends: true, test: { name: "shared-test-database", include: sharedTestDatabaseFiles, fileParallelism: false } },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/db/migrations/**"],
      reporter: ["text-summary", "json-summary", "json"],
    },
  },
});
