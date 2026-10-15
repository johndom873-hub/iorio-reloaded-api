import type { DatabaseSync } from "node:sqlite";
import { easternIsoDate, easternMinutesOfDay } from "../lib/easternIsoDate.js";
import type { StoredDailyBar } from "./engine/backtestBarHistory.js";

// IBKR's stock prices inside a symbol's data file (docs/backtesting/DATA-FILES.md, "IBKR stock bars"): daily bars with
// the daily implied volatility for the last 20 years, and 30-minute bars from the first year the file has option data.
// The backtests take every stock price from them, never from the option quotes (Marcelo 2026-10-14). Node writes them
// after a download and on Update, the whole set at once, so every bar carries the same split adjustment (IBKR adjusts
// for splits as of the fetch). The ThetaData downloader never touches these tables.

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

/** Replaces the file's IBKR stock bars with `bars` in one transaction, so a reader never sees two adjustments mixed. */
export function writeFileStockBars(database: DatabaseSync, bars: { daily: readonly StoredDailyBar[]; intraday: readonly FileIntradayBar[]; fetchedAt: Date }): void {
  if (bars.daily.length === 0 || bars.intraday.length === 0) throw new Error("No IBKR bars to write: the file keeps the ones it has.");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(createTablesSql);
    database.exec("DELETE FROM ibkr_daily_bars; DELETE FROM ibkr_intraday_bars;");
    const insertDaily = database.prepare("INSERT INTO ibkr_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?)");
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

/** The file's IBKR daily bars, ascending; null when it has none (a file from before they were kept: Update adds them). */
export function readFileDailyBars(database: DatabaseSync): StoredDailyBar[] | null {
  if (!hasTable(database, "ibkr_daily_bars")) return null;
  const rows = database.prepare("SELECT trading_date AS tradingDate, open, high, low, close, volume, implied_volatility AS impliedVolatility FROM ibkr_daily_bars ORDER BY trading_date").all() as unknown as StoredDailyBar[];
  return rows.length > 0 ? rows : null;
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

/** The stock's price inside each day, from the file's 30-minute bars, on IBKR's split-adjusted scale. */
export class FileIntradayPrices {
  /** Per Eastern date: [minutes ET at which the bar ends, its close], ascending. */
  private readonly closesByDate = new Map<string, [number, number][]>();

  constructor(rows: readonly { tradingDate: string; startMinutesEt: number; close: number | null }[]) {
    for (const row of rows) {
      if (row.close === null || !(row.close > 0)) continue;
      let closes = this.closesByDate.get(row.tradingDate);
      if (!closes) this.closesByDate.set(row.tradingDate, (closes = []));
      closes.push([row.startMinutesEt + fileIntradayBarMinutes, row.close]);
    }
    for (const closes of this.closesByDate.values()) closes.sort((a, b) => a[0] - b[0]);
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
    .prepare("SELECT trading_date AS tradingDate, start_minutes_et AS startMinutesEt, close FROM ibkr_intraday_bars WHERE trading_date BETWEEN ? AND ? ORDER BY trading_date, start_minutes_et")
    .all(fromDateIso, toDateIso) as unknown as { tradingDate: string; startMinutesEt: number; close: number | null }[];
  return new FileIntradayPrices(rows);
}
