import { existsSync, rmSync } from "node:fs";
import { db } from "../db/connection.js";
import { backtestDataFilePath, requireBacktestDataDirectory } from "./backtestDataDirectory.js";
import { splitScheduleCachePath } from "./engine/splitFactors.js";
import { BacktestRequestError } from "./jobs/backtestJobStore.js";

const unfinishedStatuses = ["queued", "running"];

/** What still uses the symbol's file: a download, a backtest session or an analysis queued or running (a stopped download counts). */
async function describeWhatUsesTheFile(symbol: string): Promise<string | null> {
  const [download, analysis, session] = await Promise.all([
    db("backtest_jobs").where({ kind: "download", symbol }).whereIn("status", unfinishedStatuses).first("id"),
    db("backtest_jobs").where({ kind: "analysis", symbol }).whereIn("status", unfinishedStatuses).first("id"),
    db("backtest_sessions")
      .whereIn("status", unfinishedStatuses)
      .where((uses) => uses.where({ symbol }).orWhereRaw("symbols @> ?::jsonb", [JSON.stringify([symbol])]))
      .first("name"),
  ]);
  if (download) return `${symbol} has a download queued or running: cancel it first.`;
  if (analysis) return `${symbol} is being analysed: wait for the analysis to finish.`;
  if (session) return `The backtest "${session.name}" uses ${symbol} and has not finished: wait for it or cancel it first.`;
  return null;
}

/**
 * Deletes a symbol's data file (with its SQLite side files and its split cache) and its downloads from the job list.
 * Refused while anything that reads or writes the file is queued or running. Past sessions keep their results; the
 * symbol's ticker row and IBKR daily bars stay (the live system shares them).
 */
export async function deleteBacktestDataFile(symbol: string): Promise<void> {
  const filePath = backtestDataFilePath(symbol);
  if (!existsSync(filePath)) throw new BacktestRequestError(`${symbol} has no data file.`, 404);
  const inUse = await describeWhatUsesTheFile(symbol);
  if (inUse) throw new BacktestRequestError(inUse, 409);

  await db("backtest_jobs").where({ kind: "download", symbol }).whereNotIn("status", unfinishedStatuses).delete();
  for (const sidePath of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`, splitScheduleCachePath(requireBacktestDataDirectory(), symbol)]) {
    rmSync(sidePath, { force: true });
  }
}
