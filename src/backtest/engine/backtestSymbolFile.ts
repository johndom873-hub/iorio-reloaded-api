import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { readFileDailyBars, readFileIntradayPrices, type FileIntradayPrices } from "../backtestFileStockBars.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import type { StoredDailyBar } from "./backtestBarHistory.js";

// Read access to one symbol's ThetaData file (docs/backtesting/DATA-FILES.md, schema versions 1 to 3): the days it
// holds, each day's 10:00 quotes, its end-of-day rows and the open interest published for it, and, where the file has
// them, the quotes at each look inside the day (intraday_days, intraday_quotes) and what the downloader could not
// retrieve (day_issues, unavailable_days); and IBKR's stock bars Node keeps in it (the stock prices). Read-only; the
// downloader and the IBKR bars step write it.

export interface SymbolFileDay {
  tradingDate: string;
  status: "complete" | "no_data";
}

export interface SymbolFileQuote {
  expiry: string;
  strike: number;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
}

export interface SymbolFileEndOfDayRow {
  expiry: string;
  strike: number;
  right: "C" | "P";
  close: number | null;
  volume: number | null;
  /** The closing NBBO. */
  bid: number | null;
  ask: number | null;
}

/** A part of a stored day the downloader could not retrieve: all of it (expiry null) or one expiration. */
export interface SymbolFileDayIssue {
  tradingDate: string;
  part: "quotes" | "eod" | "open_interest" | "intraday_quotes";
  expiry: string | null;
  message: string;
}

export const supportedSymbolFileSchemaVersions: readonly string[] = ["1", "2", "3"];

export const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * The expiries the engine reads: 0..45 days out for the 10:00 and intraday quotes, 0..46 for the end of day and the open
 * interest, all that files held before the downloader kept every expiry (schema 3).
 */
export const expiresWithin45DaysSql = "expiry <= date(trading_date, '+45 days')";
const expiresWithin46DaysSql = "expiry <= date(trading_date, '+46 days')";
/** A day's issues about what the engine reads: a whole part, or an expiration within the part's window above. */
const issueWithinReadWindowSql = `(expiry IS NULL OR (part IN ('quotes', 'intraday_quotes') AND ${expiresWithin45DaysSql}) OR (part IN ('eod', 'open_interest') AND ${expiresWithin46DaysSql}))`;

/** A day's 10:00 quotes, end-of-day rows and open interest: the statements the engine reads them with (also on the day-data reader thread). */
export const quotesOfDaySql = `SELECT expiry, strike, option_right AS right, bid, ask, bid_size AS bidSize, ask_size AS askSize FROM quotes WHERE trading_date = ? AND ${expiresWithin45DaysSql}`;
export const endOfDayOfDaySql = `SELECT expiry, strike, option_right AS right, close, volume, bid, ask FROM eod WHERE trading_date = ? AND ${expiresWithin46DaysSql}`;
export const openInterestOfDaySql = `SELECT expiry, strike, option_right AS right, open_interest AS openInterest FROM open_interest WHERE trading_date = ? AND ${expiresWithin46DaysSql}`;
/** The columns an intraday look reads, in primary-key order (look time, expiry, strike, right) within the day; read with expiresWithin45DaysSql. */
export const intradayQuotesColumnsSql = "SELECT look_time, expiry, strike, option_right, bid, ask FROM intraday_quotes";

export class BacktestSymbolFile {
  private readonly daysStatement: StatementSync;
  private readonly quotesStatement: StatementSync;
  private readonly endOfDayStatement: StatementSync;
  private readonly openInterestStatement: StatementSync;
  /** Null on a file downloaded before the table existed. */
  private readonly dayIssuesStatement: StatementSync | null;
  private readonly unavailableDaysStatement: StatementSync | null;
  private readonly intradayDaysStatement: StatementSync | null;
  private readonly intradayQuotesStatement: StatementSync | null;
  private readonly putExpiriesStatement: StatementSync;
  private readonly putQuotesOfExpiryStatement: StatementSync;
  private readonly intradayPutQuotesOfExpiryStatement: StatementSync | null;
  private readonly callExpiriesStatement: StatementSync;
  private readonly callQuotesOfExpiryStatement: StatementSync;

