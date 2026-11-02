import { BarSizeSetting, Index, WhatToShow } from "@stoqey/ib";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import { tradingDateOf } from "../ibkr/dailyBarSplitCheck.js";
import { fetchHistoricalBarsRaw, type PriceBar } from "../ibkr/fetchTickerOverview.js";
import { historyDurationReaching } from "../ibkr/historicalDataDuration.js";
import { marketIndexSymbols, writeMarketIndexBarsFile, type MarketIndexBarsFile, type MarketIndexDailyBar, type MarketIndexSymbol } from "./engine/marketIndexDailyBars.js";

// IBKR's daily TRADES bars of a CBOE index (src/backtest/engine/marketIndexDailyBars.ts), one request for the whole history.

/** The bars are kept from here: every session's dates (2016 and later) and the sessions before the first one. */
export const marketIndexBarsStartIso = "2015-01-01";
const requestTimeoutMilliseconds = 120_000;
const pauseBetweenRequestsMilliseconds = 10_000;

/** Pure: IBKR's bars from marketIndexBarsStartIso to `lastFinishedSessionIso`, ascending. */
export function toMarketIndexDailyBars(bars: readonly PriceBar[], lastFinishedSessionIso: string): MarketIndexDailyBar[] {
  return bars
    .map((bar) => ({ dateIso: tradingDateOf(bar), open: bar.open, high: bar.high, low: bar.low, close: bar.close }))
    .filter((bar) => bar.dateIso >= marketIndexBarsStartIso && bar.dateIso <= lastFinishedSessionIso)
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

/** The index's bars as a file to write; throws when IBKR returns none. */
export async function fetchMarketIndexBarsFile(connection: IbkrConnection, symbol: MarketIndexSymbol, options: { lastFinishedSessionIso: string; requestId: number; now?: Date }): Promise<MarketIndexBarsFile> {
  const now = options.now ?? new Date();
  const priceBars = await fetchHistoricalBarsRaw(connection, symbol, BarSizeSetting.DAYS_ONE, historyDurationReaching(marketIndexBarsStartIso, now), options.requestId, WhatToShow.TRADES, {
    contract: new Index(symbol, "CBOE", "USD"),
    timeoutMs: requestTimeoutMilliseconds,
  });
  const bars = toMarketIndexDailyBars(priceBars, options.lastFinishedSessionIso);
  if (bars.length === 0) throw new Error(`IBKR returned no ${symbol} daily bars from ${marketIndexBarsStartIso} to ${options.lastFinishedSessionIso}.`);
  return { symbol, fetchedAtIso: now.toISOString(), lastFinishedSessionIso: options.lastFinishedSessionIso, bars };
}

/**
 * Fetches every market index and rewrites its file, one request at a time, 10 s apart (npm run
 * backtest:fetch-market-indices and the Backtesting screen's Refresh VIX). A failure stops the refresh; the files written
 * before it are kept, the others keep the days they had.
 */
export async function refreshMarketIndexFiles(connection: IbkrConnection, dataDirectory: string, options: { lastFinishedSessionIso: string; onFileWritten?: (file: MarketIndexBarsFile) => void }): Promise<MarketIndexBarsFile[]> {
  const written: MarketIndexBarsFile[] = [];
  for (const [index, symbol] of marketIndexSymbols.entries()) {
    if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, pauseBetweenRequestsMilliseconds));
    const file = await fetchMarketIndexBarsFile(connection, symbol, { lastFinishedSessionIso: options.lastFinishedSessionIso, requestId: index + 1 });
    writeMarketIndexBarsFile(dataDirectory, file);
    written.push(file);
    options.onFileWritten?.(file);
  }
  return written;
}
