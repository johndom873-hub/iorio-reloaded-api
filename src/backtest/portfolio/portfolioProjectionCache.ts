import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { computeSourceClosureHash } from "../../lib/computeSourceClosureHash.js";

// Finished projections saved in the data folder (Marcelo 2026-11-04), so a book run again on the same data opens at once.
// A projection is saved under the hash of everything it is computed from: its whole input (every ticker's history,
// chains and calibration, the lab's settings, the account, horizon and drift), its path count, and the source of the code
// that runs it (the store and the worker with everything they import). New data, other settings or changed code give
// another key, so a saved projection is never reused for a different one. Files older than 14 days are deleted.

const savedProjectionFolderName = "portfolio-projections";
const savedProjectionMaxAgeMs = 14 * 86_400_000;

let projectionCodeHash: string | null = null;

/** The hash of the projection's code: the store's and the worker's source with everything they import (once per process). */
export function portfolioProjectionCodeHash(): string {
  if (projectionCodeHash === null) {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const entries = ["src/backtest/portfolio/portfolioProjectionStore.ts", "src/backtest/portfolio/portfolioProjectionWorker.ts"];
    projectionCodeHash = createHash("sha256")
      .update(entries.map((entry) => computeSourceClosureHash(repoRoot, entry).hash).join(":"))
      .digest("hex");
  }
  return projectionCodeHash;
}

/** The key a projection is saved under: the hash of what it is computed from (structured-clone bytes) and the code's hash. */
export function savedProjectionKey(computedFrom: unknown, codeHash: string): string {
  return createHash("sha256").update(serialize(computedFrom)).update(codeHash).digest("hex");
}

const savedProjectionPath = (dataDirectory: string, key: string) => path.join(dataDirectory, savedProjectionFolderName, `${key}.json`);

/** The projection saved under `key`, with when it was saved; null when there is none. */
export function readSavedProjection<Projection>(dataDirectory: string, key: string): { projection: Projection; savedAt: string } | null {
  const filePath = savedProjectionPath(dataDirectory, key);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8")) as { projection: Projection; savedAt: string };
}

/** Saves `projection` under `key` (written whole, then moved into place) and deletes saved projections older than 14 days. */
export function saveProjection(dataDirectory: string, key: string, projection: unknown, now = new Date()): void {
  const folder = path.join(dataDirectory, savedProjectionFolderName);
  mkdirSync(folder, { recursive: true });
  const filePath = savedProjectionPath(dataDirectory, key);
  writeFileSync(`${filePath}.partial`, JSON.stringify({ projection, savedAt: now.toISOString() }));
  renameSync(`${filePath}.partial`, filePath);
  for (const name of readdirSync(folder)) {
    const entry = path.join(folder, name);
    if (now.getTime() - statSync(entry).mtimeMs > savedProjectionMaxAgeMs) unlinkSync(entry);
  }
}