  constructor(private readonly database: DatabaseSync) {
    // The downloader may be committing a day: wait for its lock instead of failing.
    database.exec("PRAGMA busy_timeout = 3000");
    const version = (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
    if (version === undefined || !supportedSymbolFileSchemaVersions.includes(version)) throw new Error(`The data file has schema version ${version ?? "unknown"}; the engine reads versions ${supportedSymbolFileSchemaVersions.join(", ")}.`);
    this.daysStatement = database.prepare("SELECT trading_date AS tradingDate, status FROM days ORDER BY trading_date");
    this.quotesStatement = database.prepare(quotesOfDaySql);
    this.endOfDayStatement = database.prepare(endOfDayOfDaySql);
    this.openInterestStatement = database.prepare(openInterestOfDaySql);
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    this.dayIssuesStatement = tableNames.has("day_issues") ? database.prepare(`SELECT trading_date AS tradingDate, part, expiry, message FROM day_issues WHERE trading_date = ? AND ${issueWithinReadWindowSql} ORDER BY part, expiry`) : null;
    this.unavailableDaysStatement = tableNames.has("unavailable_days") ? database.prepare("SELECT trading_date AS tradingDate, reason FROM unavailable_days ORDER BY trading_date") : null;
    const hasIntradayTables = tableNames.has("intraday_days") && tableNames.has("intraday_quotes");
    this.intradayDaysStatement = hasIntradayTables ? database.prepare("SELECT trading_date AS tradingDate FROM intraday_days WHERE status = 'complete' ORDER BY trading_date") : null;
    // Read by the thousand rows a day and look: only what a look reads (not the sizes), each row as an array.
    this.intradayQuotesStatement = hasIntradayTables ? database.prepare(`${intradayQuotesColumnsSql} WHERE trading_date = ? AND look_time > ? AND look_time <= ? AND strike BETWEEN ? AND ? AND ${expiresWithin45DaysSql}`) : null;
    this.intradayQuotesStatement?.setReturnArrays(true);
    // The hedge's long-dated Puts (backtestBaselineHedge.ts), past the 45-day window, one expiry at a time by the primary key.
    this.putExpiriesStatement = database.prepare("SELECT DISTINCT expiry FROM quotes WHERE trading_date = ? AND option_right = 'P' ORDER BY expiry");
    this.putQuotesOfExpiryStatement = database.prepare("SELECT strike, bid, ask, bid_size AS bidSize, ask_size AS askSize FROM quotes WHERE trading_date = ? AND expiry = ? AND option_right = 'P'");
    this.intradayPutQuotesOfExpiryStatement = hasIntradayTables ? database.prepare("SELECT strike, bid, ask FROM intraday_quotes WHERE trading_date = ? AND look_time = ? AND expiry = ? AND option_right = 'P'") : null;
    this.callExpiriesStatement = database.prepare("SELECT DISTINCT expiry FROM quotes WHERE trading_date = ? AND option_right = 'C' ORDER BY expiry");
    this.callQuotesOfExpiryStatement = database.prepare("SELECT strike, bid, ask, bid_size AS bidSize, ask_size AS askSize FROM quotes WHERE trading_date = ? AND expiry = ? AND option_right = 'C'");
  }

  /** Opens the symbol's file from BACKTEST_DATA_DIR; throws when it has not been downloaded. */
  static open(symbol: string): BacktestSymbolFile {
    const database = openBacktestDataFileReadOnly(symbol);
    if (!database) throw new Error(`No data file for ${symbol}: download it first.`);
    try {
      return new BacktestSymbolFile(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  loadDays(): SymbolFileDay[] {
    return this.daysStatement.all() as unknown as SymbolFileDay[];
  }

  /** IBKR's daily bars kept in the file (backtestFileStockBars.ts), ascending; null when it has none. */
  loadIbkrDailyBars(): StoredDailyBar[] | null {
    return readFileDailyBars(this.database);
  }

  /** IBKR's 30-minute bars kept in the file, as the stock's price at a look; null when it has none. */
  loadIbkrIntradayPrices(fromDateIso: string, toDateIso: string): FileIntradayPrices | null {
    return readFileIntradayPrices(this.database, fromDateIso, toDateIso);
  }

  loadQuotes(tradingDate: string): SymbolFileQuote[] {
    return (this.quotesStatement.all(tradingDate) as Record<string, unknown>[]).map((row) => ({
      expiry: String(row.expiry),
      strike: Number(row.strike),
      right: row.right as "C" | "P",
      bid: numberOrNull(row.bid),
      ask: numberOrNull(row.ask),
      bidSize: numberOrNull(row.bidSize),
      askSize: numberOrNull(row.askSize),
    }));
  }

  loadEndOfDay(tradingDate: string): SymbolFileEndOfDayRow[] {
    return (this.endOfDayStatement.all(tradingDate) as Record<string, unknown>[]).map((row) => ({
      expiry: String(row.expiry),
      strike: Number(row.strike),
      right: row.right as "C" | "P",
      close: numberOrNull(row.close),
      volume: numberOrNull(row.volume),
      bid: numberOrNull(row.bid),
      ask: numberOrNull(row.ask),
    }));
  }

  /** Open interest as published for the day (the previous session's close), by contractKey. */
  loadOpenInterest(tradingDate: string): Map<string, number> {
    const rows = this.openInterestStatement.all(tradingDate) as { expiry: string; strike: number; right: "C" | "P"; openInterest: number }[];
    return new Map(rows.map((row) => [contractKey({ expiry: String(row.expiry), strike: Number(row.strike), right: row.right }), Number(row.openInterest)]));
  }

  /** What the downloader could not retrieve of a stored day, among what the engine reads (issueWithinReadWindowSql); none on a file without the table. */
  loadDayIssues(tradingDate: string): SymbolFileDayIssue[] {
    if (!this.dayIssuesStatement) return [];
    return (this.dayIssuesStatement.all(tradingDate) as Record<string, unknown>[]).map((row) => ({ tradingDate: String(row.tradingDate), part: row.part as SymbolFileDayIssue["part"], expiry: row.expiry === null || row.expiry === undefined ? null : String(row.expiry), message: String(row.message) }));
  }

  /** Days the downloader could not retrieve, ascending: no 10:00 quotes (the day has no `days` row) or no intraday quotes (it has one). None on a file without the table. */
  loadUnavailableDays(): { tradingDate: string; reason: string }[] {
    if (!this.unavailableDaysStatement) return [];
    return (this.unavailableDaysStatement.all() as Record<string, unknown>[]).map((row) => ({ tradingDate: String(row.tradingDate), reason: String(row.reason) }));
  }

  /** The days whose intraday quotes are stored. None on a file downloaded before intraday quotes existed. */
  loadIntradayDays(): Set<string> {
    if (!this.intradayDaysStatement) return new Set();
    return new Set((this.intradayDaysStatement.all() as { tradingDate: string }[]).map((row) => String(row.tradingDate)));
  }

  /**
   * A day's quotes at the looks after `afterLookTime` up to `throughLookTime` ("HH:MM" Eastern), by look time, for the
   * strikes from `lowestStrike` to `highestStrike`, without their sizes. The downloader stores every look ThetaData
   * returns, also those after an early close (repeats of the closing quotes): the caller says which looks count.
   */
  loadIntradayQuotes(tradingDate: string, afterLookTime: string, throughLookTime: string, lowestStrike: number, highestStrike: number): Map<string, SymbolFileQuote[]> {
    const quotesByLookTime = new Map<string, SymbolFileQuote[]>();
    if (!this.intradayQuotesStatement) return quotesByLookTime;
    for (const [lookTime, expiry, strike, right, bid, ask] of this.intradayQuotesStatement.all(tradingDate, afterLookTime, throughLookTime, lowestStrike, highestStrike) as unknown as [string, string, number, "C" | "P", number | null, number | null][]) {
      let quotes = quotesByLookTime.get(lookTime);
      if (!quotes) quotesByLookTime.set(lookTime, (quotes = []));
      quotes.push({ expiry, strike, right, bid, ask, bidSize: null, askSize: null });
    }
    return quotesByLookTime;
  }

  /** Every Put expiry the day's 10:00 quotes hold, ascending, whatever its distance (the hedge's; files of schema 3 hold every expiry). */
  loadPutExpiries(tradingDate: string): string[] {
    return (this.putExpiriesStatement.all(tradingDate) as { expiry: string }[]).map((row) => String(row.expiry));
  }

  /** One expiry's Puts at 10:00, with their sizes. */
  loadPutQuotesOfExpiry(tradingDate: string, expiry: string): SymbolFileQuote[] {
    return (this.putQuotesOfExpiryStatement.all(tradingDate, expiry) as Record<string, unknown>[]).map((row) => ({ expiry, strike: Number(row.strike), right: "P" as const, bid: numberOrNull(row.bid), ask: numberOrNull(row.ask), bidSize: numberOrNull(row.bidSize), askSize: numberOrNull(row.askSize) }));
  }

  /** One expiry's Puts at a look after 10:00 ("HH:MM" Eastern), without their sizes; none on a file without intraday quotes. */
  loadIntradayPutQuotesOfExpiry(tradingDate: string, lookTime: string, expiry: string): SymbolFileQuote[] {
    if (!this.intradayPutQuotesOfExpiryStatement) return [];
    return (this.intradayPutQuotesOfExpiryStatement.all(tradingDate, lookTime, expiry) as Record<string, unknown>[]).map((row) => ({ expiry, strike: Number(row.strike), right: "P" as const, bid: numberOrNull(row.bid), ask: numberOrNull(row.ask), bidSize: null, askSize: null }));
  }

  /** Every Call expiry the day's 10:00 quotes hold, ascending, whatever its distance (Vol Farmer v2's LEAPS). */
  loadCallExpiries(tradingDate: string): string[] {
    return (this.callExpiriesStatement.all(tradingDate) as { expiry: string }[]).map((row) => String(row.expiry));
  }

  /** One expiry's Calls at 10:00, with their sizes. */
  loadCallQuotesOfExpiry(tradingDate: string, expiry: string): SymbolFileQuote[] {
    return (this.callQuotesOfExpiryStatement.all(tradingDate, expiry) as Record<string, unknown>[]).map((row) => ({ expiry, strike: Number(row.strike), right: "C" as const, bid: numberOrNull(row.bid), ask: numberOrNull(row.ask), bidSize: numberOrNull(row.bidSize), askSize: numberOrNull(row.askSize) }));
  }

  close(): void {
    this.database.close();
  }
}
