import type { PriceBar } from "./fetchTickerOverview.js";

// Stock splits in the stored daily bars, detected for certain rather than guessed from the size of a move.
//
// IBKR returns daily TRADES history already adjusted for every split up to the moment of the request; the stored
// daily_price_bars keep whatever was fetched at the time. After a split, IBKR's bars for every earlier date are the
// stored ones divided by the split ratio (2-for-1: stored $100, IBKR now $50). So every write of freshly fetched bars
// first compares the dates it shares with the stored rows: when a shared day's open, high, low and close all differ
// from the stored ones by the same ratio, the history was adjusted, and the ticker's whole history is fetched again
// and replaced, so the stored bars never mix the two price bases.

export interface StoredBarPrices {
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PriceAdjustment {
  /** Stored price ÷ IBKR's price on the adjusted days: 2 for a 2-for-1 split, 0.1 for a 1-for-10 reverse split. */
  ratio: number;
  /** The shared days on which the stored prices differed by that ratio. */
  adjustedDates: string[];
}

/**
 * How closely a day's four price ratios must agree to count as one adjustment, and how far from 1 they must be.
 * A plain data correction moves one price (a late print changing the high or the close), not all four by one factor;
 * today's still-forming bar moves the high, low and close but not the open.
 */
export const priceAdjustmentTolerance = 0.005;

export function tradingDateOf(bar: PriceBar): string {
  return new Date(bar.time * 1000).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Null when no shared day shows a whole-bar adjustment. */
export function detectPriceAdjustment(stored: StoredBarPrices[], fresh: PriceBar[]): PriceAdjustment | null {
  const freshByDate = new Map(fresh.map((bar) => [tradingDateOf(bar), bar]));
  const adjusted: { date: string; ratio: number }[] = [];
  for (const storedBar of stored) {
    const freshBar = freshByDate.get(storedBar.tradingDate);
    if (!freshBar) continue;
    const pairs: [number, number][] = [
      [storedBar.open, freshBar.open],
      [storedBar.high, freshBar.high],
      [storedBar.low, freshBar.low],
      [storedBar.close, freshBar.close],
    ];
    if (!pairs.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0)) continue;
    const ratios = pairs.map(([a, b]) => a / b);
    const smallest = Math.min(...ratios);
    const largest = Math.max(...ratios);
    if (largest / smallest - 1 > priceAdjustmentTolerance) continue;
    const ratio = median(ratios);
    if (Math.abs(ratio - 1) > priceAdjustmentTolerance) adjusted.push({ date: storedBar.tradingDate, ratio });
  }
  if (adjusted.length === 0) return null;
  return { ratio: median(adjusted.map((entry) => entry.ratio)), adjustedDates: adjusted.map((entry) => entry.date).sort() };
}

/** "2-for-1 split" / "1-for-10 reverse split" when the ratio is close to a whole number, otherwise the factor. */
export function describePriceAdjustment(ratio: number): string {
  const nearestWhole = (value: number) => (Math.abs(value - Math.round(value)) / value <= 0.02 ? Math.round(value) : null);
  if (ratio > 1) {
    const forward = nearestWhole(ratio);
    if (forward !== null) return `${forward}-for-1 split`;
  } else {
    const reverse = nearestWhole(1 / ratio);
    if (reverse !== null) return `1-for-${reverse} reverse split`;
  }
  return `price adjustment of ${ratio.toFixed(3)}×`;
}

export interface DailyHistory {
  bars: PriceBar[];
  ivByDate: Map<string, number>;
}

export interface DailyBarStoreDependencies {
  loadStoredPrices(tickerId: string, tradingDates: string[]): Promise<StoredBarPrices[]>;
  /** The newest stored trading day, or null for a ticker with no stored bars. */
  loadNewestStoredDate(tickerId: string): Promise<string | null>;
  /** IBKR's daily bars from that day to now: the window that gives a short fetch a day to compare. */
  fetchSince(tradingDate: string): Promise<DailyHistory>;
  upsertBars(tickerId: string, history: DailyHistory): Promise<void>;
  /** IBKR's full daily history for the ticker, as adjusted today. */
  fetchFullHistory(): Promise<DailyHistory>;
  /** Writes the full history and removes what it does not cover: stored days before its first bar, and the chart's intraday cache. */
  replaceHistory(tickerId: string, history: DailyHistory): Promise<{ removedEarlierDays: number }>;
  notify(message: string): Promise<unknown>;
}

export interface DailyBarStoreResult {
  adjustment: PriceAdjustment | null;
  /** Days written by the full re-fetch (0 when there was no adjustment). */
  replacedDays: number;
}

/** The two histories' bars by trading day, the later one winning a shared day; implied volatility likewise. */
function mergeHistories(earlier: DailyHistory, later: DailyHistory): DailyHistory {
  const barsByDate = new Map(earlier.bars.map((bar) => [tradingDateOf(bar), bar]));
  for (const bar of later.bars) barsByDate.set(tradingDateOf(bar), bar);
  return { bars: [...barsByDate.values()].sort((a, b) => a.time - b.time), ivByDate: new Map([...earlier.ivByDate, ...later.ivByDate]) };
}

/** Writes freshly fetched daily bars, replacing the whole stored history first when IBKR's prices show a split since it was stored. */
export async function storeDailyBarsCheckingForSplit(input: { tickerId: string; symbol: string; environment: string } & DailyHistory, dependencies: DailyBarStoreDependencies): Promise<DailyBarStoreResult> {
  if (input.bars.length === 0) return { adjustment: null, replacedDays: 0 };
  let fresh: DailyHistory = { bars: input.bars, ivByDate: input.ivByDate };
  let stored = await dependencies.loadStoredPrices(input.tickerId, fresh.bars.map(tradingDateOf));
  if (stored.length === 0) {
    // No shared day (a missed nightly run leaves the 2-day window past the newest stored day): fetch back to that day,
    // which also fills the days in between.
    const newestStoredDate = await dependencies.loadNewestStoredDate(input.tickerId);
    if (newestStoredDate !== null && newestStoredDate < tradingDateOf(fresh.bars[0]!)) {
      const window = await dependencies.fetchSince(newestStoredDate);
      fresh = mergeHistories(window, fresh);
      stored = await dependencies.loadStoredPrices(input.tickerId, fresh.bars.map(tradingDateOf));
    }
  }
  const adjustment = detectPriceAdjustment(stored, fresh.bars);
  if (!adjustment) {
    await dependencies.upsertBars(input.tickerId, fresh);
    return { adjustment: null, replacedDays: 0 };
  }
  const what = describePriceAdjustment(adjustment.ratio);
  const history = await dependencies.fetchFullHistory();
  if (history.bars.length === 0) {
    // Writing the fresh bars now would mix the two price bases; leave everything as it was and let the next run retry.
    await dependencies.notify(`⚠️ ${input.symbol} (${input.environment}): IBKR's prices show a ${what} since the price history was stored, but re-fetching the history returned nothing. Nothing was written; the next run tries again.`);
    throw new Error(`${input.symbol}: ${what} detected but the full history re-fetch returned no bars`);
  }
  const { removedEarlierDays } = await dependencies.replaceHistory(input.tickerId, history);
  const removedNote = removedEarlierDays > 0 ? ` ${removedEarlierDays} older days that IBKR no longer returns were removed.` : "";
  await dependencies.notify(
    `ℹ️ ${input.symbol} (${input.environment}): ${what} detected (stored prices ${adjustment.ratio.toFixed(3)}× IBKR's on ${adjustment.adjustedDates.join(", ")}). The price history was fetched again from IBKR and replaced: ${history.bars.length} days.${removedNote}`,
  );
  return { adjustment, replacedDays: history.bars.length };
}
