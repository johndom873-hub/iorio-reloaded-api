import { describe, expect, it } from "vitest";
import type { SignalCandidate, SignalSurfaceSlice } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { TickerSignals } from "../lib/signalsTypes.js";

import { filterTickerForPluto, rejectTicker, type PlutoTickerFilterInput } from "./candidateFilters.js";
import { expectedDailyMovePct } from "./moveContext.js";
import type { PlutoSettings } from "./settingsStore.js";

const now = Date.parse("2026-09-28T15:00:00Z"); // 11:00 ET
const today = "2026-09-28";

const settings: PlutoSettings = {
  capitalBudgetPct: 30, maxTickerExposurePct: 10, maxSectorExposurePct: 100, maxOpenPositions: 8, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
  minGrade: "good", minEdgeDollars: 30, maxAbsDelta: 0.3, minDte: 2, maxDte: 45, minAnnualizedYieldPct: 50, maxSpreadPct: 15, minOpenInterest: 500, minSessionVolume: 50, maxQuoteAgeMinutes: 10, maxContractsVolumeSharePct: 20,
  maxSliceRmseVp: 2, minSlicePointCount: 10, maxMidVsSurfaceIvVp: 5, maxIvShiftVp: 8, maxDayMoveMultiple: 3, stressRiskBudgetPct: 0, stressSigmas: 2,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2, spyStressBreakerPct: 3,
  maxEdgeDriftVp: 1, tickerCooldownMinutes: 60, maxFillSlippagePct: 25,
  modelId: "openai/gpt-6-luna", reasoningEffort: "medium", callTimeoutSeconds: 90, dailyCostCeilingUsd: 3, confidenceFloor: 0.6, consecutiveModelFailuresBreaker: 3, promptVersion: "v1",
  daySignalsPollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, perTickerModelCooldownMinutes: 5, maxEnabledTickers: 15, messageRateLimitPerSecond: 8,
  crashLoopRestartsPerHour: 3, telegramVerbosity: "actions",
  unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50, buybackMinDte: 2,
  updatedAt: "2026-09-28T00:00:00.000Z", updatedByUserId: null,
};

function candidate(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 100, dte: 18, delta: -0.22, bid: 2.0, ask: 2.1, spreadPercent: 4.9,
    openInterest: 1200, volume: 300, bidSize: 40, askSize: 35,
    surfaceImpliedVolatility: 0.62, midImpliedVolatility: 0.61, forecastVolatility: 0.5, edge: 0.12, frictionVolatility: 0.02, netEdge: 0.1, edgeDollars: 80, vega: 0.08,
    dollarRisk: 9795, riskAdjustedRatio: 0.008, annualizedYield: 0.83, uncompensatedSharePercent: null,
    quoteSource: "day", quotedAt: new Date(now - 2 * 60_000).toISOString(), flags: [], executable: true, grade: "strong",
    ...overrides,
  };
}

function slice(overrides: Partial<SignalSurfaceSlice> = {}): SignalSurfaceSlice {
  return { expiry: "2026-10-16", status: "ok", parameters: { a: 0.01, b: 0.1, rho: -0.3, m: 0, sigma: 0.2 }, kMin: -0.4, kMax: 0.4, yearsToExpiry: 18 / 365, forwardPrice: 110, pointCount: 24, rmseVolatility: 0.012, minButterflyDensity: 0.5, droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 }, calendarChecks: 21, calendarViolations: 0, ...overrides };
}

function scored(overrides: Partial<TickerSignals> = {}): TickerSignals {
  return {
    tickerId: "t1", symbol: "HOOD", companyName: "Robinhood", sector: "Financial", snapshotDateIso: today, snapshotCapturedAt: "2026-09-28T14:05:00Z", spotPrice: 110, priceSource: "live",
    previousClose: { close: 108, dateIso: "2026-09-25" }, dayChangePercent: 1.85, candidates: [candidate()], best: null, gradeCounts: { strong: 1, good: 0, weak: 0, avoid: 0 },
    heldLegs: [], rolls: [], bestRoll: null, rollCount: 0, fittedSliceCount: 3, totalSliceCount: 3, momentum: 0.1, skew: null, elevatedVolatility: null, nextEarningsDateIso: "2026-11-04", macroEvents: [],
    atmImpliedVolatility: 0.6, forecast: { volatility: 0.5, windowDays: 63 }, dailyBarCount: 1250, dividendCadenceUnknown: false, caveats: [], freeShares: 0, freeCash: 500_000,
    dayQuotesAsOf: null, ivShiftByExpiry: { "2026-10-16": { shiftVolatilityPoints: 1.2, quoteCount: 9 } }, quoteSourceCounts: { live: 0, day: 1, snapshot: 0 }, unscoredReason: null,
    ...overrides,
  } as TickerSignals;
}

