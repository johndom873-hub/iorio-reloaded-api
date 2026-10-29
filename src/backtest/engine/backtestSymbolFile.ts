import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { readFileDailyBars, readFileIntradayPrices, type FileIntradayPrices } from "../backtestFileStockBars.js";
import type { StoredDailyBar } from "./backtestBarHistory.js";
import { SymbolFileSliceReads } from "./symbolFileSliceReads.js";

// Read access to one symbol's ThetaData file (docs/backtesting/DATA-FILES.md, schema versions 1 to 4; 4 through
// symbolFileSliceReads.ts): the days it
// holds, each day's 10:00 quotes and end-of-day rows, and, where the file has them, the quotes at each look inside the
// day (intraday_days, intraday_quotes) and what the downloader could not retrieve (day_issues, unavailable_days); and
// IBKR's stock bars Node keeps in it (the stock prices). The open interest the files hold is not read: no rule uses it.
// Read-only; the downloader and the IBKR bars step write it.

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

/**
 * What Vol Farmer v2 reads of a day (it decides on the next Call expiry only), each part as the full read would give it
 * (loadNextCallExpiryDay).
 */
export interface NextCallExpiryDay {
  /** The first Call expiry after the day within the 45-day window; null when there is none. */
  expiry: string | null;
  /** That expiry's quotes, as loadQuotes holds them. */
  quotes: SymbolFileQuote[];
  /** How many of loadQuotes' quotes each right has. */
  quoteCountByRight: { C: number; P: number };
  /** Whether one of loadQuotes' quotes has an ask above 0. */
  hasAskAboveZero: boolean;
  /** The previous file day's end-of-day rows of `expiry`, as loadEndOfDay holds them there; none without either. */
  previousEndOfDay: SymbolFileEndOfDayRow[];
  /** Whether one of the previous file day's loadEndOfDay rows has a volume; null without a previous day. */
  previousHasVolume: boolean | null;
}

export const supportedSymbolFileSchemaVersions: readonly string[] = ["1", "2", "3", "4"];

export const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** The conversions of every 10:00 quote and end-of-day row read. */
export const quoteOfRow = (row: Record<string, unknown>): SymbolFileQuote => ({ expiry: String(row.expiry), strike: Number(row.strike), right: row.right as "C" | "P", bid: numberOrNull(row.bid), ask: numberOrNull(row.ask), bidSize: numberOrNull(row.bidSize), askSize: numberOrNull(row.askSize) });
export const endOfDayOfRow = (row: Record<string, unknown>): SymbolFileEndOfDayRow => ({ expiry: String(row.expiry), strike: Number(row.strike), right: row.right as "C" | "P", close: numberOrNull(row.close), volume: numberOrNull(row.volume), bid: numberOrNull(row.bid), ask: numberOrNull(row.ask) });

const dayIssueOfRow = (row: Record<string, unknown>): SymbolFileDayIssue => ({ tradingDate: String(row.tradingDate), part: row.part as SymbolFileDayIssue["part"], expiry: row.expiry === null || row.expiry === undefined ? null : String(row.expiry), message: String(row.message) });

/** Each right's count from quoteCountByRightSql's rows. */
export const quoteCountByRightOf = (rows: readonly { right: string; count: number }[]): { C: number; P: number } => ({ C: Number(rows.find((row) => row.right === "C")?.count ?? 0), P: Number(rows.find((row) => row.right === "P")?.count ?? 0) });

/**
 * The expiries the engine reads: 0..45 days out for the 10:00 and intraday quotes, 0..46 for the end of day (and the
 * open interest's download issues), all that files held before the downloader kept every expiry (schema 3).
 */
export const expiresWithin45DaysSql = "expiry <= date(trading_date, '+45 days')";
const expiresWithin46DaysSql = "expiry <= date(trading_date, '+46 days')";
/** A day's issues about what the engine reads: a whole part, or an expiration within the part's window above. */
const issueWithinReadWindowSql = `(expiry IS NULL OR (part IN ('quotes', 'intraday_quotes') AND ${expiresWithin45DaysSql}) OR (part IN ('eod', 'open_interest') AND ${expiresWithin46DaysSql}))`;

