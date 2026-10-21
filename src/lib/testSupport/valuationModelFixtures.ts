import { tradingSessionsFromCalendarRows, type TradingSession } from "../marketSessionStatus.js";
import type { CandidateModelContext, CandidateModelScore } from "../signalCandidates.js";
import type { ValuationGroup } from "../volatilityModelTables.js";
import { volatilityModelTables } from "../volatilityModelTables.generated.js";
import { varianceSessionsToExpiry } from "../varianceClock.js";
import type { ModelVolatilityForecast } from "../volatilityEdge.js";
import { modelForecastWindowDays, tradingSessionsPerYear } from "../volatilityEdge.js";
import type { HeldLegModelScore, RollModelScore } from "../rollSignalCandidates.js";
import { gradeForEdgeMargin } from "../contractValuation.js";

// Fixtures for the valuation model (model review, 2026-10-10), shared by the Signals and Pluto tests.

/** Every weekday of 2026-27 with the early-close list's half days (no holidays): the sessions fixtures' contracts live through. */
export const fixtureTradingSessions: TradingSession[] = tradingSessionsFromCalendarRows("2026-01-01", "2027-12-31", []);

/** A YZ21 forecast at an annualized (×252) volatility. */
export function fixtureModelForecast(annualizedVolatility: number): ModelVolatilityForecast {
  return { perSessionVariance: annualizedVolatility ** 2 / tradingSessionsPerYear, annualizedVolatility, windowDays: modelForecastWindowDays };
}

/**
 * A candidate's model block with plausible, self-consistent defaults: a $1.00 mid valued at $0.75 (margin 25%, grade
 * Strong), $20 expected P&L after $5 friction, on $9,000 of capital over 5 sessions (7 calendar days). Grade follows the margin unless given.
 */
export function fixtureCandidateModel(overrides: Partial<CandidateModelScore> = {}): CandidateModelScore {
  const edgeMargin = overrides.edgeMargin ?? 0.25;
  return {
    fairPrice: 0.75,
    edgeMargin,
    expectedPnlDollars: 20,
    calibratedEdgeMargin: 0.08,
    calibratedExpectedPnlDollars: 3,
    expectedAnnualizedReturn: 20 / 9000 / (7 / 365),
    calibratedAnnualizedReturn: 3 / 9000 / (7 / 365),
    probabilityOfProfit: 0.8,
    averageWinDollars: 60,
    averageLossDollars: -140,
    expectedShortfallDollars: -400,
    stressPnlDollars: -250,
    premiumAfterCostsDollars: 95,
    premiumYield: 95 / 9000 / (7 / 365),
    pnlVarianceDollars: 150 ** 2,
    coveredPositionPnlVarianceDollars: null,
    capitalAtRiskDollars: 9000,
    forecastVolatility: 0.5,
    varianceSessions: 5,
    calendarYears: 7 / 365,
    grade: gradeForEdgeMargin(edgeMargin),
    impliedVolatility: 0.6,
    valuedAtIso: "2026-09-21T14:00:00.000Z",
    forward: 100,
    spot: 100,
    ...overrides,
  };
}

/** A held leg's model block: holding earns `holdValueDollars` per contract versus buying back at the mid. */
export function fixtureHeldLegModel(holdValueDollars: number, closeCostDollars = 5, valuation: Partial<CandidateModelScore> = {}): HeldLegModelScore {
  return { valuation: fixtureCandidateModel(valuation), holdValueDollars, closeCostDollars };
}

export function fixtureRollModel(overrides: Partial<RollModelScore> = {}): RollModelScore {
  const edgeMargin = overrides.edgeMargin ?? 0.25;
  return { netExpectedPnlPerContract: 20, netExpectedPnl: 20, edgeMargin, grade: gradeForEdgeMargin(edgeMargin), ...overrides };
}

/**
 * A model context for building candidates in tests: every quote valued at `valuedAtMs` on the fixture sessions, against
 * the slice's fitted forward (unless `forward` is given) and `spot` (else `forward`, else 100), on the stock tables unless `group` says otherwise.
 */
export function fixtureCandidateModelContext(options: { annualizedVolatility: number; valuedAtMs: number; forward?: number; spot?: number; group?: ValuationGroup }): CandidateModelContext {
  return {
    tables: volatilityModelTables,
    forecast: fixtureModelForecast(options.annualizedVolatility),
    group: options.group ?? "stock",
    varianceSessionsAt: (atMs, expiryIso) => varianceSessionsToExpiry(atMs, expiryIso, fixtureTradingSessions),
    quoteInstantMs: () => options.valuedAtMs,
    forwardForQuote: (slice) => options.forward ?? slice.forwardPrice,
    spotForQuote: () => options.spot ?? options.forward ?? 100,
  };
}
