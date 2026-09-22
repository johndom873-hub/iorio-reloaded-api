import {
  buildSviFitPoints,
  checkCalendarArbitrage,
  computeForwardPrice,
  fitSviSlice,
  yearsBetweenIsoDates,
  type DiscreteDividend,
  type FitPointDropCounts,
  type SurfaceQuote,
  type SviSliceFit,
} from "./impliedVolatilitySurface.js";

// Fits every expiry of one ticker's chain snapshot (Formula 3b) and runs the
// calendar-arbitrage check between neighbouring fitted expiries. Pure: the DB
// read/write lives in optionSurfaceStore.ts.

export interface SurfaceSnapshotQuote extends SurfaceQuote {
  /** ISO date YYYY-MM-DD. */
  expiry: string;
}

export interface SurfaceSnapshotInput {
  tradingDate: string;
  spotPrice: number | null;
  riskFreeRatePercent: number | null;
  nextExDividendDate: string | null;
  nextExDividendAmount: number | null;
  quotes: SurfaceSnapshotQuote[];
}

export interface FittedExpiry {
  expiry: string;
  yearsToExpiry: number;
  forwardPrice: number;
  slice: SviSliceFit;
  dropped: FitPointDropCounts;
  /** Calendar check against the previous expiry that produced a fit (0 / 0 for the first). */
  calendarChecks: number;
  calendarViolations: number;
}

export type SurfaceFitOutcome =
  | { kind: "fitted"; expiries: FittedExpiry[] }
  | { kind: "skipped"; reason: "no_spot_price" | "no_risk_free_rate" | "no_quotes" };

export function fitSurfaceForSnapshot(input: SurfaceSnapshotInput): SurfaceFitOutcome {
  if (input.spotPrice === null || !(input.spotPrice > 0)) return { kind: "skipped", reason: "no_spot_price" };
  if (input.riskFreeRatePercent === null) return { kind: "skipped", reason: "no_risk_free_rate" };
  if (input.quotes.length === 0) return { kind: "skipped", reason: "no_quotes" };

  const riskFreeRate = input.riskFreeRatePercent / 100;
  const dividends: DiscreteDividend[] =
    input.nextExDividendDate !== null && input.nextExDividendAmount !== null
      ? [{ amount: input.nextExDividendAmount, yearsToExDividend: yearsBetweenIsoDates(input.tradingDate, input.nextExDividendDate) }]
      : [];

  const expiries = [...new Set(input.quotes.map((quote) => quote.expiry))].sort();
  const fitted: FittedExpiry[] = [];
  let previousWithFit: { yearsToExpiry: number; parameters: NonNullable<SviSliceFit["parameters"]>; kMin: number; kMax: number } | null = null;

  for (const expiry of expiries) {
    const yearsToExpiry = yearsBetweenIsoDates(input.tradingDate, expiry);
    if (!(yearsToExpiry > 0)) continue; // expiring today: no time value to fit
    const forwardPrice = computeForwardPrice(input.spotPrice, riskFreeRate, yearsToExpiry, dividends);
    const { points, dropped } = buildSviFitPoints(
      input.quotes.filter((quote) => quote.expiry === expiry),
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
    fitted.push({ expiry, yearsToExpiry, forwardPrice, slice, dropped, calendarChecks, calendarViolations });
  }
  return { kind: "fitted", expiries: fitted };
}