const quoteColumnsSql = "SELECT expiry, strike, option_right AS right, bid, ask, bid_size AS bidSize, ask_size AS askSize FROM quotes";
const endOfDayColumnsSql = "SELECT expiry, strike, option_right AS right, close, volume, bid, ask FROM eod";
/** A day's 10:00 quotes and end-of-day rows: the statements the engine reads them with (also on the day-data reader thread). */
export const quotesOfDaySql = `${quoteColumnsSql} WHERE trading_date = ? AND ${expiresWithin45DaysSql}`;
export const endOfDayOfDaySql = `${endOfDayColumnsSql} WHERE trading_date = ? AND ${expiresWithin46DaysSql}`;
/**
 * Vol Farmer v2's day (NextCallExpiryDay), read in place of every quote and end-of-day row: the first Call expiry after the
 * day within the 45-day window (its date passed three times), that expiry's quotes, each right's count within the window,
 * whether one of them has an ask above 0, and on the previous file day that expiry's end-of-day rows and whether a row
 * within the window has a volume (also on the day-data reader thread).
 */
export const nextCallExpirySql = "SELECT min(expiry) AS expiry FROM quotes WHERE trading_date = ? AND expiry > ? AND expiry <= date(?, '+45 days') AND option_right = 'C'";
export const quotesOfExpirySql = `${quoteColumnsSql} WHERE trading_date = ? AND expiry = ? AND ${expiresWithin45DaysSql}`;
export const quoteCountByRightSql = `SELECT option_right AS right, count(*) AS count FROM quotes WHERE trading_date = ? AND ${expiresWithin45DaysSql} GROUP BY option_right`;
export const quoteWithAskAboveZeroSql = `SELECT 1 AS found FROM quotes WHERE trading_date = ? AND ${expiresWithin45DaysSql} AND ask > 0 LIMIT 1`;
export const endOfDayOfExpirySql = `${endOfDayColumnsSql} WHERE trading_date = ? AND expiry = ? AND ${expiresWithin46DaysSql}`;
export const endOfDayWithVolumeSql = `SELECT 1 AS found FROM eod WHERE trading_date = ? AND ${expiresWithin46DaysSql} AND volume IS NOT NULL LIMIT 1`;
/** The columns an intraday look reads, in primary-key order (look time, expiry, strike, right) within the day; read with expiresWithin45DaysSql. */
export const intradayQuotesColumnsSql = "SELECT look_time, expiry, strike, option_right, bid, ask FROM intraday_quotes";
/** A day's first look time after the one given that has rows: one step down the primary key (also on the day-data reader thread). */
export const nextIntradayLookTimeSql = "SELECT min(look_time) AS lookTime FROM intraday_quotes WHERE trading_date = ? AND look_time > ?";
/** Whether a look holds a quote within the read window with a strike in a range (also on the day-data reader thread). */
export const intradayQuoteWithinSql = `SELECT 1 AS found FROM intraday_quotes WHERE trading_date = ? AND look_time = ? AND strike BETWEEN ? AND ? AND ${expiresWithin45DaysSql} LIMIT 1`;

export class BacktestSymbolFile {
  private readonly daysStatement: StatementSync;
  /** The option reads of a schema 4 file; null on earlier versions, which read with the statements below. */
  private readonly slices: SymbolFileSliceReads | null;
  private readonly quotesStatement!: StatementSync;
  private readonly endOfDayStatement!: StatementSync;
  private readonly nextCallExpiryStatement!: StatementSync;
  private readonly quotesOfExpiryStatement!: StatementSync;
  private readonly quoteCountByRightStatement!: StatementSync;
  private readonly quoteWithAskAboveZeroStatement!: StatementSync;
  private readonly endOfDayOfExpiryStatement!: StatementSync;
  private readonly endOfDayWithVolumeStatement!: StatementSync;
  private readonly quotesOfContractStatement!: StatementSync;
  private readonly endOfDayOfContractStatement!: StatementSync;
  /** Null on a file downloaded before the table existed. */
  private readonly dayIssuesStatement: StatementSync | null;
  private readonly unavailableDaysStatement: StatementSync | null;
  private readonly intradayDaysStatement: StatementSync | null;
  private readonly intradayQuotesStatement!: StatementSync | null;
  private readonly intradayQuotesOfContractStatement!: StatementSync | null;
  private readonly intradayQuoteWithinStatement!: StatementSync | null;
  private readonly nextIntradayLookTimeStatement!: StatementSync | null;
  private readonly putExpiriesStatement!: StatementSync;
  private readonly putQuotesOfExpiryStatement!: StatementSync;
  private readonly intradayPutQuotesOfExpiryStatement!: StatementSync | null;
  private readonly callExpiriesStatement!: StatementSync;
  private readonly callQuotesOfExpiryStatement!: StatementSync;
  private readonly intradayCallQuotesOfExpiryStatement!: StatementSync | null;

