import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { backtestDataFilePath } from "./backtestDataDirectory.js";

// Opens a symbol's backtest file (docs/backtesting/DATA-FILES.md). Kept apart from backtestDataDirectory.ts so only the
// lazily loaded backtest code loads node:sqlite.

/** Opens a symbol file read-only; null when it has not been downloaded. Close it when done. */
export function openBacktestDataFileReadOnly(symbol: string): DatabaseSync | null {
  const filePath = backtestDataFilePath(symbol);
  if (!existsSync(filePath)) return null;
  return new DatabaseSync(filePath, { readOnly: true });
}