function input(overrides: Partial<PlutoTickerFilterInput> = {}): PlutoTickerFilterInput {
  return { scored: scored(), slices: [slice()], settings, todayEasternIso: today, nowMs: now, botEnabled: true, ...overrides };
}
// Audit B (2026-10-07): the day-move limit relative to each ticker's normal day (maxDayMoveMultiple × forecast / √252).
const normalDay = (volatility: number) => (volatility * 100) / Math.sqrt(252);

describe("rejectTicker — maxDayMoveMultiple", () => {
  it("blocks only strictly beyond the multiple, both directions", () => {
    const limit = 3 * normalDay(0.5);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: limit }) }))).toEqual([]);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: limit + 0.01 }) }))[0]).toMatch(/beyond 3×$/);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: -(limit + 0.01) }) }))[0]).toMatch(/^day change -9\.5% is 3\.0\d× its normal 3\.15% day, beyond 3×$/);
  });

  it("scales with the ticker's own forecast: the same 7% move is out for a calm stock and fine for a wild one", () => {
    // 30%: normal day 1.89%, 3× = 5.67%. 80%: normal day 5.04%, 3× = 15.1%.
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: 7, forecast: { volatility: 0.3, windowDays: 63 } as TickerSignals["forecast"] }) }))).toHaveLength(1);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: 7, forecast: { volatility: 0.8, windowDays: 63 } as TickerSignals["forecast"] }) }))).toEqual([]);
  });

  it("follows the setting: 2× blocks what 3× allows, and 0× blocks any move at all", () => {
    const move = 2.5 * normalDay(0.5);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: move }) }))).toEqual([]);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: move }), settings: { ...settings, maxDayMoveMultiple: 2 } }))).toHaveLength(1);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: 0.01 }), settings: { ...settings, maxDayMoveMultiple: 0 } }))).toHaveLength(1);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: 0 }), settings: { ...settings, maxDayMoveMultiple: 0 } }))).toEqual([]);
  });

  it("no day change: no block", () => {
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: null }) }))).toEqual([]);
  });

  // RISK (characterised): with a zero or missing forecast volatility there is no normal day, so the day-move limit is
  // skipped entirely (the old fixed ±6% applied regardless). A missing forecast is caught by unscoredReason "no_forecast";
  // a zero one is not caught anywhere here.
  it("a zero forecast volatility blocks the ticker instead of switching the day-move limit off", () => {
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: 40, forecast: { volatility: 0, windowDays: 63 } as TickerSignals["forecast"] }) }))).toContain("no volatility forecast to judge today's move against");
  });

  it("a missing forecast blocks the ticker too, next to the unscored reason", () => {
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: 40, forecast: null }) }))).toEqual(["no volatility forecast to judge today's move against"]);
    expect(rejectTicker(input({ scored: scored({ dayChangePercent: 40, forecast: null, unscoredReason: "no_forecast" }) }))).toEqual(["not scored: no_forecast", "no volatility forecast to judge today's move against"]);
  });

  it("uses the same normal day as move_context's expected_daily_move_pct", () => {
    const pct = expectedDailyMovePct(0.5)!;
    const reason = rejectTicker(input({ scored: scored({ dayChangePercent: 3 * pct + 0.5 }) }))[0]!;
    expect(reason).toContain(`its normal ${pct.toFixed(2)}% day`);
  });

  it("a blocked ticker offers nothing", () => {
    const result = filterTickerForPluto(input({ scored: scored({ dayChangePercent: 12 }) }));
    expect(result.tickerBlocks).toHaveLength(1);
    expect(result.eligible).toEqual([]);
  });
});
