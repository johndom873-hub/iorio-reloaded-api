import type { DatabaseSync } from "node:sqlite";
import { BarSizeSetting, WhatToShow } from "@stoqey/ib";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import { tradingDateOf } from "../ibkr/dailyBarSplitCheck.js";
import { fetchHistoricalBarsRaw, type PriceBar } from "../ibkr/fetchTickerOverview.js";
import { ivBarsToDateMap } from "../ibkr/priceBarCache.js";
import { addCalendarDays } from "../lib/calendarDays.js";
import { calendarDaysBetween, easternIsoDate, easternMinutesOfDay } from "../lib/easternIsoDate.js";
import { normalizeBarVolume } from "../lib/normalizeBarVolume.js";
import { openBacktestDataFileForWriting, openBacktestDataFileReadOnly } from "./backtestDataFile.js";
import {
  addFileStockBars,
  fileDailyBarYears,
  fileStockBarsVersion,
  intradayBarKey,
  readFileStockBarsTail,
  summarizeFileStockBars,
  writeFileStockBars,
  type FileIntradayBar,
  type StoredFileStockBarsTail,
} from "./backtestFileStockBars.js";
import type { StoredDailyBar } from "./engine/backtestBarHistory.js";
import { ibkrEndDateTime } from "./marketStressBars.js";

// Fetches a symbol's IBKR stock bars into its data file (backtestFileStockBars.ts): read-only historical requests through
// the Gateway, one at a time with a pause between them (IBKR paces historical data). The last month (3 requests) is
// written over the stored bars when the two agree to the cent on every day they share; otherwise, or when the file's bars
// cannot take it, every bar is fetched again (2 requests and one a year) and replaces them.

const requestTimeoutMilliseconds = 120_000;

export class FileStockBarsCancelledError extends Error {
  constructor() {
    super("Cancelled while fetching the IBKR stock bars.");
    this.name = "FileStockBarsCancelledError";
  }
}

export interface FileStockBarsRefresh {
  symbol: string;
  /** "tail": the last month written over the stored bars; "full": every bar fetched again and replaced. */
  kind: "tail" | "full";
  /** Why every bar was fetched again; null after a tail. */
  fullRefreshReason: string | null;
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

/** How far the file's first option day may come before IBKR's first daily bar: options list days after a stock does, never before. */
const optionsBeforeStockPricesToleranceDays = 14;

/**
 * Null, or why the file's options cannot be this stock's: they start more than 14 days before IBKR's first daily bar (a
 * symbol that belonged to another security first, as SPCX did before SpaceX). IBKR's daily history reaches 20 years back,
 * so an older stock's first bar is never after its options.
 */
/** The file's options start before IBKR's stock prices (optionsStartBeforeStockPrices): retrying cannot help. */
export class FileOptionsPredateStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileOptionsPredateStockError";
  }
}

export function optionsStartBeforeStockPrices(symbol: string, firstOptionDay: string, firstDailyBarDate: string): string | null {
  const gapDays = (Date.parse(`${firstDailyBarDate}T00:00:00Z`) - Date.parse(`${firstOptionDay}T00:00:00Z`)) / 86_400_000;
  if (gapDays <= optionsBeforeStockPricesToleranceDays) return null;
  return `The file's ${symbol} options start ${firstOptionDay} but IBKR's ${symbol} stock prices start ${firstDailyBarDate}: the symbol likely belonged to another security before then, so the file mixes two. Delete the file and download it from ${firstDailyBarDate}.`;
}

