import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { openBacktestDataFileReadOnly } from "./backtestDataFile.js";
import { countFileDailyBars } from "./backtestFileStockBars.js";
import { normalizeBacktestSymbol, requireBacktestDataDirectory } from "./backtestDataDirectory.js";
import type { BacktestDataFileIssues, BacktestDataFilePart, BacktestDataFileSummary } from "./backtestTypes.js";
import { addCalendarDays, isWeekendDate, weekdaysBetweenInclusive } from "./jobs/backtestJobRules.js";
import type { DataFileCoverage, DataFilePeriodContents } from "./jobs/backtestSessionRequest.js";
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
  /** Days with a day_issues row; 0 when the file has no such table. */
  daysWithIssues: number;
  /** unavailable_days rows; 0 when the file has no such table. */
  unavailableDays: number;
  /** Complete intraday_days rows; null when the file has no such table. */
  intradayDays: number | null;
}

const emptyContents: DataFileContents = { firstDate: null, lastDate: null, completeDays: 0, missingWeekdays: 0, daysWithIssues: 0, unavailableDays: 0, intradayDays: null };

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
    // The data-quality and intraday tables were added after the first downloads: a file may lack them.
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    const countOf = (sql: string) => Number((database.prepare(sql).get() as { count: number }).count);
    const quality = {
      daysWithIssues: tableNames.has("day_issues") ? countOf("SELECT count(DISTINCT trading_date) AS count FROM day_issues") : 0,
      unavailableDays: tableNames.has("unavailable_days") ? countOf("SELECT count(*) AS count FROM unavailable_days") : 0,
      intradayDays: tableNames.has("intraday_days") ? countOf("SELECT count(*) AS count FROM intraday_days WHERE status = 'complete'") : null,
    };
    if (!range.firstDate || !range.lastDate) return { ...emptyContents, ...quality, completeDays: Number(range.completeDays) };
    const storedDays = database.prepare("SELECT trading_date AS tradingDate FROM days WHERE trading_date BETWEEN ? AND ?").all(range.firstDate, range.lastDate) as { tradingDate: string }[];
    const storedWeekdays = storedDays.filter((day) => !isWeekendDate(day.tradingDate)).length;
    return {
      firstDate: range.firstDate,
      lastDate: range.lastDate,
      completeDays: Number(range.completeDays),
      missingWeekdays: Math.max(0, weekdaysBetweenInclusive(range.firstDate, range.lastDate) - storedWeekdays),
      ...quality,
    };
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return emptyContents;
    throw error;
  } finally {
    database.close();
  }
}

/**
 * What the file holds inside a session's period: the weekdays it has no `days` row for (a download not finished; a day
 * the downloader recorded as unavailable is not one of them), and how many of its complete days lack intraday quotes.
 * Null when the symbol has no file.
 */
export function readBacktestDataFilePeriodContents(symbol: string, startDate: string, endDate: string): DataFilePeriodContents | null {
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return null;
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    const datesOf = (sql: string) => new Set((database.prepare(sql).all(startDate, endDate) as { tradingDate: string }[]).map((row) => row.tradingDate));
    const storedDays = tableNames.has("days") ? datesOf("SELECT trading_date AS tradingDate FROM days WHERE trading_date BETWEEN ? AND ?") : new Set<string>();
    const completeDays = tableNames.has("days") ? datesOf("SELECT trading_date AS tradingDate FROM days WHERE status = 'complete' AND trading_date BETWEEN ? AND ?") : new Set<string>();
    const unavailableDays = tableNames.has("unavailable_days") ? datesOf("SELECT trading_date AS tradingDate FROM unavailable_days WHERE trading_date BETWEEN ? AND ?") : new Set<string>();
    // As the engine reads them (BacktestSymbolFile.loadIntradayDays): a day counts when its quotes are there to read (in
    // intraday_quotes, or a schema 4 file's slices).
    const intradayDays = tableNames.has("intraday_days") && (tableNames.has("intraday_quotes") || tableNames.has("option_quote_slices")) ? datesOf("SELECT trading_date AS tradingDate FROM intraday_days WHERE status = 'complete' AND trading_date BETWEEN ? AND ?") : new Set<string>();
    const missingWeekdays: string[] = [];
    for (let day = startDate; day <= endDate; day = addCalendarDays(day, 1)) if (!isWeekendDate(day) && !storedDays.has(day) && !unavailableDays.has(day)) missingWeekdays.push(day);
    return {
      missingWeekdays: missingWeekdays.length,
      firstMissingWeekday: missingWeekdays[0] ?? null,
      lastMissingWeekday: missingWeekdays.at(-1) ?? null,
      completeDays: completeDays.size,
      completeDaysWithoutIntradayQuotes: [...completeDays].filter((day) => !intradayDays.has(day)).length,
    };
  } finally {
    database.close();
  }
}

