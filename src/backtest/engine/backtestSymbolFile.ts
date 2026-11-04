import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { readFileDividends, readFileDividendsFetchedAt, type FileDividend } from "../backtestFileDividends.js";
import { readFileDailyBars, readFileIntradayPrices, type FileIntradayPrices } from "../backtestFileStockBars.js";
import { currentBusinessFromOf, rowsFrom } from "../tickerBusinessChanges.js";
import type { StoredDailyBar } from "./backtestBarHistory.js";
import { SymbolFileSliceReads } from "./symbolFileSliceReads.js";

// Read access to one symbol's ThetaData file (docs/backtesting/DATA-FILES.md, schema version 4): the days it holds, each
// day's 10:00 quotes and end-of-day rows, the quotes at each look inside the day (intraday_days, and the slices that
// symbolFileSliceReads.ts reads), what the downloader could not retrieve (day_issues, unavailable_days), and IBKR's stock
// bars Node keeps in it (the stock prices). The open interest the files hold is not read: no rule uses it. Read-only;
// the downloader and the IBKR bars step write it. A ticker whose business changed (tickerBusinessChanges.ts) holds
// nothing before the change here: its days, issues and bars start there.

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
 * What Vol Farmer v4 reads of a day selling the next expiry after today (it decides on the next Call expiry only), each
 * part as the full read would give it (loadNextCallExpiryDay).
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

/** The one schema version the engine reads, the one the downloader writes. */
const symbolFileSchemaVersion = "4";

const dayIssueOfRow = (row: Record<string, unknown>): SymbolFileDayIssue => ({ tradingDate: String(row.tradingDate), part: row.part as SymbolFileDayIssue["part"], expiry: row.expiry === null || row.expiry === undefined ? null : String(row.expiry), message: String(row.message) });

/**
 * A day's issues about what the engine reads: a whole part, or an expiration within the part's window (0..45 days out
 * for the 10:00 and intraday quotes, 0..46 for the end of day and the open interest).
 */
const issueWithinReadWindowSql = "(expiry IS NULL OR (part IN ('quotes', 'intraday_quotes') AND expiry <= date(trading_date, '+45 days')) OR (part IN ('eod', 'open_interest') AND expiry <= date(trading_date, '+46 days')))";

export class BacktestSymbolFile {
  private readonly daysStatement: StatementSync;
  private readonly daysWithoutOptionPricesStatement: StatementSync;
  private readonly dayIssuesStatement: StatementSync;
  private readonly unavailableDaysStatement: StatementSync;
  private readonly intradayDaysStatement: StatementSync;
  /** The option reads, from the file's slices. */
  private readonly slices: SymbolFileSliceReads;

