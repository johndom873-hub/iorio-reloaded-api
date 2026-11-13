import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { openBacktestDataFileReadOnly } from "./backtestDataFile.js";
import { currentBusinessFromOf } from "../lib/tickerBusinessChanges.js";
import { countFileDailyBars } from "./backtestFileStockBars.js";
import { normalizeBacktestSymbol, requireBacktestDataDirectory } from "./backtestDataDirectory.js";
import { calendarDaysBetween } from "../lib/easternIsoDate.js";
import { dataFileNearExpiryDays, type BacktestDataFileIssues, type BacktestDataFilePart, type BacktestDataFileSummary } from "./backtestTypes.js";
import { addCalendarDays, isWeekendDate, weekdaysBetweenInclusive } from "./jobs/backtestJobRules.js";
import type { DataFileCoverage, DataFilePeriodContents } from "./jobs/backtestSessionRequest.js";
import { readSplitScheduleCache, splitScheduleFingerprint, splitScheduleFingerprintsMatch } from "./engine/splitFactors.js";
import { dayNumberOf, dayNumberOfKey, daysToExpiryOfKey, sliceKey, tenOClockLookMinute } from "./engine/symbolFileSlices.js";

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
    // A ticker whose business changed holds nothing before the change (tickerBusinessChanges.ts).
    const from = currentBusinessFromOf(symbol) ?? "0000-01-01";
    const range = database.prepare("SELECT min(trading_date) AS firstDate, max(trading_date) AS lastDate, count(*) AS completeDays FROM days WHERE status = 'complete' AND trading_date >= ?").get(from) as {
      firstDate: string | null;
      lastDate: string | null;
      completeDays: number;
    };
    // The data-quality and intraday tables were added after the first downloads: a file may lack them.
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    const countOf = (sql: string) => Number((database.prepare(sql).get(from) as { count: number }).count);
    const quality = {
      daysWithIssues: tableNames.has("day_issues") ? countOf("SELECT count(DISTINCT trading_date) AS count FROM day_issues WHERE trading_date >= ?") : 0,
      unavailableDays: tableNames.has("unavailable_days") ? countOf("SELECT count(*) AS count FROM unavailable_days WHERE trading_date >= ?") : 0,
      intradayDays: tableNames.has("intraday_days") ? countOf("SELECT count(*) AS count FROM intraday_days WHERE status = 'complete' AND trading_date >= ?") : null,
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
export function readBacktestDataFilePeriodContents(symbol: string, requestedStartDate: string, endDate: string): DataFilePeriodContents | null {
  // A ticker whose business changed holds nothing before the change (tickerBusinessChanges.ts).
  const currentBusinessFrom = currentBusinessFromOf(symbol);
  const startDate = currentBusinessFrom !== null && currentBusinessFrom > requestedStartDate ? currentBusinessFrom : requestedStartDate;
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return null;
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    const datesOf = (sql: string) => new Set((database.prepare(sql).all(startDate, endDate) as { tradingDate: string }[]).map((row) => row.tradingDate));
    const storedDays = tableNames.has("days") ? datesOf("SELECT trading_date AS tradingDate FROM days WHERE trading_date BETWEEN ? AND ?") : new Set<string>();
    const completeDays = tableNames.has("days") ? datesOf("SELECT trading_date AS tradingDate FROM days WHERE status = 'complete' AND trading_date BETWEEN ? AND ?") : new Set<string>();
    const unavailableDays = tableNames.has("unavailable_days") ? datesOf("SELECT trading_date AS tradingDate FROM unavailable_days WHERE trading_date BETWEEN ? AND ?") : new Set<string>();
    // As the engine reads them (BacktestSymbolFile.loadIntradayDays).
    const intradayDays = tableNames.has("intraday_days") ? datesOf("SELECT trading_date AS tradingDate FROM intraday_days WHERE status = 'complete' AND trading_date BETWEEN ? AND ?") : new Set<string>();
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

const noIssues: BacktestDataFileIssues = { notStored: [], partial: [], unavailable: [], farExpiries: [] };
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
    const allPartial = [...partialByKey.values()].map((entry) => ({ ...entry, parts: partOrder.filter((part) => entry.parts.includes(part)) }));

    // Open interest is the count at the previous session's close: none exists on a file's first day, nor on the day after
    // a day ThetaData has no 10:00 quotes for, so its absence there is not a fault.
    const storedDates = (database.prepare("SELECT trading_date AS tradingDate FROM days WHERE status = 'complete' ORDER BY trading_date").all() as { tradingDate: string }[]).map((row) => row.tradingDate);
    const daysWithoutQuotes = new Set(allPartial.filter((entry) => entry.expiry === null && entry.parts.includes("quotes")).map((entry) => entry.tradingDate));
    const openInterestCannotExist = (tradingDate: string) => {
      const index = storedDates.indexOf(tradingDate);
      return index === 0 || (index > 0 && daysWithoutQuotes.has(storedDates[index - 1]!));
    };
    const isFarExpiry = (entry: (typeof allPartial)[number]): entry is (typeof allPartial)[number] & { expiry: string } => entry.expiry !== null && calendarDaysBetween(entry.tradingDate, entry.expiry) > dataFileNearExpiryDays;
    const partial = allPartial.filter((entry) => !isFarExpiry(entry) && !(entry.expiry === null && entry.parts.length === 1 && entry.parts[0] === "open_interest" && entry.reason === "no data returned" && openInterestCannotExist(entry.tradingDate)));
    const farExpiries = allPartial.filter(isFarExpiry);

    const range = database.prepare("SELECT min(trading_date) AS firstDate, max(trading_date) AS lastDate FROM days WHERE status = 'complete'").get() as { firstDate: string | null; lastDate: string | null };
    const notStoredDates: string[] = [];
    if (range.firstDate && range.lastDate) {
      const storedDays = new Set((database.prepare("SELECT trading_date AS tradingDate FROM days WHERE trading_date BETWEEN ? AND ?").all(range.firstDate, range.lastDate) as { tradingDate: string }[]).map((row) => row.tradingDate));
      const unavailableDays = new Set(unavailable.map((row) => row.tradingDate));
      for (let day = range.firstDate; day <= range.lastDate; day = addCalendarDays(day, 1)) if (!isWeekendDate(day) && !storedDays.has(day) && !unavailableDays.has(day)) notStoredDates.push(day);
    }

    const issueDays = new Set([...notStoredDates, ...partial.map((entry) => entry.tradingDate), ...unavailable.map((entry) => entry.tradingDate)]).size;
    return { issueDays, issues: { notStored: weekdayRuns(notStoredDates), partial, unavailable, farExpiries } };
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

/** Each symbol's latest implied volatility in the local DB's IBKR daily bars (a fraction: 0.27 = 27%) and its day: the newest bar that has one. */
export async function loadLatestImpliedVolatility(symbols: readonly string[], connection: Knex = db): Promise<Map<string, { tradingDate: string; impliedVolatility: number }>> {
  if (symbols.length === 0) return new Map();
  const result: { rows: { symbol: string; trading_date: string; implied_volatility: string }[] } = await connection.raw(
    `SELECT t.symbol, latest.trading_date::text AS trading_date, latest.implied_volatility
     FROM tickers t
     CROSS JOIN LATERAL (
       SELECT b.trading_date, b.implied_volatility FROM daily_price_bars b
       WHERE b.ticker_id = t.id AND b.implied_volatility IS NOT NULL
       ORDER BY b.trading_date DESC LIMIT 1
     ) latest
     WHERE t.symbol = ANY(?)`,
    [[...symbols]],
  );
  return new Map(result.rows.map((row) => [row.symbol, { tradingDate: row.trading_date, impliedVolatility: Number(row.implied_volatility) }]));
}

/** How many full Monday-to-Friday weeks the Expiries column looks at. */
export const expiryWeeksMeasured = 4;

/** The Monday (as a day number) of each of the last `count` full Monday-to-Friday weeks that end on or before `lastDayNumber`, newest first. */
export function lastFullWeekMondays(lastDayNumber: number, count: number): number[] {
  const weekdayIndex = (lastDayNumber + 3) % 7; // 1970-01-01 was a Thursday; Monday = 0
  const mondayOfLastWeek = lastDayNumber - weekdayIndex;
  const newestMonday = weekdayIndex >= 4 ? mondayOfLastWeek : mondayOfLastWeek - 7;
  return Array.from({ length: count }, (_, weeksBack) => newestMonday - 7 * weeksBack);
}

/** The median of the weekly expiry counts; 0.5 apart from a whole number when an even count of weeks has two middle values that differ. Null without a week. */
export function medianOfWeeklyExpiryCounts(weeklyCounts: readonly number[]): number | null {
  if (weeklyCounts.length === 0) return null;
  const sorted = [...weeklyCounts].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Expiries a week: in each of the last 4 full Monday-to-Friday weeks before the file's last day, the distinct expirations
 * (with a Call quoted at 10:00) that fall on a weekday of that week, taken from every stored day of the week (a Monday
 * holds the week's whole set; the other days cover a missing one); the median of those weeks. Weeks with no stored day
 * are left out. A daily-expiry ticker reads 5, Monday-Wednesday-Friday 3, weekly only 1. Null without a file, slices or a full week.
 */
export function readBacktestDataFileExpiriesPerWeek(symbol: string, lastDate: string | null): number | null {
  if (!lastDate) return null;
  const mondays = lastFullWeekMondays(dayNumberOf(lastDate), expiryWeeksMeasured);
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return null;
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    const hasSlices = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'ten_oclock_quote_slices'").get();
    if (!hasSlices) return null;
    const oldestMonday = mondays.at(-1)!;
    const newestFriday = mondays[0]! + 4;
    const keys = database
      .prepare("SELECT key FROM ten_oclock_quote_slices WHERE key BETWEEN ? AND ? AND call_count > 0")
      .all(sliceKey(oldestMonday, tenOClockLookMinute, 0), sliceKey(newestFriday, tenOClockLookMinute, 65_535)) as { key: number }[];
    const expiryDaysByMonday = new Map<number, Set<number>>(mondays.map((monday) => [monday, new Set<number>()]));
    for (const { key } of keys) {
      const tradingDay = dayNumberOfKey(key);
      const monday = tradingDay - ((tradingDay + 3) % 7);
      const expiryDay = tradingDay + daysToExpiryOfKey(key);
      if (expiryDay >= monday && expiryDay <= monday + 4) expiryDaysByMonday.get(monday)?.add(expiryDay);
    }
    return medianOfWeeklyExpiryCounts([...expiryDaysByMonday.values()].filter((expiryDays) => expiryDays.size > 0).map((expiryDays) => expiryDays.size));
  } finally {
    database.close();
  }
}

export async function summarizeBacktestDataFiles(connection: Knex = db): Promise<BacktestDataFileSummary[]> {
  const symbols = listBacktestDataFileSymbols();
  const dataDirectory = requireBacktestDataDirectory();
  const [barRanges, latestImpliedVolatility] = await Promise.all([loadDailyBarRanges(symbols, connection), loadLatestImpliedVolatility(symbols, connection)]);
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
    const impliedVolatility = latestImpliedVolatility.get(symbol);
    let expiriesPerWeek: number | null = null;
    try {
      expiriesPerWeek = readBacktestDataFileExpiriesPerWeek(symbol, contents.lastDate);
    } catch (error) {
      console.warn(`Backtest data file ${symbol}.sqlite's expiries a week could not be read: ${error instanceof Error ? error.message : error}`);
    }
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
      latestImpliedVolatility: impliedVolatility?.impliedVolatility ?? null,
      latestImpliedVolatilityDate: impliedVolatility?.tradingDate ?? null,
      expiriesPerWeek,
      ...issues,
    };
  });
}
