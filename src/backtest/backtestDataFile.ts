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

/** The symbol file's first complete option day; null when the file does not exist or holds none. */
export function readFirstOptionDay(symbol: string): string | null {
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return null;
  try {
    return (database.prepare("SELECT min(trading_date) AS first FROM days WHERE status = 'complete'").get() as { first: string | null }).first;
  } finally {
    database.close();
  }
}

/** Opens a symbol file for writing what Node keeps in it (the IBKR stock bars); null when it has not been downloaded. Close it when done. */
export function openBacktestDataFileForWriting(symbol: string): DatabaseSync | null {
  const filePath = backtestDataFilePath(symbol);
  if (!existsSync(filePath)) return null;
  const database = new DatabaseSync(filePath);
  // A backtest may be reading the file: wait for its lock instead of failing.
  database.exec("PRAGMA busy_timeout = 10000");
  return database;
}
