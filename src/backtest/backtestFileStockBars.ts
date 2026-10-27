import type { DatabaseSync } from "node:sqlite";
import { easternIsoDate, easternMinutesOfDay } from "../lib/easternIsoDate.js";
import type { StoredDailyBar } from "./engine/backtestBarHistory.js";

// IBKR's stock prices inside a symbol's data file (docs/backtesting/DATA-FILES.md, "IBKR stock bars"): daily bars with
// the daily implied volatility for the last 20 years, and 30-minute bars from the first year the file has option data.
// The backtests take every stock price from them, never from the option quotes (Marcelo 2026-10-14). Node writes them
// after a download and on Update: the last month's bars over the stored ones when both agree to the cent on the days they
// share, else the whole set at once, so every bar carries the same split adjustment (IBKR adjusts for splits as of the
// fetch). The ThetaData downloader never touches these tables.

export const fileStockBarsVersion = "1";
export const fileDailyBarYears = 20;
export const fileIntradayBarMinutes = 30;

/** One 30-minute bar as IBKR sent it: its start instant and prices on IBKR's split-adjusted scale. */
export interface FileIntradayBar {
  barStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

const createTablesSql = `
  CREATE TABLE IF NOT EXISTS ibkr_daily_bars (
    trading_date TEXT PRIMARY KEY, open REAL, high REAL, low REAL, close REAL, volume REAL, implied_volatility REAL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS ibkr_intraday_bars (
    trading_date TEXT NOT NULL, start_minutes_et INTEGER NOT NULL, bar_start TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL, volume REAL,
    PRIMARY KEY (trading_date, start_minutes_et)
  ) WITHOUT ROWID;
`;

function hasTable(database: DatabaseSync, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

interface FileStockBarsToWrite {
  daily: readonly StoredDailyBar[];
  intraday: readonly FileIntradayBar[];
  fetchedAt: Date;
}

/** Writes `bars` in one transaction: in place of every stored bar ("replace"), or over the stored bars of the same days ("add"). */
function storeFileStockBars(database: DatabaseSync, bars: FileStockBarsToWrite, mode: "replace" | "add"): void {
  if (bars.daily.length === 0 || bars.intraday.length === 0) throw new Error("No IBKR bars to write: the file keeps the ones it has.");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(createTablesSql);
    if (mode === "replace") database.exec("DELETE FROM ibkr_daily_bars; DELETE FROM ibkr_intraday_bars;");
    // Adding, a day's stored implied volatility stays when the new bar has none (its request failed).
    const insertDaily = database.prepare(
      mode === "replace"
        ? "INSERT INTO ibkr_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?)"
        : `INSERT INTO ibkr_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (trading_date) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
             close = excluded.close, volume = excluded.volume, implied_volatility = coalesce(excluded.implied_volatility, ibkr_daily_bars.implied_volatility)`,
    );
    for (const bar of bars.daily) insertDaily.run(bar.tradingDate, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.impliedVolatility);
    const insertIntraday = database.prepare("INSERT OR REPLACE INTO ibkr_intraday_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const bar of bars.intraday) insertIntraday.run(easternIsoDate(bar.barStart), easternMinutesOfDay(bar.barStart), bar.barStart.toISOString(), bar.open, bar.high, bar.low, bar.close, bar.volume);
    const setMeta = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    setMeta.run("ibkr_bars_version", fileStockBarsVersion);
    setMeta.run("ibkr_bars_fetched_at", bars.fetchedAt.toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Replaces the file's IBKR stock bars with `bars` in one transaction, so a reader never sees two adjustments mixed. */
export function writeFileStockBars(database: DatabaseSync, bars: FileStockBarsToWrite): void {
  storeFileStockBars(database, bars, "replace");
}

/**
 * Writes `bars` over the file's bars of the same days and keeps the others, in one transaction. Only for bars on the stored
 * bars' split adjustment: the caller has compared them on the days both have (refreshFileStockBars.ts).
 */
export function addFileStockBars(database: DatabaseSync, bars: FileStockBarsToWrite): void {
  storeFileStockBars(database, bars, "add");
}

/** The key of a 30-minute bar: its Eastern date and start, minutes ET ("2026-10-26 570"). */
export const intradayBarKey = (tradingDate: string, startMinutesEt: number): string => `${tradingDate} ${startMinutesEt}`;

/** The file's IBKR bars from a date on, with the extent of all of them: what a fresh tail is checked against. */
export interface StoredFileStockBarsTail {
  /** ibkr_bars_version of the stored bars; null when the meta key is missing. */
  version: string | null;
  dailyFirstDate: string;
  dailyLastDate: string;
  intradayFirstDate: string;
  intradayLastDate: string;
  dailyCloseByDate: Map<string, number | null>;
  /** By intradayBarKey. */
  intradayCloseByKey: Map<string, number | null>;
}

/** The file's bars from `fromDateIso` on; null when it has no daily or no 30-minute bars. */
export function readFileStockBarsTail(database: DatabaseSync, fromDateIso: string): StoredFileStockBarsTail | null {
  if (!hasTable(database, "ibkr_daily_bars") || !hasTable(database, "ibkr_intraday_bars")) return null;
  const daily = database.prepare("SELECT min(trading_date) AS first, max(trading_date) AS last FROM ibkr_daily_bars").get() as { first: string | null; last: string | null };
  const intraday = database.prepare("SELECT min(trading_date) AS first, max(trading_date) AS last FROM ibkr_intraday_bars").get() as { first: string | null; last: string | null };
  if (!daily.first || !daily.last || !intraday.first || !intraday.last) return null;
  const version = (database.prepare("SELECT value FROM meta WHERE key = 'ibkr_bars_version'").get() as { value: string } | undefined)?.value ?? null;
  const dailyRows = database.prepare("SELECT trading_date AS tradingDate, close FROM ibkr_daily_bars WHERE trading_date >= ?").all(fromDateIso) as unknown as { tradingDate: string; close: number | null }[];
  const intradayRows = database
    .prepare("SELECT trading_date AS tradingDate, start_minutes_et AS startMinutesEt, close FROM ibkr_intraday_bars WHERE trading_date >= ?")
    .all(fromDateIso) as unknown as { tradingDate: string; startMinutesEt: number; close: number | null }[];
  return {
    version,
    dailyFirstDate: daily.first,
    dailyLastDate: daily.last,
    intradayFirstDate: intraday.first,
    intradayLastDate: intraday.last,
    dailyCloseByDate: new Map(dailyRows.map((row) => [row.tradingDate, row.close])),
    intradayCloseByKey: new Map(intradayRows.map((row) => [intradayBarKey(row.tradingDate, row.startMinutesEt), row.close])),
  };
}

/** How many IBKR bars the file holds and their extent (after a refresh, for its log line); null when it has none. */
export function summarizeFileStockBars(database: DatabaseSync): {
  dailyBars: number;
  dailyFirstDate: string;
  dailyLastDate: string;
  impliedVolatilityDays: number;
  intradayBars: number;
  intradayFirstDate: string;
  intradayLastDate: string;
} | null {
  if (!hasTable(database, "ibkr_daily_bars") || !hasTable(database, "ibkr_intraday_bars")) return null;
  const daily = database.prepare("SELECT count(*) AS bars, count(implied_volatility) AS impliedVolatilityDays, min(trading_date) AS first, max(trading_date) AS last FROM ibkr_daily_bars").get() as {
    bars: number;
    impliedVolatilityDays: number;
    first: string | null;
    last: string | null;
  };
  const intraday = database.prepare("SELECT count(*) AS bars, min(trading_date) AS first, max(trading_date) AS last FROM ibkr_intraday_bars").get() as { bars: number; first: string | null; last: string | null };
  if (!daily.first || !daily.last || !intraday.first || !intraday.last) return null;
  return {
    dailyBars: Number(daily.bars),
    dailyFirstDate: daily.first,
    dailyLastDate: daily.last,
    impliedVolatilityDays: Number(daily.impliedVolatilityDays),
    intradayBars: Number(intraday.bars),
    intradayFirstDate: intraday.first,
    intradayLastDate: intraday.last,
  };
}

/** The file's IBKR daily bars, ascending; null when it has none (a file from before they were kept: Update adds them). */
export function readFileDailyBars(database: DatabaseSync): StoredDailyBar[] | null {
  if (!hasTable(database, "ibkr_daily_bars")) return null;
  const rows = database.prepare("SELECT trading_date AS tradingDate, open, high, low, close, volume, implied_volatility AS impliedVolatility FROM ibkr_daily_bars ORDER BY trading_date").all() as unknown as StoredDailyBar[];
  return rows.length > 0 ? rows : null;
}

/** How many IBKR daily bars the file keeps and the last one's date (what the split schedule is checked against); null when it has none. */
export function countFileDailyBars(database: DatabaseSync): { count: number; lastDate: string } | null {
  if (!hasTable(database, "ibkr_daily_bars")) return null;
  const row = database.prepare("SELECT count(*) AS count, max(trading_date) AS lastDate FROM ibkr_daily_bars").get() as { count: number; lastDate: string | null };
  return row.lastDate ? { count: Number(row.count), lastDate: row.lastDate } : null;
}

/** The first and last dates of the file's IBKR bars, and when they were fetched; nulls when it has none. */
export function describeFileStockBars(database: DatabaseSync): { dailyFirstDate: string | null; dailyLastDate: string | null; intradayFirstDate: string | null; intradayLastDate: string | null; fetchedAt: string | null } {
  if (!hasTable(database, "ibkr_daily_bars") || !hasTable(database, "ibkr_intraday_bars")) return { dailyFirstDate: null, dailyLastDate: null, intradayFirstDate: null, intradayLastDate: null, fetchedAt: null };
  const daily = database.prepare("SELECT min(trading_date) AS first, max(trading_date) AS last FROM ibkr_daily_bars").get() as { first: string | null; last: string | null };
  const intraday = database.prepare("SELECT min(trading_date) AS first, max(trading_date) AS last FROM ibkr_intraday_bars").get() as { first: string | null; last: string | null };
  const fetchedAt = (database.prepare("SELECT value FROM meta WHERE key = 'ibkr_bars_fetched_at'").get() as { value: string } | undefined)?.value ?? null;
  return { dailyFirstDate: daily.first, dailyLastDate: daily.last, intradayFirstDate: intraday.first, intradayLastDate: intraday.last, fetchedAt };
}

const minutesOfLookTime = (lookTimeEt: string): number => Number(lookTimeEt.slice(0, 2)) * 60 + Number(lookTimeEt.slice(3, 5));

/** One 30-minute bar of a day, on IBKR's split-adjusted scale; open and high fall back to the close when the file lacks them. */
export interface FileIntradayBarPrices {
  startMinutesEt: number;
  open: number;
  high: number;
  close: number;
}

/** The stock's price inside each day, from the file's 30-minute bars, on IBKR's split-adjusted scale. */
export class FileIntradayPrices {
  /** Per Eastern date: [minutes ET at which the bar ends, its close], ascending. */
  private readonly closesByDate = new Map<string, [number, number][]>();
  /** Per Eastern date: its bars, ascending. */
  private readonly barsByDate = new Map<string, FileIntradayBarPrices[]>();

  constructor(rows: readonly { tradingDate: string; startMinutesEt: number; close: number | null; open?: number | null; high?: number | null }[]) {
    for (const row of rows) {
      if (row.close === null || !(row.close > 0)) continue;
      let closes = this.closesByDate.get(row.tradingDate);
      if (!closes) this.closesByDate.set(row.tradingDate, (closes = []));
      closes.push([row.startMinutesEt + fileIntradayBarMinutes, row.close]);
      let bars = this.barsByDate.get(row.tradingDate);
      if (!bars) this.barsByDate.set(row.tradingDate, (bars = []));
      const open = row.open !== undefined && row.open !== null && row.open > 0 ? row.open : row.close;
      const high = row.high !== undefined && row.high !== null && row.high > 0 ? Math.max(row.high, open, row.close) : Math.max(open, row.close);
      bars.push({ startMinutesEt: row.startMinutesEt, open, high, close: row.close });
    }
    for (const closes of this.closesByDate.values()) closes.sort((a, b) => a[0] - b[0]);
    for (const bars of this.barsByDate.values()) bars.sort((a, b) => a.startMinutesEt - b.startMinutesEt);
  }

  /** A day's bars, ascending; none when the file has none that day. */
  barsOn(dateIso: string): readonly FileIntradayBarPrices[] {
    return this.barsByDate.get(dateIso) ?? [];
  }

  /** The last date with a bar; null with none. */
  get lastDate(): string | null {
    let last: string | null = null;
    for (const dateIso of this.closesByDate.keys()) if (last === null || dateIso > last) last = dateIso;
    return last;
  }

  /** The price at `lookTimeEt` ("HH:MM") on a day: the close of the last bar ending by then (10:00 reads the 09:30 bar); null when the day has none by then. */
  priceAt(dateIso: string, lookTimeEt: string): number | null {
    const closes = this.closesByDate.get(dateIso);
    if (!closes) return null;
    const lookMinutes = minutesOfLookTime(lookTimeEt);
    let price: number | null = null;
    for (const [endMinutes, close] of closes) {
      if (endMinutes > lookMinutes) break;
      price = close;
    }
    return price;
  }
}

/** The file's 30-minute bars from `fromDateIso` through `toDateIso`; null when the file has none (Update adds them). */
export function readFileIntradayPrices(database: DatabaseSync, fromDateIso: string, toDateIso: string): FileIntradayPrices | null {
  if (!hasTable(database, "ibkr_intraday_bars")) return null;
  if (database.prepare("SELECT 1 FROM ibkr_intraday_bars LIMIT 1").get() === undefined) return null;
  const rows = database
    .prepare("SELECT trading_date AS tradingDate, start_minutes_et AS startMinutesEt, open, high, close FROM ibkr_intraday_bars WHERE trading_date BETWEEN ? AND ? ORDER BY trading_date, start_minutes_et")
    .all(fromDateIso, toDateIso) as unknown as { tradingDate: string; startMinutesEt: number; open: number | null; high: number | null; close: number | null }[];
  return new FileIntradayPrices(rows);
}
