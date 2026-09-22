import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

// Hashes the ACTUAL transitive source closure of an entry file (statically walking its relative
// imports), plus package-lock.json, rather than a hand-maintained file list — a hand-maintained
// list drifts the moment someone adds an import (exactly the kind of silent gap the atomic worker
// deploy is meant to close). Used to decide, in Phase B's release-phase deploy, whether the worker
// actually needs redeploying for a given commit: an API-only change (e.g. src/routes/dashboard.ts)
// never touches src/ibkrGatewayWorker.ts's closure and produces the same hash, so the worker is
// left untouched and undisturbed.
//
// Deliberately source-based (.ts under src/), not compiled dist/ output: this needs to run
// identically from a plain git checkout (the release dyno, or the worker's own startup, both of
// which have src/ on disk) without requiring a build first.
//
// Only relative imports ("./x.js", "../y.js") are followed — bare package imports (react,
// @stoqey/ib, node:crypto) are covered by hashing package-lock.json instead, which also catches a
// dependency version bump even when no .ts file changed.
const relativeImportPattern = /(?:import|export)(?:\s+type)?\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/g;

function resolveRelativeImport(fromFile: string, specifier: string): string {
  // Compiled imports end .js (NodeNext ESM resolution); the source file is the .ts next to it.
  const withoutExtension = specifier.replace(/\.js$/, "");
  const candidate = resolve(dirname(fromFile), `${withoutExtension}.ts`);
  return candidate;
}

function collectSourceClosure(entryFile: string): string[] {
  const visited = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    if (!existsSync(file)) {
      throw new Error(`computeSourceClosureHash: imported file does not exist: ${file} (broken relative import somewhere in the closure)`);
    }
    visited.add(file);
    const contents = readFileSync(file, "utf8");
    for (const match of contents.matchAll(relativeImportPattern)) {
      const importedFile = resolveRelativeImport(file, match[1]!);
      if (!visited.has(importedFile)) queue.push(importedFile);
    }
  }
  return [...visited].sort();
}

export interface SourceClosureHashResult {
  hash: string;
  /** Sorted, repo-root-relative — logged/compared for a human to see exactly what was hashed, not just the digest. */
  files: string[];
}

/**
 * @param repoRoot Absolute path to the repo checkout.
 * @param entryFileRelativeToRoot E.g. "src/ibkrGatewayWorker.ts".
 * @param packageLockRelativeToRoot Defaults to "package-lock.json" at the repo root.
 */
export function computeSourceClosureHash(repoRoot: string, entryFileRelativeToRoot: string, packageLockRelativeToRoot = "package-lock.json"): SourceClosureHashResult {
  const entryFile = resolve(repoRoot, entryFileRelativeToRoot);
  const closureFiles = collectSourceClosure(entryFile);

  const hash = createHash("sha256");
  for (const file of closureFiles) {
    hash.update(relative(repoRoot, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  const packageLockPath = resolve(repoRoot, packageLockRelativeToRoot);
  hash.update(existsSync(packageLockPath) ? readFileSync(packageLockPath) : Buffer.from("no-package-lock"));

  return { hash: hash.digest("hex"), files: closureFiles.map((file) => relative(repoRoot, file)) };
}
