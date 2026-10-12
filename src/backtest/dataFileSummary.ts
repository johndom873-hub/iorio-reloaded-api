import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { openBacktestDataFileReadOnly } from "./backtestDataFile.js";
import { normalizeBacktestSymbol, requireBacktestDataDirectory } from "./backtestDataDirectory.js";
import type { BacktestDataFileSummary } from "./backtestTypes.js";
import { isWeekendDate, weekdaysBetweenInclusive } from "./jobs/backtestJobRules.js";
import type { DataFileCoverage } from "./jobs/backtestSessionRequest.js";
import { readSplitScheduleCache, splitScheduleFingerprint, splitScheduleFingerprintsMatch } from "./engine/splitFactors.js";

// The Data files table: what each symbol file in the data folder holds (docs/backtesting/DATA-FILES.md), read-only.

/** Symbols with a `<SYMBOL>.sqlite` file in the data folder, sorted. */
export function listBacktestDataFileSymbols(): string[] {
  const directory = requireBacktestDataDirectory();
  return readdirSync(directory)
    .filter((fileName) => fileName.endsWith(".sqlite"))
    .map((fileName) => fileName.slice(0, -".sqlite".length))
    .filter((symbol) => {
      try {
        return normalizeBacktestSymbol(symbol) === symbol;
      } catch {
        return false;
      }
    })
    .sort();
}

export interface DataFileContents extends DataFileCoverage {
  completeDays: number;
  /** Weekdays between firstDate and lastDate with no `days` row at all. */
  missingWeekdays: number;
}

const emptyContents: DataFileContents = { firstDate: null, lastDate: null, completeDays: 0, missingWeekdays: 0 };

/** The file's complete-day range and gaps; null when the symbol has no file. A file the downloader has only just created (no tables yet) reads as empty. */
export function readBacktestDataFileContents(symbol: string): DataFileContents | null {
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return null;
  try {
    // The downloader may be committing a day: wait for its lock instead of failing.
    database.exec("PRAGMA busy_timeout = 3000");
    const range = database.prepare("SELECT min(trading_date) AS firstDate, max(trading_date) AS lastDate, count(*) AS completeDays FROM days WHERE status = 'complete'").get() as {
      firstDate: string | null;
      lastDate: string | null;
      completeDays: number;
    };
    if (!range.firstDate || !range.lastDate) return { ...emptyContents, completeDays: Number(range.completeDays) };
    const storedDays = database.prepare("SELECT trading_date AS tradingDate FROM days WHERE trading_date BETWEEN ? AND ?").all(range.firstDate, range.lastDate) as { tradingDate: string }[];
    const storedWeekdays = storedDays.filter((day) => !isWeekendDate(day.tradingDate)).length;
    return {
      firstDate: range.firstDate,
      lastDate: range.lastDate,
      completeDays: Number(range.completeDays),
      missingWeekdays: Math.max(0, weekdaysBetweenInclusive(range.firstDate, range.lastDate) - storedWeekdays),
    };
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return emptyContents;
    throw error;
  } finally {
    database.close();
  }
}

/** The file's size on disk, including a write-ahead log not yet merged into it. */
function dataFileSizeBytes(symbol: string): number {
  const filePath = path.join(requireBacktestDataDirectory(), `${symbol}.sqlite`);
  const writeAheadLogPath = `${filePath}-wal`;
  return statSync(filePath).size + (existsSync(writeAheadLogPath) ? statSync(writeAheadLogPath).size : 0);
}

/** First and last IBKR daily bar per symbol in the local DB, and how many there are. */
export async function loadDailyBarRanges(symbols: readonly string[], connection: Knex = db): Promise<Map<string, { firstDate: string; lastDate: string; count: number }>> {
  if (symbols.length === 0) return new Map();
  const rows: { symbol: string; first_date: string; last_date: string; bar_count: number }[] = await connection("tickers as t")
    .join("daily_price_bars as b", "b.ticker_id", "t.id")
    .whereIn("t.symbol", symbols)
    .groupBy("t.symbol")
    .select("t.symbol", connection.raw("min(b.trading_date)::text as first_date"), connection.raw("max(b.trading_date)::text as last_date"), connection.raw("count(*)::int as bar_count"));
  return new Map(rows.map((row) => [row.symbol, { firstDate: row.first_date, lastDate: row.last_date, count: Number(row.bar_count) }]));
}

/** The splits the engine cached for the file (splitFactors.ts), only while the file and the bars are what they were inferred from; never inferred here. */
function cachedDetectedSplits(dataDirectory: string, symbol: string, contents: DataFileContents, bars: { lastDate: string; count: number } | undefined): BacktestDataFileSummary["detectedSplits"] {
  const cache = readSplitScheduleCache(dataDirectory, symbol);
  if (!cache) return null;
  const current = splitScheduleFingerprint(contents.completeDays, contents.lastDate, bars?.count ?? 0, bars?.lastDate ?? null);
  return splitScheduleFingerprintsMatch(cache.fingerprint, current) ? cache.schedule.splits : null;
}

export async function summarizeBacktestDataFiles(connection: Knex = db): Promise<BacktestDataFileSummary[]> {
  const symbols = listBacktestDataFileSymbols();
  const dataDirectory = requireBacktestDataDirectory();
  const barRanges = await loadDailyBarRanges(symbols, connection);
  return symbols.map((symbol) => {
    let contents = emptyContents;
    try {
      contents = readBacktestDataFileContents(symbol) ?? emptyContents;
    } catch (error) {
      // One unreadable file must not take the whole overview down; it shows as empty and the log says why.
      console.warn(`Backtest data file ${symbol}.sqlite could not be read: ${error instanceof Error ? error.message : error}`);
    }
    const bars = barRanges.get(symbol);
    return {
      symbol,
      detectedSplits: cachedDetectedSplits(dataDirectory, symbol, contents, bars),
      firstDate: contents.firstDate,
      lastDate: contents.lastDate,
      completeDays: contents.completeDays,
      missingWeekdays: contents.missingWeekdays,
      sizeBytes: dataFileSizeBytes(symbol),
      barsFirstDate: bars?.firstDate ?? null,
      barsLastDate: bars?.lastDate ?? null,
    };
  });
}