  constructor(private readonly database: DatabaseSync) {
    // The downloader may be committing a day: wait for its lock instead of failing.
    database.exec("PRAGMA busy_timeout = 3000");
    const version = (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
    if (version === undefined || !supportedSymbolFileSchemaVersions.includes(version)) throw new Error(`The data file has schema version ${version ?? "unknown"}; the engine reads versions ${supportedSymbolFileSchemaVersions.join(", ")}.`);
    this.daysStatement = database.prepare("SELECT trading_date AS tradingDate, status FROM days ORDER BY trading_date");
    const tableNames = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    this.dayIssuesStatement = tableNames.has("day_issues") ? database.prepare(`SELECT trading_date AS tradingDate, part, expiry, message FROM day_issues WHERE ${issueWithinReadWindowSql} ORDER BY trading_date, part, expiry`) : null;
    this.unavailableDaysStatement = tableNames.has("unavailable_days") ? database.prepare("SELECT trading_date AS tradingDate, reason FROM unavailable_days ORDER BY trading_date") : null;
    this.slices = version === "4" ? new SymbolFileSliceReads(database) : null;
    const hasIntradayTables = tableNames.has("intraday_days") && (tableNames.has("intraday_quotes") || this.slices !== null);
    this.intradayDaysStatement = hasIntradayTables ? database.prepare("SELECT trading_date AS tradingDate FROM intraday_days WHERE status = 'complete' ORDER BY trading_date") : null;
    if (this.slices !== null) return;
    this.quotesStatement = database.prepare(quotesOfDaySql);
    this.endOfDayStatement = database.prepare(endOfDayOfDaySql);
    this.nextCallExpiryStatement = database.prepare(nextCallExpirySql);
    this.quotesOfExpiryStatement = database.prepare(quotesOfExpirySql);
    this.quoteCountByRightStatement = database.prepare(quoteCountByRightSql);
    this.quoteWithAskAboveZeroStatement = database.prepare(quoteWithAskAboveZeroSql);
    this.endOfDayOfExpiryStatement = database.prepare(endOfDayOfExpirySql);
    this.endOfDayWithVolumeStatement = database.prepare(endOfDayWithVolumeSql);
    // One contract's rows by the primary key, within the window its day's read keeps.
    this.quotesOfContractStatement = database.prepare(`${quoteColumnsSql} WHERE trading_date = ? AND expiry = ? AND strike BETWEEN ? AND ? AND option_right = ? AND ${expiresWithin45DaysSql}`);
    this.endOfDayOfContractStatement = database.prepare(`${endOfDayColumnsSql} WHERE trading_date = ? AND expiry = ? AND strike BETWEEN ? AND ? AND option_right = ? AND ${expiresWithin46DaysSql}`);
    // Read by the thousand rows a day and look: only what a look reads (not the sizes), each row as an array.
    this.intradayQuotesStatement = hasIntradayTables ? database.prepare(`${intradayQuotesColumnsSql} WHERE trading_date = ? AND look_time > ? AND look_time <= ? AND strike BETWEEN ? AND ? AND ${expiresWithin45DaysSql}`) : null;
    this.intradayQuotesStatement?.setReturnArrays(true);
    this.intradayQuotesOfContractStatement = hasIntradayTables ? database.prepare(`${intradayQuotesColumnsSql} WHERE trading_date = ? AND look_time = ? AND expiry = ? AND strike BETWEEN ? AND ? AND option_right = ? AND ${expiresWithin45DaysSql}`) : null;
    this.intradayQuotesOfContractStatement?.setReturnArrays(true);
    this.intradayQuoteWithinStatement = hasIntradayTables ? database.prepare(intradayQuoteWithinSql) : null;
    this.nextIntradayLookTimeStatement = hasIntradayTables ? database.prepare(nextIntradayLookTimeSql) : null;
    // The hedge's long-dated Puts (backtestBaselineHedge.ts), past the 45-day window, one expiry at a time by the primary key.
    this.putExpiriesStatement = database.prepare("SELECT DISTINCT expiry FROM quotes WHERE trading_date = ? AND option_right = 'P' ORDER BY expiry");
    this.putQuotesOfExpiryStatement = database.prepare("SELECT strike, bid, ask, bid_size AS bidSize, ask_size AS askSize FROM quotes WHERE trading_date = ? AND expiry = ? AND option_right = 'P'");
    this.intradayPutQuotesOfExpiryStatement = hasIntradayTables ? database.prepare("SELECT strike, bid, ask FROM intraday_quotes WHERE trading_date = ? AND look_time = ? AND expiry = ? AND option_right = 'P'") : null;
    this.callExpiriesStatement = database.prepare("SELECT DISTINCT expiry FROM quotes WHERE trading_date = ? AND option_right = 'C' ORDER BY expiry");
    this.callQuotesOfExpiryStatement = database.prepare("SELECT strike, bid, ask, bid_size AS bidSize, ask_size AS askSize FROM quotes WHERE trading_date = ? AND expiry = ? AND option_right = 'C'");
    this.intradayCallQuotesOfExpiryStatement = hasIntradayTables ? database.prepare("SELECT strike, bid, ask, bid_size AS bidSize, ask_size AS askSize FROM intraday_quotes WHERE trading_date = ? AND look_time = ? AND expiry = ? AND option_right = 'C'") : null;
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
    if (this.slices) return this.slices.loadQuotes(tradingDate);
    return (this.quotesStatement.all(tradingDate) as Record<string, unknown>[]).map(quoteOfRow);
  }

  loadEndOfDay(tradingDate: string): SymbolFileEndOfDayRow[] {
    if (this.slices) return this.slices.loadEndOfDay(tradingDate);
    return (this.endOfDayStatement.all(tradingDate) as Record<string, unknown>[]).map(endOfDayOfRow);
  }

  /** Vol Farmer v2's read of a day (NextCallExpiryDay), with the file day before it (null on the first). */
  loadNextCallExpiryDay(tradingDate: string, previousFileDay: string | null): NextCallExpiryDay {
    if (this.slices) return this.slices.loadNextCallExpiryDay(tradingDate, previousFileDay);
    const expiry = (this.nextCallExpiryStatement.get(tradingDate, tradingDate, tradingDate) as { expiry: string | null }).expiry;
    return {
      expiry,
      quotes: expiry === null ? [] : (this.quotesOfExpiryStatement.all(tradingDate, expiry) as Record<string, unknown>[]).map(quoteOfRow),
      quoteCountByRight: quoteCountByRightOf(this.quoteCountByRightStatement.all(tradingDate) as { right: string; count: number }[]),
      hasAskAboveZero: this.quoteWithAskAboveZeroStatement.get(tradingDate) !== undefined,
      previousEndOfDay: previousFileDay === null || expiry === null ? [] : (this.endOfDayOfExpiryStatement.all(previousFileDay, expiry) as Record<string, unknown>[]).map(endOfDayOfRow),
      previousHasVolume: previousFileDay === null ? null : this.endOfDayWithVolumeStatement.get(previousFileDay) !== undefined,
    };
  }

  /** One expiry and right's 10:00 quotes with a strike from `lowestStrike` to `highestStrike`: what loadQuotes holds of them, in the same order. */
  loadQuotesOfContract(tradingDate: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileQuote[] {
    if (this.slices) return this.slices.loadQuotesOfContract(tradingDate, contract, lowestStrike, highestStrike);
    return (this.quotesOfContractStatement.all(tradingDate, contract.expiry, lowestStrike, highestStrike, contract.right) as Record<string, unknown>[]).map(quoteOfRow);
  }

  /** One expiry and right's end-of-day rows with a strike from `lowestStrike` to `highestStrike`: what loadEndOfDay holds of them, in the same order. */
  loadEndOfDayOfContract(tradingDate: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileEndOfDayRow[] {
    if (this.slices) return this.slices.loadEndOfDayOfContract(tradingDate, contract, lowestStrike, highestStrike);
    return (this.endOfDayOfContractStatement.all(tradingDate, contract.expiry, lowestStrike, highestStrike, contract.right) as Record<string, unknown>[]).map(endOfDayOfRow);
  }

  /**
   * What the downloader could not retrieve of each stored day, among what the engine reads (issueWithinReadWindowSql),
   * by date: the days without issues are left out. None on a file without the table.
   */
  loadDayIssuesByDate(): Map<string, SymbolFileDayIssue[]> {
    const issuesByDate = new Map<string, SymbolFileDayIssue[]>();
    for (const issue of ((this.dayIssuesStatement?.all() ?? []) as Record<string, unknown>[]).map(dayIssueOfRow)) {
      const issues = issuesByDate.get(issue.tradingDate);
      if (issues) issues.push(issue);
      else issuesByDate.set(issue.tradingDate, [issue]);
    }
    return issuesByDate;
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
    if (this.slices) return this.slices.loadIntradayQuotes(tradingDate, afterLookTime, throughLookTime, lowestStrike, highestStrike);
    const quotesByLookTime = new Map<string, SymbolFileQuote[]>();
    if (!this.intradayQuotesStatement) return quotesByLookTime;
    for (const [lookTime, expiry, strike, right, bid, ask] of this.intradayQuotesStatement.all(tradingDate, afterLookTime, throughLookTime, lowestStrike, highestStrike) as unknown as [string, string, number, "C" | "P", number | null, number | null][]) {
      let quotes = quotesByLookTime.get(lookTime);
      if (!quotes) quotesByLookTime.set(lookTime, (quotes = []));
      quotes.push({ expiry, strike, right, bid, ask, bidSize: null, askSize: null });
    }
    return quotesByLookTime;
  }

  /**
   * One look's quotes of one expiry and right with a strike from `lowestStrike` to `highestStrike`: what
   * loadIntradayQuotes holds of them at that look, in the same order, read by the primary key.
   */
  loadIntradayQuotesOfContract(tradingDate: string, lookTime: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileQuote[] {
    if (this.slices) return this.slices.loadIntradayQuotesOfContract(tradingDate, lookTime, contract, lowestStrike, highestStrike);
    if (!this.intradayQuotesOfContractStatement) return [];
    return (this.intradayQuotesOfContractStatement.all(tradingDate, lookTime, contract.expiry, lowestStrike, highestStrike, contract.right) as unknown as [string, string, number, "C" | "P", number | null, number | null][]).map(([, expiry, strike, right, bid, ask]) => ({ expiry, strike, right, bid, ask, bidSize: null, askSize: null }));
  }

  /** Whether loadIntradayQuotes over a range of looks including `lookTime` holds quotes at that look for these strikes. */
  hasIntradayQuoteWithin(tradingDate: string, lookTime: string, lowestStrike: number, highestStrike: number): boolean {
    if (this.slices) return this.slices.hasIntradayQuoteWithin(tradingDate, lookTime, lowestStrike, highestStrike);
    return this.intradayQuoteWithinStatement?.get(tradingDate, lookTime, lowestStrike, highestStrike) !== undefined;
  }

  /** The day's first look time after `afterLookTime` with stored rows (of any expiry); null after the last, or on a file without intraday quotes. */
  nextIntradayLookTime(tradingDate: string, afterLookTime: string): string | null {
    if (this.slices) return this.slices.nextIntradayLookTime(tradingDate, afterLookTime);
    const found = this.nextIntradayLookTimeStatement?.get(tradingDate, afterLookTime) as { lookTime: string | null } | undefined;
    return found?.lookTime ?? null;
  }

  /** Every Put expiry the day's 10:00 quotes hold, ascending, whatever its distance (the hedge's; files of schema 3 hold every expiry). */
  loadPutExpiries(tradingDate: string): string[] {
    if (this.slices) return this.slices.loadPutExpiries(tradingDate);
    return (this.putExpiriesStatement.all(tradingDate) as { expiry: string }[]).map((row) => String(row.expiry));
  }

  /** One expiry's Puts at 10:00, with their sizes. */
  loadPutQuotesOfExpiry(tradingDate: string, expiry: string): SymbolFileQuote[] {
    if (this.slices) return this.slices.quotesOfExpiry(tradingDate, null, expiry, "P", false);
    return (this.putQuotesOfExpiryStatement.all(tradingDate, expiry) as Record<string, unknown>[]).map((row) => ({ expiry, strike: Number(row.strike), right: "P" as const, bid: numberOrNull(row.bid), ask: numberOrNull(row.ask), bidSize: numberOrNull(row.bidSize), askSize: numberOrNull(row.askSize) }));
  }

  /** One expiry's Puts at a look after 10:00 ("HH:MM" Eastern), without their sizes; none on a file without intraday quotes. */
  loadIntradayPutQuotesOfExpiry(tradingDate: string, lookTime: string, expiry: string): SymbolFileQuote[] {
    if (this.slices) return this.slices.quotesOfExpiry(tradingDate, lookTime, expiry, "P", false);
    if (!this.intradayPutQuotesOfExpiryStatement) return [];
    return (this.intradayPutQuotesOfExpiryStatement.all(tradingDate, lookTime, expiry) as Record<string, unknown>[]).map((row) => ({ expiry, strike: Number(row.strike), right: "P" as const, bid: numberOrNull(row.bid), ask: numberOrNull(row.ask), bidSize: null, askSize: null }));
  }

  /** Every Call expiry the day's 10:00 quotes hold, ascending, whatever its distance (Vol Farmer v2's LEAPS). */
  loadCallExpiries(tradingDate: string): string[] {
    if (this.slices) return this.slices.loadCallExpiries(tradingDate);
    return (this.callExpiriesStatement.all(tradingDate) as { expiry: string }[]).map((row) => String(row.expiry));
  }

  /** One expiry's Calls at 10:00, with their sizes. */
  loadCallQuotesOfExpiry(tradingDate: string, expiry: string): SymbolFileQuote[] {
    if (this.slices) return this.slices.quotesOfExpiry(tradingDate, null, expiry, "C", false);
    return (this.callQuotesOfExpiryStatement.all(tradingDate, expiry) as Record<string, unknown>[]).map((row) => ({ expiry, strike: Number(row.strike), right: "C" as const, bid: numberOrNull(row.bid), ask: numberOrNull(row.ask), bidSize: numberOrNull(row.bidSize), askSize: numberOrNull(row.askSize) }));
  }

  /** One expiry's Calls at a look after 10:00 ("HH:MM" Eastern), with their sizes (Vol Farmer v2's LEAPS at every look); none on a file without intraday quotes. */
  loadIntradayCallQuotesOfExpiry(tradingDate: string, lookTime: string, expiry: string): SymbolFileQuote[] {
    if (this.slices) return this.slices.quotesOfExpiry(tradingDate, lookTime, expiry, "C", true);
    if (!this.intradayCallQuotesOfExpiryStatement) return [];
    return (this.intradayCallQuotesOfExpiryStatement.all(tradingDate, lookTime, expiry) as Record<string, unknown>[]).map((row) => ({ expiry, strike: Number(row.strike), right: "C" as const, bid: numberOrNull(row.bid), ask: numberOrNull(row.ask), bidSize: numberOrNull(row.bidSize), askSize: numberOrNull(row.askSize) }));
  }

  close(): void {
    this.database.close();
  }
}