const noIssues: BacktestDataFileIssues = { notStored: [], partial: [], unavailable: [] };
const partOrder: BacktestDataFilePart[] = ["quotes", "intraday_quotes", "eod", "open_interest"];
/** unavailable_days.reason starts with the part it is about (docs/backtesting/DATA-FILES.md). */
const unavailableReasonPrefixes: { prefix: string; part: BacktestDataFilePart }[] = [
  { prefix: "quotes at 10:00: ", part: "quotes" },
  { prefix: "end of day: ", part: "eod" },
  { prefix: "open interest: ", part: "open_interest" },
  { prefix: "intraday quotes: ", part: "intraday_quotes" },
];

/** The downloader's error, in a few plain words: ThetaData's malformed and corrupt answers named as such, otherwise its own text. */
export function plainDownloaderReason(message: string): string {
  if (/no data returned/i.test(message)) return "no data returned";
  if (/Wrong number of data fields/i.test(message)) return "ThetaData sent malformed data";
  if (/Corrupt FIT data/i.test(message)) return "ThetaData sent corrupt data";
  if (/failed to connect|Network is unreachable/i.test(message)) return "ThetaData could not be reached";
  const failedWith = /failed \((.*)\)\s*$/s.exec(message)?.[1] ?? message;
  return failedWith.length > 120 ? `${failedWith.slice(0, 117)}…` : failedWith;
}

/** Consecutive weekdays (a weekend between two of them does not break a run), from dates sorted ascending. */
function weekdayRuns(dates: readonly string[]): BacktestDataFileIssues["notStored"] {
  const runs: BacktestDataFileIssues["notStored"] = [];
  for (const date of dates) {
    const last = runs.at(-1);
    let nextWeekday = last ? addCalendarDays(last.lastDate, 1) : null;
    while (nextWeekday && isWeekendDate(nextWeekday)) nextWeekday = addCalendarDays(nextWeekday, 1);
    if (last && nextWeekday === date) {
      last.lastDate = date;
      last.weekdays += 1;
    } else runs.push({ firstDate: date, lastDate: date, weekdays: 1 });
  }
  return runs;
}

