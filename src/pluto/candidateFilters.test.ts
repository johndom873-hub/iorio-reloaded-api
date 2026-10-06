import { describe, expect, it } from "vitest";
import type { SignalCandidate, SignalSurfaceSlice } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { TickerSignals } from "../lib/signalsTypes.js";
import { candidateSetFingerprint } from "./inputHash.js";
import { deterministicTopPick, filterTickerForPluto, openCandidateId, type PlutoTickerFilterInput } from "./candidateFilters.js";
import type { PlutoSettings } from "./settingsStore.js";

const now = Date.parse("2026-09-28T15:00:00Z"); // 11:00 ET
const today = "2026-09-28";

const settings: PlutoSettings = {
  capitalBudgetPct: 30, maxTickerExposurePct: 10, maxSectorExposurePct: 100, maxOpenPositions: 8, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
  minGrade: "good", minEdgeDollars: 30, maxAbsDelta: 0.3, minDte: 2, maxDte: 45, minAnnualizedYieldPct: 50, maxSpreadPct: 15, minOpenInterest: 500, minSessionVolume: 50, maxQuoteAgeMinutes: 10, maxContractsVolumeSharePct: 20,
  maxSliceRmseVp: 2, minSlicePointCount: 10, maxMidVsSurfaceIvVp: 5, maxIvShiftVp: 8, maxAbsDayChangePct: 6,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2, spyStressBreakerPct: 3,
  maxEdgeDriftVp: 1, tickerCooldownMinutes: 60, maxFillSlippagePct: 25,
  modelId: "openai/gpt-6-luna", reasoningEffort: "medium", callTimeoutSeconds: 90, dailyCostCeilingUsd: 3, confidenceFloor: 0.6, maxModelCallsPerSession: 12, consecutiveModelFailuresBreaker: 3, promptVersion: "v1",
  daySignalsPollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, perTickerModelCooldownMinutes: 10, globalMinCallIntervalSeconds: 60, maxEnabledTickers: 15, messageRateLimitPerSecond: 8,
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

describe("filterTickerForPluto — ticker level", () => {
  it("passes a clean, enabled ticker scored on today's surface", () => {
    const result = filterTickerForPluto(input());
    expect(result.tickerBlocks).toEqual([]);
    expect(result.eligible.map((entry) => entry.id)).toEqual(["HOOD:cash_secured_put:2026-10-16:100"]);
    expect(result.eligible[0]!.kind).toBe("open_cash_secured_put");
  });
  it("blocks a disabled ticker, a stale surface, a fallback forecast, a big day move and a non-live spot", () => {
    expect(filterTickerForPluto(input({ botEnabled: false })).tickerBlocks).toEqual(["ticker not enabled for Pluto"]);
    expect(filterTickerForPluto(input({ scored: scored({ snapshotDateIso: "2026-09-25" }) })).tickerBlocks[0]).toMatch(/requires today's fit/);
    expect(filterTickerForPluto(input({ scored: scored({ forecast: { volatility: 0.5, windowDays: 21 } }) })).tickerBlocks[0]).toMatch(/not the 63-day/);
    expect(filterTickerForPluto(input({ scored: scored({ dayChangePercent: -7.2 }) })).tickerBlocks[0]).toMatch(/day change -7.2%/);
    expect(filterTickerForPluto(input({ scored: scored({ priceSource: "frozen" }) })).tickerBlocks[0]).toMatch(/not live/);
    expect(filterTickerForPluto(input({ scored: scored({ unscoredReason: "no_surface_fit" }) })).tickerBlocks).toContain("not scored: no_surface_fit");
  });
  it("a blocked ticker evaluates nothing below it", () => {
    const result = filterTickerForPluto(input({ botEnabled: false }));
    expect(result.eligible).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe("filterTickerForPluto — candidate level", () => {
  function rejectionsFor(overrides: Partial<SignalCandidate>, extra: Partial<PlutoTickerFilterInput> = {}): string[] {
    const result = filterTickerForPluto(input({ scored: scored({ candidates: [candidate(overrides)] }), ...extra }));
    return result.rejected[0]?.reasons ?? [];
  }
  it("applies every quality dial", () => {
    expect(rejectionsFor({ grade: "weak" })).toEqual(["grade weak below good"]);
    expect(rejectionsFor({ edgeDollars: 12 })).toEqual(["Edge $12 below $30"]);
    expect(rejectionsFor({ delta: -0.35 })).toEqual(["|delta| 0.35 above 0.3"]);
    expect(rejectionsFor({ dte: 1 })).toEqual(["DTE 1 outside 2–45"]);
    expect(rejectionsFor({ dte: 60 })).toEqual(["DTE 60 outside 2–45"]);
    expect(rejectionsFor({ annualizedYield: 0.3 })).toEqual(["annualized yield 30% below 50%"]);
    expect(rejectionsFor({ spreadPercent: 22 })).toEqual(["spread 22.0% above 15%"]);
    expect(rejectionsFor({ openInterest: 120 })).toEqual(["open interest 120 below 500"]);
    expect(rejectionsFor({ openInterest: null })).toEqual(["open interest unknown below 500"]);
    expect(rejectionsFor({ volume: 3 })).toEqual(["session volume 3 below 50"]);
  });
  it("applies the quote-freshness rule per source", () => {
    expect(rejectionsFor({ quoteSource: "day", quotedAt: new Date(now - 25 * 60_000).toISOString() })).toEqual(["quote 25 min old (day), max 10"]);
    expect(rejectionsFor({ quoteSource: "snapshot", quotedAt: null })).toEqual(["quote 55 min old (snapshot), max 10"]);
    expect(rejectionsFor({ quoteSource: "live", quotedAt: null })).toEqual([]);
  });
  it("applies the model-risk dials from the slice, the mid IV and the intraday shift", () => {
    expect(rejectionsFor({}, { slices: [slice({ rmseVolatility: 0.031 })] })).toEqual(["slice RMSE 3.1 vp above 2 vp"]);
    expect(rejectionsFor({}, { slices: [slice({ pointCount: 6 })] })).toEqual(["slice fitted on 6 points, min 10"]);
    expect(rejectionsFor({}, { slices: [slice({ calendarViolations: 2 })] })).toEqual(["slice has 2 calendar-arbitrage violation(s)"]);
    expect(rejectionsFor({}, { slices: [] })).toEqual(["no fitted slice for the expiry"]);
    expect(rejectionsFor({ midImpliedVolatility: 0.54 })).toEqual(["mid IV is 8.0 vp from the surface, max 5"]);
    expect(rejectionsFor({}, { scored: scored({ candidates: [candidate()], ivShiftByExpiry: { "2026-10-16": { shiftVolatilityPoints: -9.5, quoteCount: 12 } } }) })).toEqual(["intraday IV shift -9.5 vp beyond ±8"]);
  });
  it("flags: extrapolated range, insufficient cash and unresolved earnings reject; the macro flag is allowed through", () => {
    expect(rejectionsFor({ flags: ["outside_fitted_range"] })).toEqual(["strike outside the fitted range (extrapolated surface)"]);
    expect(rejectionsFor({ flags: ["insufficient_cash"], executable: false })).toEqual(["insufficient free cash", "not executable"]);
    expect(rejectionsFor({ flags: ["earnings_calendar_unresolved"] })).toEqual(["earnings calendar unresolved for this ticker"]);
    expect(rejectionsFor({ flags: ["macro_event_before_expiry"] })).toEqual([]);
  });
  it("lists every reason at once, not just the first", () => {
    expect(rejectionsFor({ grade: "weak", volume: 1 })).toHaveLength(2);
  });
});

describe("rolls, the deterministic pick and the fingerprint", () => {
  const roll: RollSignalCandidate = {
    legId: "leg1", positionId: "pos1", strategyKey: "cash_secured_put", quantity: 2,
    replacement: candidate({ expiry: "2026-10-16", strike: 95, grade: "weak", edgeDollars: 10 }),
    netRollEdge: 0.07, netRollEdgeDollarsPerContract: 45, netRollEdgeDollars: 90, netCreditPerShare: 0.4, deltaChange: -0.03, dollarRiskChange: -500, flags: [], warnings: [], grade: "good",
  };
  it("judges a roll on its own grade and Edge $, and the replacement on every other dial", () => {
    const result = filterTickerForPluto(input({ scored: scored({ rolls: [roll] }) }));
    expect(result.eligibleRolls.map((entry) => entry.id)).toEqual(["HOOD:roll:leg1:2026-10-16:95"]);
    const bad = filterTickerForPluto(input({ scored: scored({ rolls: [{ ...roll, replacement: candidate({ strike: 95, spreadPercent: 30 }) }] }) }));
    expect(bad.rejectedRolls[0]!.reasons).toEqual(["replacement: spread 30.0% above 15%"]);
  });
  it("judges a roll's Edge $ per contract, not its total across the held quantity", () => {
    const result = filterTickerForPluto(input({ scored: scored({ rolls: [{ ...roll, netRollEdgeDollarsPerContract: 20, netRollEdgeDollars: 40 }] }) }));
    expect(result.eligibleRolls).toEqual([]);
    expect(result.rejectedRolls[0]!.reasons).toEqual(["net roll Edge $20/contract below $30"]);
  });
  it("the deterministic pick is Edge $ first, net Edge second", () => {
    const a = { id: "a", kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ edgeDollars: 50, netEdge: 0.06 }) };
    const b = { id: "b", kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ edgeDollars: 50, netEdge: 0.09 }) };
    const c = { id: "c", kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ edgeDollars: 40, netEdge: 0.2 }) };
    expect(deterministicTopPick([a, b, c])!.id).toBe("b");
    expect(deterministicTopPick([])).toBeNull();
  });
  it("the fingerprint ignores sub-step noise but sees grade and membership changes", () => {
    const base = { id: openCandidateId("HOOD", candidate()), kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ edgeDollars: 80, netEdge: 0.1 }) };
    const noisy = { ...base, candidate: candidate({ edgeDollars: 81.5, netEdge: 0.1015 }) };
    expect(candidateSetFingerprint([base], [])).toBe(candidateSetFingerprint([noisy], []));
    expect(candidateSetFingerprint([base], [])).not.toBe(candidateSetFingerprint([{ ...base, candidate: candidate({ grade: "good" }) }], []));
    expect(candidateSetFingerprint([base], [])).not.toBe(candidateSetFingerprint([], []));
  });
});
