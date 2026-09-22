import { findSuspectedSplitBarIndices, type DailyOhlcvBar } from "./realizedVolatility.js";

export interface BackfillBarSummary {
  barCount: number;
  firstTradingDate: string | null;
  lastTradingDate: string | null;
  /** Trading dates of bars whose overnight move the split guard flags. */
  suspectedSplitDates: string[];
  /** Bars with a non-positive or non-finite price, or high < low. */
  invalidBarDates: string[];
}

/** Sanity report on freshly fetched daily bars (bars are stored unadjusted, so splits show up as gaps). */
export function summarizeBackfillBars(bars: DailyOhlcvBar[]): BackfillBarSummary {
  const invalidBarDates = bars
    .filter((bar) => ![bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price) && price > 0) || bar.high < bar.low)
    .map((bar) => bar.tradingDate);
  return {
    barCount: bars.length,
    firstTradingDate: bars[0]?.tradingDate ?? null,
    lastTradingDate: bars[bars.length - 1]?.tradingDate ?? null,
    suspectedSplitDates: findSuspectedSplitBarIndices(bars).map((index) => (bars[index] as DailyOhlcvBar).tradingDate),
    invalidBarDates,
  };
}