export interface FileStockBarsRefreshOptions {
  /** The file's first option day: the 30-minute bars start in its year, and it must not come before IBKR's first daily bar. */
  firstOptionDay: string;
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

/** The tail: the last month of daily bars, implied volatility and 30-minute bars, one request each. */
const tailDuration = "1 M";
/** The tail is asked for only when the file's bars end at most 14 days before the last session: it then shares about two weeks with them. */
const tailMaxDaysBehind = 14;
/** The stored bars the tail is compared with: from 45 days before the last session, earlier than the tail reaches. */
const tailComparisonDays = 45;

/** Both prices known and equal once rounded to the cent; a missing one counts as a difference. */
const sameToTheCent = (first: number | null | undefined, second: number | null | undefined): boolean =>
  first !== null && first !== undefined && second !== null && second !== undefined && Math.round(first * 100) === Math.round(second * 100);

/** Null when the file's bars can take the tail; else why every bar is fetched again. */
export function reasonToFetchEveryBar(stored: StoredFileStockBarsTail | null, firstOptionDay: string, lastDateToStore: string): string | null {
  if (!stored) return "the file has no IBKR bars yet";
  if (stored.version !== fileStockBarsVersion) return `its bars are version ${stored.version ?? "unknown"}, not ${fileStockBarsVersion}`;
  if (stored.intradayFirstDate.slice(0, 4) > firstOptionDay.slice(0, 4)) return `its options start ${firstOptionDay}, before its 30-minute bars (${stored.intradayFirstDate})`;
  const earliestLastDate = stored.dailyLastDate < stored.intradayLastDate ? stored.dailyLastDate : stored.intradayLastDate;
  if (calendarDaysBetween(earliestLastDate, lastDateToStore) > tailMaxDaysBehind) return `its bars end ${earliestLastDate}, more than ${tailMaxDaysBehind} days before ${lastDateToStore}`;
  return null;
}

/**
 * Null when the tail shares at least one day and one 30-minute bar with the stored bars and every shared close is the same
 * to the cent; else why it cannot be written over them. A split or other adjustment since the last fetch rescales every
 * earlier price, so it shows on the shared days.
 */
export function reasonTailDiffers(stored: StoredFileStockBarsTail, daily: readonly StoredDailyBar[], intraday: readonly FileIntradayBar[]): string | null {
  const keyOf = (bar: FileIntradayBar) => intradayBarKey(easternIsoDate(bar.barStart), easternMinutesOfDay(bar.barStart));
  const sharedDaily = daily.filter((bar) => stored.dailyCloseByDate.has(bar.tradingDate));
  const sharedIntraday = intraday.filter((bar) => stored.intradayCloseByKey.has(keyOf(bar)));
  if (sharedDaily.length === 0 || sharedIntraday.length === 0) return "IBKR's last month shares no bar with the file's";
  const differingDaily = sharedDaily.filter((bar) => !sameToTheCent(bar.close, stored.dailyCloseByDate.get(bar.tradingDate)));
  const differingIntraday = sharedIntraday.filter((bar) => !sameToTheCent(bar.close, stored.intradayCloseByKey.get(keyOf(bar))));
  if (differingDaily.length === 0 && differingIntraday.length === 0) return null;
  const example = differingDaily[0]
    ? `${differingDaily[0].tradingDate} close ${stored.dailyCloseByDate.get(differingDaily[0].tradingDate)} stored, ${differingDaily[0].close} now`
    : `${keyOf(differingIntraday[0]!)} minutes ET close ${stored.intradayCloseByKey.get(keyOf(differingIntraday[0]!))} stored, ${differingIntraday[0]!.close} now`;
  return `IBKR's prices changed on ${differingDaily.length} of ${sharedDaily.length} shared days and ${differingIntraday.length} of ${sharedIntraday.length} shared 30-minute bars (${example}): a split or other adjustment since the last fetch`;
}

function readStoredTail(symbol: string, lastDateToStore: string): StoredFileStockBarsTail | null {
  const database = openBacktestDataFileReadOnly(symbol);
  if (!database) return null;
  try {
    return readFileStockBarsTail(database, addCalendarDays(lastDateToStore, -tailComparisonDays));
  } finally {
    database.close();
  }
}

/**
 * Brings the file's IBKR bars up to `lastDateToStore`. When the file's bars can take it (reasonToFetchEveryBar), the last
 * month of daily bars, implied volatility and 30-minute bars is fetched and, when it agrees with them (reasonTailDiffers),
 * written over the same days. Otherwise every bar is fetched again: daily bars and implied volatility for the last 20 years
 * (one request each), then 30-minute bars year by year from the first option day's year (one request a year), written over
 * the file's previous bars at once. Throws when IBKR returns no daily or no 30-minute bars: the file then keeps the bars it had.
 */
export async function refreshFileStockBars(connection: IbkrConnection, symbol: string, options: FileStockBarsRefreshOptions): Promise<FileStockBarsRefresh> {
  const now = options.now ?? new Date();
  let requestsDone = 0;
  let totalRequests = 0;
  const request = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
    if (requestsDone > 0) await options.pause();
    if (options.isCancelled?.()) throw new FileStockBarsCancelledError();
    options.onRequest?.(label, requestsDone, totalRequests);
    const result = await run();
    requestsDone += 1;
    return result;
  };
  const isStored = (tradingDate: string) => tradingDate <= options.lastDateToStore;

