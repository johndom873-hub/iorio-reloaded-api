import {
  buildSviFitPoints,
  checkCalendarArbitrage,
  computeForwardPrice,
  fitSviSlice,
  parityImpliedForward,
  projectDividendSchedule,
  yearsBetweenIsoDates,
  type FitPointDropCounts,
  type SurfaceQuote,
  type SviSliceFit,
} from "./impliedVolatilitySurface.js";
import { median } from "./statistics.js";

// Fits every expiry of one ticker's chain snapshot (Formula 3b) and runs the
// calendar-arbitrage check between neighbouring fitted expiries. Pure: the DB
// read/write lives in optionSurfaceStore.ts.

export interface SurfaceSnapshotQuote extends SurfaceQuote {
  /** ISO date YYYY-MM-DD. */
  expiry: string;
  /** The underlying's price when this quote was taken; null/absent when the tick carried none. */
  underlyingPrice?: number | null;
}

export interface SurfaceSnapshotInput {
  tradingDate: string;
  spotPrice: number | null;
  riskFreeRatePercent: number | null;
  nextExDividendDate: string | null;
  nextExDividendAmount: number | null;
  /** Most recent past ex-dividend on record, used only to infer a regular cadence for projecting later dividends. */
  pastExDividendDate: string | null;
  pastExDividendAmount: number | null;
  quotes: SurfaceSnapshotQuote[];
}

export interface FittedExpiry {
  expiry: string;
  yearsToExpiry: number;
  forwardPrice: number;
  /** The underlying price the forward is anchored to (the quotes' median underlying, else the snapshot spot): live scoring rescales the forward from it. */
  underlyingPrice: number;
  slice: SviSliceFit;
  dropped: FitPointDropCounts;
  /** Calendar check against the previous expiry that produced a fit (0 / 0 for the first). */
  calendarChecks: number;
  calendarViolations: number;
}

export type SurfaceFitOutcome =
  | { kind: "fitted"; expiries: FittedExpiry[] }
  | { kind: "skipped"; reason: "no_spot_price" | "no_risk_free_rate" | "no_quotes" };

/**
 * The underlying price the quotes were taken at (median across the expiry's quotes), or null when none carries one. The snapshot's own
 * spot is read once before the quotes arrive, so on a fast mover it can sit far enough from them to split calls from puts at a short expiry.
 */
function underlyingPriceOfQuotes(quotes: SurfaceSnapshotQuote[]): number | null {
  const prices = quotes.flatMap((quote) => (quote.underlyingPrice !== null && quote.underlyingPrice !== undefined && quote.underlyingPrice > 0 ? [quote.underlyingPrice] : []));
  return prices.length === 0 ? null : median(prices);
}

export function fitSurfaceForSnapshot(input: SurfaceSnapshotInput): SurfaceFitOutcome {
  if (input.spotPrice === null || !(input.spotPrice > 0)) return { kind: "skipped", reason: "no_spot_price" };
  if (input.riskFreeRatePercent === null) return { kind: "skipped", reason: "no_risk_free_rate" };
  if (input.quotes.length === 0) return { kind: "skipped", reason: "no_quotes" };

  const riskFreeRate = input.riskFreeRatePercent / 100;
  const expiries = [...new Set(input.quotes.map((quote) => quote.expiry))].sort();
  const dividends = projectDividendSchedule(
    input.tradingDate,
    input.nextExDividendDate !== null && input.nextExDividendAmount !== null ? { date: input.nextExDividendDate, amount: input.nextExDividendAmount } : null,
    input.pastExDividendDate !== null && input.pastExDividendAmount !== null ? { date: input.pastExDividendDate, amount: input.pastExDividendAmount } : null,
    expiries[expiries.length - 1] ?? input.tradingDate,
  );

  const fitted: FittedExpiry[] = [];
  let previousWithFit: { yearsToExpiry: number; parameters: NonNullable<SviSliceFit["parameters"]>; kMin: number; kMax: number } | null = null;

  for (const expiry of expiries) {
    const yearsToExpiry = yearsBetweenIsoDates(input.tradingDate, expiry);
    if (!(yearsToExpiry > 0)) continue; // expiring today: no time value to fit
    const expiryQuotes = input.quotes.filter((quote) => quote.expiry === expiry);
    const underlyingPrice = underlyingPriceOfQuotes(expiryQuotes) ?? input.spotPrice;
    const spotBasedForward = computeForwardPrice(underlyingPrice, riskFreeRate, yearsToExpiry, dividends);
    const forwardPrice = parityImpliedForward(expiryQuotes, spotBasedForward, yearsToExpiry, riskFreeRate) ?? spotBasedForward;
    const { points, dropped } = buildSviFitPoints(
      expiryQuotes,
      forwardPrice,
      yearsToExpiry,
      riskFreeRate,
    );
    const slice = fitSviSlice(points, yearsToExpiry);

    let calendarChecks = 0;
    let calendarViolations = 0;
    if (slice.parameters && slice.kMin !== null && slice.kMax !== null) {
      const current = { yearsToExpiry, parameters: slice.parameters, kMin: slice.kMin, kMax: slice.kMax };
      if (previousWithFit) ({ checks: calendarChecks, violations: calendarViolations } = checkCalendarArbitrage([previousWithFit, current]));
      previousWithFit = current;
    }
    fitted.push({ expiry, yearsToExpiry, forwardPrice, underlyingPrice, slice, dropped, calendarChecks, calendarViolations });
  }
  return { kind: "fitted", expiries: fitted };
}