/** The file's issues (BacktestDataFileIssues) and how many distinct days they cover; none when the symbol has no file. */
export function readBacktestDataFileIssues(symbol: string): { issueDays: number; issues: BacktestDataFileIssues } {
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return { issueDays: 0, issues: noIssues };
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    if (!tableNames.has("days")) return { issueDays: 0, issues: noIssues };
    const unavailableRows = tableNames.has("unavailable_days") ? (database.prepare("SELECT trading_date AS tradingDate, reason FROM unavailable_days ORDER BY trading_date").all() as { tradingDate: string; reason: string }[]) : [];
    const unavailable = unavailableRows.map((row) => {
      const matched = unavailableReasonPrefixes.find((candidate) => row.reason.startsWith(candidate.prefix));
      return { tradingDate: row.tradingDate, part: matched?.part ?? null, reason: plainDownloaderReason(matched ? row.reason.slice(matched.prefix.length) : row.reason) };
    });

    const issueRows = tableNames.has("day_issues") ? (database.prepare("SELECT trading_date AS tradingDate, part, expiry, message FROM day_issues ORDER BY trading_date, expiry").all() as { tradingDate: string; part: BacktestDataFilePart; expiry: string | null; message: string }[]) : [];
    const partialByKey = new Map<string, BacktestDataFileIssues["partial"][number]>();
    for (const row of issueRows) {
      const reason = plainDownloaderReason(row.message);
      const key = `${row.tradingDate}|${row.expiry ?? ""}|${reason}`;
      const entry = partialByKey.get(key) ?? { tradingDate: row.tradingDate, expiry: row.expiry, parts: [], reason };
      if (!entry.parts.includes(row.part)) entry.parts.push(row.part);
      partialByKey.set(key, entry);
    }
    const partial = [...partialByKey.values()].map((entry) => ({ ...entry, parts: partOrder.filter((part) => entry.parts.includes(part)) }));

    const range = database.prepare("SELECT min(trading_date) AS firstDate, max(trading_date) AS lastDate FROM days WHERE status = 'complete'").get() as { firstDate: string | null; lastDate: string | null };
    const notStoredDates: string[] = [];
    if (range.firstDate && range.lastDate) {
      const storedDays = new Set((database.prepare("SELECT trading_date AS tradingDate FROM days WHERE trading_date BETWEEN ? AND ?").all(range.firstDate, range.lastDate) as { tradingDate: string }[]).map((row) => row.tradingDate));
      const unavailableDays = new Set(unavailable.map((row) => row.tradingDate));
      for (let day = range.firstDate; day <= range.lastDate; day = addCalendarDays(day, 1)) if (!isWeekendDate(day) && !storedDays.has(day) && !unavailableDays.has(day)) notStoredDates.push(day);
    }

    const issueDays = new Set([...notStoredDates, ...partial.map((entry) => entry.tradingDate), ...unavailable.map((entry) => entry.tradingDate)]).size;
    return { issueDays, issues: { notStored: weekdayRuns(notStoredDates), partial, unavailable } };
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

/** The IBKR daily bars the split schedule is checked against, as refreshSplitScheduleForSymbol picks them: the file's own, else the local DB's. */
function splitCheckBars(symbol: string, localDatabaseBars: { lastDate: string; count: number } | undefined): { lastDate: string; count: number } | undefined {
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return localDatabaseBars;
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    return countFileDailyBars(database) ?? localDatabaseBars;
  } finally {
    database.close();
  }
}

/** The splits the engine cached for the file (splitFactors.ts), only while the file and the bars are what they were inferred from; never inferred here. */
function cachedDetectedSplits(dataDirectory: string, symbol: string, contents: DataFileContents, localDatabaseBars: { lastDate: string; count: number } | undefined): BacktestDataFileSummary["detectedSplits"] {
  const cache = readSplitScheduleCache(dataDirectory, symbol);
  if (!cache) return null;
  const bars = splitCheckBars(symbol, localDatabaseBars);
  const current = splitScheduleFingerprint(contents.completeDays, contents.lastDate, bars?.count ?? 0, bars?.lastDate ?? null);
  return splitScheduleFingerprintsMatch(cache.fingerprint, current) ? cache.schedule.splits : null;
}

export async function summarizeBacktestDataFiles(connection: Knex = db): Promise<BacktestDataFileSummary[]> {
  const symbols = listBacktestDataFileSymbols();
  const dataDirectory = requireBacktestDataDirectory();
  const barRanges = await loadDailyBarRanges(symbols, connection);
  return symbols.map((symbol) => {
    let contents = emptyContents;
    let issues: ReturnType<typeof readBacktestDataFileIssues> = { issueDays: 0, issues: noIssues };
    try {
      contents = readBacktestDataFileContents(symbol) ?? emptyContents;
      issues = readBacktestDataFileIssues(symbol);
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
      daysWithIssues: contents.daysWithIssues,
      unavailableDays: contents.unavailableDays,
      intradayDays: contents.intradayDays,
      sizeBytes: dataFileSizeBytes(symbol),
      barsFirstDate: bars?.firstDate ?? null,
      barsLastDate: bars?.lastDate ?? null,
      barsCount: bars?.count ?? 0,
      ...issues,
    };
  });
}
