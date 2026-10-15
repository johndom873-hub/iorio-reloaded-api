import { BarSizeSetting, WhatToShow } from "@stoqey/ib";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import { tradingDateOf } from "../ibkr/dailyBarSplitCheck.js";
import { fetchHistoricalBarsRaw, type PriceBar } from "../ibkr/fetchTickerOverview.js";
import { ivBarsToDateMap } from "../ibkr/priceBarCache.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { normalizeBarVolume } from "../lib/normalizeBarVolume.js";
import { openBacktestDataFileForWriting } from "./backtestDataFile.js";
import { fileDailyBarYears, writeFileStockBars, type FileIntradayBar } from "./backtestFileStockBars.js";
import type { StoredDailyBar } from "./engine/backtestBarHistory.js";
import { ibkrEndDateTime } from "./marketStressBars.js";

// Fetches a symbol's IBKR stock bars and replaces those in its data file (backtestFileStockBars.ts): read-only historical
// requests through the Gateway, one at a time with a pause between them (IBKR paces historical data).

const requestTimeoutMilliseconds = 120_000;

export class FileStockBarsCancelledError extends Error {
  constructor() {
    super("Cancelled while fetching the IBKR stock bars.");
    this.name = "FileStockBarsCancelledError";
  }
}

export interface FileStockBarsRefresh {
  symbol: string;
  dailyBars: number;
  dailyFirstDate: string;
  dailyLastDate: string;
  impliedVolatilityDays: number;
  /** The implied-volatility request's failure; the bars are still written, without implied volatility. */
  impliedVolatilityError: string | null;
  intradayBars: number;
  intradayFirstDate: string;
  intradayLastDate: string;
}

export interface FileStockBarsRefreshOptions {
  /** The first year of 30-minute bars: the year of the file's first option day. */
  firstIntradayYear: number;
  /** The last session stored (a running session's bars are not). */
  lastDateToStore: string;
  nextRequestId: () => number;
  /** Runs between two requests. */
  pause: () => Promise<void>;
  /** Called before each request: what it fetches, and how many of the requests are done. */
  onRequest?: (label: string, done: number, total: number) => void;
  isCancelled?: () => boolean;
  now?: Date;
}

/**
 * The symbol's daily TRADES bars and daily implied volatility for the last 20 years (one request each), then its 30-minute
 * TRADES bars year by year from `firstIntradayYear` (one request a year), written over the file's previous bars at once.
 * Throws when IBKR returns no daily or no 30-minute bars: the file then keeps the bars it had.
 */
export async function refreshFileStockBars(connection: IbkrConnection, symbol: string, options: FileStockBarsRefreshOptions): Promise<FileStockBarsRefresh> {
  const now = options.now ?? new Date();
  const lastYear = Number(options.lastDateToStore.slice(0, 4));
  const intradayYears = Array.from({ length: Math.max(0, lastYear - options.firstIntradayYear + 1) }, (_, index) => options.firstIntradayYear + index);
  const totalRequests = 2 + intradayYears.length;
  let requestsDone = 0;
  const request = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    if (requestsDone > 0) await options.pause();
    if (options.isCancelled?.()) throw new FileStockBarsCancelledError();
    options.onRequest?.(label, requestsDone, totalRequests);
    const result = await run();
    requestsDone += 1;
    return result;
  };
  const isStored = (tradingDate: string) => tradingDate <= options.lastDateToStore;

  const dailyDuration = `${fileDailyBarYears} Y`;
  const dailyBars = (await request(`IBKR daily bars, ${fileDailyBarYears} years`, () => fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.DAYS_ONE, dailyDuration, options.nextRequestId(), WhatToShow.TRADES, { timeoutMs: requestTimeoutMilliseconds }))).filter((bar) => isStored(tradingDateOf(bar)));
  if (dailyBars.length === 0) throw new Error(`IBKR returned no daily bars for ${symbol}.`);
  let impliedVolatilityError: string | null = null;
  const impliedVolatilityBars = await request(`IBKR implied volatility, ${fileDailyBarYears} years`, () =>
    fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.DAYS_ONE, dailyDuration, options.nextRequestId(), WhatToShow.OPTION_IMPLIED_VOLATILITY, { timeoutMs: requestTimeoutMilliseconds }).catch((error: unknown) => {
      impliedVolatilityError = error instanceof Error ? error.message : String(error);
      return [] as PriceBar[];
    }),
  );
  const impliedVolatilityByDate = ivBarsToDateMap(impliedVolatilityBars);
  const daily: StoredDailyBar[] = dailyBars.map((bar) => {
    const tradingDate = tradingDateOf(bar);
    return { tradingDate, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: normalizeBarVolume(bar.volume), impliedVolatility: impliedVolatilityByDate.get(tradingDate) ?? null };
  });

  const intraday: FileIntradayBar[] = [];
  for (const year of intradayYears) {
    // The year ends at midnight Eastern of 1 January; 06:00 UTC is past it in winter time and the market is closed. The
    // running year is asked for up to now.
    const yearEnd = new Date(Math.min(Date.UTC(year + 1, 0, 1, 6, 0, 0), now.getTime()));
    const bars = await request(`IBKR 30-minute bars, ${year}`, () =>
      fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.MINUTES_THIRTY, "1 Y", options.nextRequestId(), WhatToShow.TRADES, { endDateTime: ibkrEndDateTime(yearEnd), timeoutMs: requestTimeoutMilliseconds }),
    );
    for (const bar of bars) {
      const barStart = new Date(bar.time * 1000);
      const tradingDate = easternIsoDate(barStart);
      if (!tradingDate.startsWith(String(year)) || !isStored(tradingDate)) continue;
      intraday.push({ barStart, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: normalizeBarVolume(bar.volume) });
    }
  }
  if (intraday.length === 0) throw new Error(`IBKR returned no 30-minute bars for ${symbol} from ${options.firstIntradayYear}.`);
  if (options.isCancelled?.()) throw new FileStockBarsCancelledError();

  const database = openBacktestDataFileForWriting(symbol);
  if (!database) throw new Error(`No data file for ${symbol}: download it first.`);
  try {
    writeFileStockBars(database, { daily, intraday, fetchedAt: now });
  } finally {
    database.close();
  }
  const intradayDates = intraday.map((bar) => easternIsoDate(bar.barStart)).sort();
  return {
    symbol,
    dailyBars: daily.length,
    dailyFirstDate: daily[0]!.tradingDate,
    dailyLastDate: daily.at(-1)!.tradingDate,
    impliedVolatilityDays: daily.filter((bar) => bar.impliedVolatility !== null).length,
    impliedVolatilityError,
    intradayBars: intraday.length,
    intradayFirstDate: intradayDates[0]!,
    intradayLastDate: intradayDates.at(-1)!,
  };
}

export function describeFileStockBarsRefresh(result: FileStockBarsRefresh): string {
  const parts = [
    `${result.symbol}: ${result.dailyBars} daily bars ${result.dailyFirstDate} → ${result.dailyLastDate} (${result.impliedVolatilityDays} with implied volatility)`,
    `${result.intradayBars} 30-minute bars ${result.intradayFirstDate} → ${result.intradayLastDate}`,
  ];
  if (result.impliedVolatilityError) parts.push(`implied volatility failed: ${result.impliedVolatilityError}`);
  return parts.join("; ");
}