  /** `currentBusinessFrom`: the first date read (open() takes it from tickerBusinessChanges.ts); null reads every day. */
  constructor(
    private readonly database: DatabaseSync,
    private readonly currentBusinessFrom: string | null = null,
  ) {
    // The downloader may be committing a day: wait for its lock instead of failing.
    database.exec("PRAGMA busy_timeout = 3000");
    const version = (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
    if (version !== symbolFileSchemaVersion) throw new Error(`The data file has schema version ${version ?? "unknown"}; the engine reads version ${symbolFileSchemaVersion}.`);
    this.daysStatement = database.prepare("SELECT trading_date AS tradingDate, status FROM days ORDER BY trading_date");
    this.daysWithoutOptionPricesStatement = database.prepare("SELECT trading_date AS tradingDate FROM days WHERE status = 'complete' AND quote_rows = 0 AND eod_rows = 0 ORDER BY trading_date");
    this.dayIssuesStatement = database.prepare(`SELECT trading_date AS tradingDate, part, expiry, message FROM day_issues WHERE ${issueWithinReadWindowSql} ORDER BY trading_date, part, expiry`);
    this.unavailableDaysStatement = database.prepare("SELECT trading_date AS tradingDate, reason FROM unavailable_days ORDER BY trading_date");
    this.intradayDaysStatement = database.prepare("SELECT trading_date AS tradingDate FROM intraday_days WHERE status = 'complete' ORDER BY trading_date");
    this.slices = new SymbolFileSliceReads(database);
  }

  /** Opens the symbol's file from BACKTEST_DATA_DIR; throws when it has not been downloaded. */
  static open(symbol: string): BacktestSymbolFile {
    const database = openBacktestDataFileReadOnly(symbol);
    if (!database) throw new Error(`No data file for ${symbol}: download it first.`);
    try {
      return new BacktestSymbolFile(database, currentBusinessFromOf(symbol));
    } catch (error) {
      database.close();
      throw error;
    }
  }

  loadDays(): SymbolFileDay[] {
    return rowsFrom(this.daysStatement.all() as unknown as SymbolFileDay[], this.currentBusinessFrom);
  }

  /** Complete days with no option price at all: no 10:00 quote and no end-of-day row (GSAT's 2025-02-11, a split's first day). */
  loadDaysWithoutOptionPrices(): Set<string> {
    return new Set(rowsFrom(this.daysWithoutOptionPricesStatement.all() as { tradingDate: string }[], this.currentBusinessFrom).map((day) => day.tradingDate));
  }

  /** IBKR's daily bars kept in the file (backtestFileStockBars.ts), ascending; null when it has none. */
  loadIbkrDailyBars(): StoredDailyBar[] | null {
    const bars = readFileDailyBars(this.database);
    return bars === null ? null : rowsFrom(bars, this.currentBusinessFrom);
  }

  /** The cash dividends kept in the file (backtestFileDividends.ts), as paid, oldest first; null when never fetched. */
  loadDividends(): FileDividend[] | null {
    const dividends = readFileDividends(this.database);
    return dividends === null ? null : dividends.filter((dividend) => this.currentBusinessFrom === null || dividend.exDividendDate >= this.currentBusinessFrom);
  }

  /** When the file's dividends were last fetched; null when never. */
  loadDividendsFetchedAt(): string | null {
    return readFileDividendsFetchedAt(this.database);
  }

  /** IBKR's 30-minute bars kept in the file, as the stock's price at a look; null when it has none. */
  loadIbkrIntradayPrices(fromDateIso: string, toDateIso: string): FileIntradayPrices | null {
    const from = this.currentBusinessFrom !== null && this.currentBusinessFrom > fromDateIso ? this.currentBusinessFrom : fromDateIso;
    return from > toDateIso ? null : readFileIntradayPrices(this.database, from, toDateIso);
  }

  loadQuotes(tradingDate: string): SymbolFileQuote[] {
    return this.slices.loadQuotes(tradingDate);
  }

  loadEndOfDay(tradingDate: string): SymbolFileEndOfDayRow[] {
    return this.slices.loadEndOfDay(tradingDate);
  }

  /** Vol Farmer v4's read of a day (NextCallExpiryDay), with the file day before it (null on the first). */
  loadNextCallExpiryDay(tradingDate: string, previousFileDay: string | null): NextCallExpiryDay {
    return this.slices.loadNextCallExpiryDay(tradingDate, previousFileDay);
  }

  /** One expiry and right's 10:00 quotes with a strike from `lowestStrike` to `highestStrike`: what loadQuotes holds of them, in the same order. */
  loadQuotesOfContract(tradingDate: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileQuote[] {
    return this.slices.loadQuotesOfContract(tradingDate, contract, lowestStrike, highestStrike);
  }

  /** One expiry and right's end-of-day rows with a strike from `lowestStrike` to `highestStrike`: what loadEndOfDay holds of them, in the same order. */
  loadEndOfDayOfContract(tradingDate: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileEndOfDayRow[] {
    return this.slices.loadEndOfDayOfContract(tradingDate, contract, lowestStrike, highestStrike);
  }

  /**
   * What the downloader could not retrieve of each stored day, among what the engine reads (issueWithinReadWindowSql),
   * by date: the days without issues are left out.
   */
  loadDayIssuesByDate(): Map<string, SymbolFileDayIssue[]> {
    const issuesByDate = new Map<string, SymbolFileDayIssue[]>();
    for (const issue of rowsFrom((this.dayIssuesStatement.all() as Record<string, unknown>[]).map(dayIssueOfRow), this.currentBusinessFrom)) {
      const issues = issuesByDate.get(issue.tradingDate);
      if (issues) issues.push(issue);
      else issuesByDate.set(issue.tradingDate, [issue]);
    }
    return issuesByDate;
  }

  /** Days the downloader could not retrieve, ascending: no 10:00 quotes (the day has no `days` row) or no intraday quotes (it has one). */
  loadUnavailableDays(): { tradingDate: string; reason: string }[] {
    return rowsFrom((this.unavailableDaysStatement.all() as Record<string, unknown>[]).map((row) => ({ tradingDate: String(row.tradingDate), reason: String(row.reason) })), this.currentBusinessFrom);
  }

  /** The days whose intraday quotes are stored. */
  loadIntradayDays(): Set<string> {
    return new Set(rowsFrom(this.intradayDaysStatement.all() as { tradingDate: string }[], this.currentBusinessFrom).map((row) => String(row.tradingDate)));
  }

  /**
   * A day's quotes at the looks after `afterLookTime` up to `throughLookTime` ("HH:MM" Eastern), by look time, for the
   * strikes from `lowestStrike` to `highestStrike`, without their sizes. The downloader stores every look ThetaData
   * returns, also those after an early close (repeats of the closing quotes): the caller says which looks count.
   */
  loadIntradayQuotes(tradingDate: string, afterLookTime: string, throughLookTime: string, lowestStrike: number, highestStrike: number): Map<string, SymbolFileQuote[]> {
    return this.slices.loadIntradayQuotes(tradingDate, afterLookTime, throughLookTime, lowestStrike, highestStrike);
  }

  /**
   * One look's quotes of one expiry and right with a strike from `lowestStrike` to `highestStrike`: what
   * loadIntradayQuotes holds of them at that look, in the same order, read from that look and expiry's slice.
   */
  loadIntradayQuotesOfContract(tradingDate: string, lookTime: string, contract: { expiry: string; right: "C" | "P" }, lowestStrike: number, highestStrike: number): SymbolFileQuote[] {
    return this.slices.loadIntradayQuotesOfContract(tradingDate, lookTime, contract, lowestStrike, highestStrike);
  }

  /** Whether loadIntradayQuotes over a range of looks including `lookTime` holds quotes at that look for these strikes. */
  hasIntradayQuoteWithin(tradingDate: string, lookTime: string, lowestStrike: number, highestStrike: number): boolean {
    return this.slices.hasIntradayQuoteWithin(tradingDate, lookTime, lowestStrike, highestStrike);
  }

  /** The day's first look time after `afterLookTime` with stored rows (of any expiry); null after the last. */
  nextIntradayLookTime(tradingDate: string, afterLookTime: string): string | null {
    return this.slices.nextIntradayLookTime(tradingDate, afterLookTime);
  }

  /** Every Call expiry the day's 10:00 quotes hold, ascending, whatever its distance (the files hold every expiry; Vol Farmer v4's LEAPS). */
  loadCallExpiries(tradingDate: string): string[] {
    return this.slices.loadCallExpiries(tradingDate);
  }

  /** One expiry's Calls at 10:00, with their sizes. */
  loadCallQuotesOfExpiry(tradingDate: string, expiry: string): SymbolFileQuote[] {
    return this.slices.quotesOfExpiry(tradingDate, null, expiry, "C", false);
  }

  /** One expiry's Calls at a look after 10:00 ("HH:MM" Eastern), with their sizes (Vol Farmer v4's LEAPS at every look). */
  loadIntradayCallQuotesOfExpiry(tradingDate: string, lookTime: string, expiry: string): SymbolFileQuote[] {
    return this.slices.quotesOfExpiry(tradingDate, lookTime, expiry, "C", true);
  }

  close(): void {
    this.database.close();
  }
}
