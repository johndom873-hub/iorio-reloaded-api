import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeSourceClosureHash } from "./computeSourceClosureHash.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "source-closure-hash-test-"));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion": 1}');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, contents: string): void {
  writeFileSync(join(root, relativePath), contents);
}

describe("computeSourceClosureHash", () => {
  it("follows relative imports transitively and lists exactly the closure, sorted", () => {
    write("src/entry.ts", 'import { helper } from "./lib/helper.js";\nimport type { Thing } from "./lib/types.js";\n');
    write("src/lib/helper.ts", 'import { deeper } from "./deeper.js";\nexport function helper() { return deeper(); }\n');
    write("src/lib/deeper.ts", "export function deeper() { return 1; }\n");
    write("src/lib/types.ts", "export type Thing = number;\n");

    const result = computeSourceClosureHash(root, "src/entry.ts");
    expect(result.files).toEqual(["src/entry.ts", "src/lib/deeper.ts", "src/lib/helper.ts", "src/lib/types.ts"]);
  });

  it("ignores bare package imports and node: builtins entirely", () => {
    write("src/entry.ts", 'import { z } from "zod";\nimport { readFile } from "node:fs";\nexport const x = 1;\n');
    const result = computeSourceClosureHash(root, "src/entry.ts");
    expect(result.files).toEqual(["src/entry.ts"]);
  });

  it("is stable across two calls with unchanged files, and changes when a leaf file's content changes", () => {
    write("src/entry.ts", 'import { helper } from "./lib/helper.js";\n');
    write("src/lib/helper.ts", "export function helper() { return 1; }\n");
    const before = computeSourceClosureHash(root, "src/entry.ts");
    expect(computeSourceClosureHash(root, "src/entry.ts").hash).toBe(before.hash);

    write("src/lib/helper.ts", "export function helper() { return 2; }\n");
    const after = computeSourceClosureHash(root, "src/entry.ts");
    expect(after.hash).not.toBe(before.hash);
    // Changing a leaf's content doesn't change the closure's file SET, only the hash.
    expect(after.files).toEqual(before.files);
  });

  it("is unaffected by a file OUTSIDE the closure changing (the whole point: API-only changes leave the worker hash alone)", () => {
    write("src/entry.ts", 'import { helper } from "./lib/helper.js";\n');
    write("src/lib/helper.ts", "export function helper() { return 1; }\n");
    write("src/unrelated.ts", "export const unrelated = 1;\n");
    const before = computeSourceClosureHash(root, "src/entry.ts");

    write("src/unrelated.ts", "export const unrelated = 999; // changed\n");
    expect(computeSourceClosureHash(root, "src/entry.ts").hash).toBe(before.hash);
  });

  it("changes when package-lock.json changes, even with identical source", () => {
    write("src/entry.ts", "export const x = 1;\n");
    const before = computeSourceClosureHash(root, "src/entry.ts");
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion": 2}');
    expect(computeSourceClosureHash(root, "src/entry.ts").hash).not.toBe(before.hash);
  });

  it("does not infinite-loop on a circular import", () => {
    write("src/entry.ts", 'import { a } from "./a.js";\n');
    write("src/a.ts", 'import { b } from "./b.js";\nexport function a() { return b(); }\n');
    write("src/b.ts", 'import { a } from "./a.js";\nexport function b() { return 1; }\n');
    const result = computeSourceClosureHash(root, "src/entry.ts");
    expect(result.files.sort()).toEqual(["src/a.ts", "src/b.ts", "src/entry.ts"]);
  });

  it("throws a clear error when a relative import resolves to a missing file", () => {
    write("src/entry.ts", 'import { missing } from "./does-not-exist.js";\n');
    expect(() => computeSourceClosureHash(root, "src/entry.ts")).toThrow(/does-not-exist\.ts/);
  });
});
