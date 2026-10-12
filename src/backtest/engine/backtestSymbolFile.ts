import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";

// Read access to one symbol's ThetaData file (docs/backtesting/DATA-FILES.md, schema version 1): the days it holds, each
// day's 10:00 quotes, its end-of-day rows and the open interest published for it. Read-only; the downloader writes it.

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

export const supportedSymbolFileSchemaVersion = "1";

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export class BacktestSymbolFile {
  private readonly daysStatement: StatementSync;
  private readonly quotesStatement: StatementSync;
  private readonly endOfDayStatement: StatementSync;
  private readonly openInterestStatement: StatementSync;

  constructor(private readonly database: DatabaseSync) {
    // The downloader may be committing a day: wait for its lock instead of failing.
    database.exec("PRAGMA busy_timeout = 3000");
    const version = (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value;
    if (version !== supportedSymbolFileSchemaVersion) throw new Error(`The data file has schema version ${version ?? "unknown"}; the engine reads version ${supportedSymbolFileSchemaVersion}.`);
    this.daysStatement = database.prepare("SELECT trading_date AS tradingDate, status FROM days ORDER BY trading_date");
    this.quotesStatement = database.prepare("SELECT expiry, strike, option_right AS right, bid, ask, bid_size AS bidSize, ask_size AS askSize FROM quotes WHERE trading_date = ?");
    this.endOfDayStatement = database.prepare("SELECT expiry, strike, option_right AS right, close, volume, bid, ask FROM eod WHERE trading_date = ?");
    this.openInterestStatement = database.prepare("SELECT expiry, strike, option_right AS right, open_interest AS openInterest FROM open_interest WHERE trading_date = ?");
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

  close(): void {
    this.database.close();
  }
}
