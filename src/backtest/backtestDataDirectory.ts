import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the backtest files live (docs/backtesting/DATA-FILES.md). BACKTEST_DATA_DIR is the feature switch: unset on
// staging and prod, so the backtest routes are not mounted there; a relative value resolves from the API repo root.
// No node:sqlite here: app.ts imports this module everywhere (backtestDataFile.ts opens the files).

/** The repo root whether this runs from src/ (tsx) or dist/src/ (compiled). */
export function backtestRepoRoot(): string {
  const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return path.basename(candidate) === "dist" ? path.dirname(candidate) : candidate;
}

/** The absolute data folder, or null when the feature is off. */
export function readBacktestDataDirectory(): string | null {
  const configured = process.env.BACKTEST_DATA_DIR?.trim();
  if (!configured) return null;
  return path.isAbsolute(configured) ? configured : path.resolve(backtestRepoRoot(), configured);
}

export function requireBacktestDataDirectory(): string {
  const directory = readBacktestDataDirectory();
  if (!directory) throw new Error("BACKTEST_DATA_DIR is not set: backtesting runs only locally (docs/backtesting/DATA-FILES.md).");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  return directory;
}

export function normalizeBacktestSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(normalized)) throw new Error(`Not a valid symbol: "${symbol}"`);
  return normalized;
}

export function backtestDataFilePath(symbol: string): string {
  return path.join(requireBacktestDataDirectory(), `${normalizeBacktestSymbol(symbol)}.sqlite`);
}