  /** Daily bars and their implied volatility over `duration`; a failed implied-volatility request leaves it null. */
  const fetchDailyBars = async (duration: string, span: string, checkFirstBar: (firstDate: string) => void) => {
    const dailyBars = (await request(`IBKR daily bars, ${span}`, () => fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.DAYS_ONE, duration, options.nextRequestId(), WhatToShow.TRADES, { timeoutMs: requestTimeoutMilliseconds }))).filter((bar) => isStored(tradingDateOf(bar)));
    if (dailyBars.length === 0) throw new Error(`IBKR returned no daily bars for ${symbol}.`);
    checkFirstBar(dailyBars.map(tradingDateOf).sort()[0]!);
    let impliedVolatilityError: string | null = null;
    const impliedVolatilityBars = await request(`IBKR implied volatility, ${span}`, () =>
      fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.DAYS_ONE, duration, options.nextRequestId(), WhatToShow.OPTION_IMPLIED_VOLATILITY, { timeoutMs: requestTimeoutMilliseconds }).catch((error: unknown) => {
        impliedVolatilityError = error instanceof Error ? error.message : String(error);
        return [] as PriceBar[];
      }),
    );
    const impliedVolatilityByDate = ivBarsToDateMap(impliedVolatilityBars);
    const daily: StoredDailyBar[] = dailyBars.map((bar) => {
      const tradingDate = tradingDateOf(bar);
      return { tradingDate, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: normalizeBarVolume(bar.volume), impliedVolatility: impliedVolatilityByDate.get(tradingDate) ?? null };
    });
    return { daily, impliedVolatilityError: impliedVolatilityError as string | null };
  };
  const toFileIntradayBar = (bar: PriceBar): FileIntradayBar => ({ barStart: new Date(bar.time * 1000), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: normalizeBarVolume(bar.volume) });
  const writeAndSummarize = (write: (database: DatabaseSync) => void) => {
    if (options.isCancelled?.()) throw new FileStockBarsCancelledError();
    const database = openBacktestDataFileForWriting(symbol);
    if (!database) throw new Error(`No data file for ${symbol}: download it first.`);
    try {
      write(database);
      return summarizeFileStockBars(database)!;
    } finally {
      database.close();
    }
  };

  const stored = readStoredTail(symbol, options.lastDateToStore);
  let fullRefreshReason = reasonToFetchEveryBar(stored, options.firstOptionDay, options.lastDateToStore);
  if (stored && fullRefreshReason === null) {
    const mixedSecurities = optionsStartBeforeStockPrices(symbol, options.firstOptionDay, stored.dailyFirstDate);
    if (mixedSecurities) throw new FileOptionsPredateStockError(mixedSecurities);
    totalRequests = 3;
    const { daily, impliedVolatilityError } = await fetchDailyBars(tailDuration, "last month", () => {});
    const intraday = (
      await request("IBKR 30-minute bars, last month", () => fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.MINUTES_THIRTY, tailDuration, options.nextRequestId(), WhatToShow.TRADES, { timeoutMs: requestTimeoutMilliseconds }))
    )
      .map(toFileIntradayBar)
      .filter((bar) => isStored(easternIsoDate(bar.barStart)));
    if (intraday.length === 0) throw new Error(`IBKR returned no 30-minute bars for ${symbol} in the last month.`);
    fullRefreshReason = reasonTailDiffers(stored, daily, intraday);
    if (fullRefreshReason === null) {
      const summary = writeAndSummarize((database) => addFileStockBars(database, { daily, intraday, fetchedAt: now }));
      return { symbol, kind: "tail", fullRefreshReason: null, impliedVolatilityError, ...summary };
    }
  }

  const lastYear = Number(options.lastDateToStore.slice(0, 4));
  const firstIntradayYear = Number(options.firstOptionDay.slice(0, 4));
  const intradayYears = Array.from({ length: Math.max(0, lastYear - firstIntradayYear + 1) }, (_, index) => firstIntradayYear + index);
  totalRequests = requestsDone + 2 + intradayYears.length;
  const { daily, impliedVolatilityError } = await fetchDailyBars(`${fileDailyBarYears} Y`, `${fileDailyBarYears} years`, (firstDate) => {
    const mixedSecurities = optionsStartBeforeStockPrices(symbol, options.firstOptionDay, firstDate);
    if (mixedSecurities) throw new FileOptionsPredateStockError(mixedSecurities);
  });

  const intraday: FileIntradayBar[] = [];
  for (const year of intradayYears) {
    // The year ends at midnight Eastern of 1 January; 06:00 UTC is past it in winter time and the market is closed. The
    // running year is asked for up to now.
    const yearEnd = new Date(Math.min(Date.UTC(year + 1, 0, 1, 6, 0, 0), now.getTime()));
    const bars = await request(`IBKR 30-minute bars, ${year}`, () =>
      fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.MINUTES_THIRTY, "1 Y", options.nextRequestId(), WhatToShow.TRADES, { endDateTime: ibkrEndDateTime(yearEnd), timeoutMs: requestTimeoutMilliseconds }),
    );
    for (const bar of bars.map(toFileIntradayBar)) {
      const tradingDate = easternIsoDate(bar.barStart);
      if (tradingDate.startsWith(String(year)) && isStored(tradingDate)) intraday.push(bar);
    }
  }
  if (intraday.length === 0) throw new Error(`IBKR returned no 30-minute bars for ${symbol} from ${firstIntradayYear}.`);

  const summary = writeAndSummarize((database) => writeFileStockBars(database, { daily, intraday, fetchedAt: now }));
  return { symbol, kind: "full", fullRefreshReason, impliedVolatilityError, ...summary };
}

export function describeFileStockBarsRefresh(result: FileStockBarsRefresh): string {
  const parts = [
    `${result.symbol}: ${result.dailyBars} daily bars ${result.dailyFirstDate} → ${result.dailyLastDate} (${result.impliedVolatilityDays} with implied volatility)`,
    `${result.intradayBars} 30-minute bars ${result.intradayFirstDate} → ${result.intradayLastDate}`,
    result.kind === "tail" ? "last month added" : `every bar fetched again: ${result.fullRefreshReason}`,
  ];
  if (result.impliedVolatilityError) parts.push(`implied volatility failed: ${result.impliedVolatilityError}`);
  return parts.join("; ");
}
