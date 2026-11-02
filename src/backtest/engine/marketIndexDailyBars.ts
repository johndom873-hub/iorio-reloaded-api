import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addCalendarDays } from "../../lib/calendarDays.js";
import type { BacktestMarketIndexFiles } from "../backtestTypes.js";
import { isWeekendDate } from "../jobs/backtestJobRules.js";

// IBKR's daily bars of the CBOE market indices a backtest rule can read (docs/backtesting/DATA-FILES.md): the VIX and the
// 3-month VIX (VIX3M). Kept as BACKTEST_DATA_DIR/ibkr-<SYMBOL>.json, written only by npm run backtest:fetch-market-indices
// (src/backtest/fetchMarketIndexDailyBars.ts); a backtest reads the files and never fetches. The VIX closes at 16:15 ET,
// after the engine's 10:00 look, so a rule reads the close of the session before the day it decides on (closeBefore).

export const marketIndexSymbols = ["VIX", "VIX3M"] as const;
export type MarketIndexSymbol = (typeof marketIndexSymbols)[number];
export const fetchMarketIndicesCommand = "npm run backtest:fetch-market-indices";

export interface MarketIndexDailyBar {
  dateIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MarketIndexBarsFile {
  symbol: MarketIndexSymbol;
  fetchedAtIso: string;
  /** The last finished session when the file was fetched: the bars reach it (or the session before, on a holiday). */
  lastFinishedSessionIso: string;
  /** Ascending by date, finished sessions only. */
  bars: MarketIndexDailyBar[];
}

/** An index's daily bars with "close of the last session before a day" lookups. */
export class MarketIndexCloses {
  constructor(
    readonly symbol: MarketIndexSymbol,
    private readonly bars: readonly MarketIndexDailyBar[],
  ) {}

  /** The close of the last session strictly before `dateIso`, with its date; null before the series starts. */
  closeBefore(dateIso: string): { dateIso: string; close: number } | null {
    let low = 0;
    let high = this.bars.length - 1;
    let found: MarketIndexDailyBar | null = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const bar = this.bars[middle]!;
      if (bar.dateIso < dateIso) {
        found = bar;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found ? { dateIso: found.dateIso, close: found.close } : null;
  }
}

/** The weekday before `dateIso` (holidays count as sessions, as in lastFinishedBacktestSessionDate). */
function previousWeekday(dateIso: string): string {
  let day = addCalendarDays(dateIso, -1);
  while (isWeekendDate(day)) day = addCalendarDays(day, -1);
  return day;
}

/** Pure: whether a file serves closeBefore for every day from `firstDateIso` to `lastDateIso`. */
export function marketIndexBarsFileCovers(file: MarketIndexBarsFile, firstDateIso: string, lastDateIso: string): boolean {
  const first = file.bars[0]?.dateIso;
  if (!first || first >= firstDateIso) return false;
  return file.lastFinishedSessionIso >= previousWeekday(lastDateIso);
}

export function marketIndexBarsPath(dataDirectory: string, symbol: MarketIndexSymbol): string {
  return path.join(dataDirectory, `ibkr-${symbol}.json`);
}

export function readMarketIndexBarsFile(dataDirectory: string, symbol: MarketIndexSymbol): MarketIndexBarsFile | null {
  const filePath = marketIndexBarsPath(dataDirectory, symbol);
  return existsSync(filePath) ? (JSON.parse(readFileSync(filePath, "utf8")) as MarketIndexBarsFile) : null;
}

/** Writes through a temporary file and a rename, so a backtest reading it never sees half a file. */
export function writeMarketIndexBarsFile(dataDirectory: string, file: MarketIndexBarsFile): void {
  const filePath = marketIndexBarsPath(dataDirectory, file.symbol);
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(file));
  renameSync(temporaryPath, filePath);
}

/** What the files hold together, for the Backtesting screen: the days every index has, and the oldest fetch; null while any file is missing or empty. */
export function summarizeMarketIndexFiles(dataDirectory: string): BacktestMarketIndexFiles | null {
  const files = marketIndexSymbols.map((symbol) => readMarketIndexBarsFile(dataDirectory, symbol));
  if (files.some((file) => !file || file.bars.length === 0)) return null;
  const present = files as MarketIndexBarsFile[];
  return {
    firstDateIso: present.map((file) => file.bars[0]!.dateIso).sort().at(-1)!,
    lastDateIso: present.map((file) => file.bars.at(-1)!.dateIso).sort()[0]!,
    fetchedAtIso: present.map((file) => file.fetchedAtIso).sort()[0]!,
  };
}

/** The index's closes for a session's days; throws, naming the command to run, when the file is missing or does not cover them. */
export function loadMarketIndexCloses(dataDirectory: string, symbol: MarketIndexSymbol, firstDateIso: string, lastDateIso: string): MarketIndexCloses {
  const file = readMarketIndexBarsFile(dataDirectory, symbol);
  if (!file) throw new Error(`There is no ${symbol} file (${path.basename(marketIndexBarsPath(dataDirectory, symbol))}): run ${fetchMarketIndicesCommand}.`);
  if (!marketIndexBarsFileCovers(file, firstDateIso, lastDateIso)) {
    throw new Error(`The ${symbol} file covers ${file.bars[0]?.dateIso ?? "no day"} to ${file.bars.at(-1)?.dateIso ?? "no day"}, not the closes before ${firstDateIso} to ${lastDateIso}: run ${fetchMarketIndicesCommand}.`);
  }
  return new MarketIndexCloses(symbol, file.bars);
}
