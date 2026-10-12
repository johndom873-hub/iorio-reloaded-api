import { describe, expect, it } from "vitest";
import type { SignalCandidate, SignalSurfaceSlice } from "../lib/signalCandidates.js";
import type { HeldLegScore, RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { TickerSignals } from "../lib/signalsTypes.js";
import { candidateSetFingerprint } from "./inputHash.js";
import { describeCandidateId, deterministicTopPick, filterTickerForPluto, openCandidateId, summarizeTopPick, type PlutoTickerFilterInput } from "./candidateFilters.js";
import type { PlutoSettings } from "./settingsStore.js";
import { fixtureCandidateModel, fixtureModelForecast, fixtureRollModel } from "../lib/testSupport/valuationModelFixtures.js";
import type { CandidateModelScore } from "../lib/signalCandidates.js";

const now = Date.parse("2026-09-28T15:00:00Z"); // 11:00 ET
const today = "2026-09-28";

const settings: PlutoSettings = {
  capitalBudgetPct: 30, maxTickerExposurePct: 10, maxSectorExposurePct: 100, maxOpenPositions: 8, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
  minGrade: "good", minEdgeYieldPct: 15, maxAbsDelta: 0.3, minDte: 2, maxDte: 45, minAnnualizedYieldPct: 50, maxSpreadPct: 15, minOpenInterest: 500, minSessionVolume: 50, maxQuoteAgeMinutes: 10, maxContractsVolumeSharePct: 20,
  maxSliceRmseVp: 2, minSlicePointCount: 10, maxMidVsSurfaceIvVp: 5, maxIvShiftVp: 8, maxDayMoveMultiple: 3, stressRiskBudgetPct: 0, stressSigmas: 2,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2, spyStressBreakerPct: 3,
  maxEdgeMarginDriftPts: 10, tickerCooldownMinutes: 60, maxFillSlippagePct: 25,
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
    model: model(),
    ...overrides,
  };
}

/** The default candidate's model block: margin 35% (Strong), $80 expected P&L (Edge Yield 46%), 83% premium yield. */
function model(overrides: Partial<CandidateModelScore> = {}): CandidateModelScore {
  // $80 on $9,000 over 7 days: Edge Yield 46% a year.
  return fixtureCandidateModel({ edgeMargin: 0.35, expectedPnlDollars: 80, expectedAnnualizedReturn: 80 / 9000 / (7 / 365), premiumYield: 0.83, calibratedAnnualizedReturn: 0.3, ...overrides });
}

function slice(overrides: Partial<SignalSurfaceSlice> = {}): SignalSurfaceSlice {
  return { expiry: "2026-10-16", status: "ok", parameters: { a: 0.01, b: 0.1, rho: -0.3, m: 0, sigma: 0.2 }, kMin: -0.4, kMax: 0.4, yearsToExpiry: 18 / 365, forwardPrice: 110, pointCount: 24, rmseVolatility: 0.012, minButterflyDensity: 0.5, droppedCounts: { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 }, calendarChecks: 21, calendarViolations: 0, ...overrides };
}

function scored(overrides: Partial<TickerSignals> = {}): TickerSignals {
  return {
    tickerId: "t1", symbol: "HOOD", companyName: "Robinhood", sector: "Financial", snapshotDateIso: today, snapshotCapturedAt: "2026-09-28T14:05:00Z", spotPrice: 110, priceSource: "live",
    previousClose: { close: 108, dateIso: "2026-09-25" }, dayChangePercent: 1.85, candidates: [candidate()], best: null, gradeCounts: { strong: 1, good: 0, weak: 0, avoid: 0 },
    heldLegs: [], rolls: [], bestRoll: null, rollCount: 0, fittedSliceCount: 3, totalSliceCount: 3, momentum: 0.1, skew: null, elevatedVolatility: null, nextEarningsDateIso: "2026-11-04", macroEvents: [],
    atmImpliedVolatility: 0.6, atmImpliedVolatilityPerSession: 0.66, forecast: { volatility: 0.5, windowDays: 63 }, modelForecast: fixtureModelForecast(0.5), dailyBarCount: 1250, dividendCadenceUnknown: false, caveats: [], freeShares: 0, freeCash: 500_000,
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
  it("blocks a disabled ticker, a stale surface, a missing model forecast, a big day move and a non-live spot", () => {
    expect(filterTickerForPluto(input({ botEnabled: false })).tickerBlocks).toEqual(["ticker not enabled for Pluto"]);
    expect(filterTickerForPluto(input({ scored: scored({ snapshotDateIso: "2026-09-25" }) })).tickerBlocks[0]).toMatch(/requires today's fit/);
    expect(filterTickerForPluto(input({ scored: scored({ modelForecast: null }) })).tickerBlocks).toEqual(["no 21-day volatility forecast for the valuation model (fewer than 22 daily bars before today)", "no volatility forecast to judge today's move against"]);
    // The old Edge's forecast window no longer matters to Pluto.
    expect(filterTickerForPluto(input({ scored: scored({ forecast: { volatility: 0.5, windowDays: 21 } }) })).tickerBlocks).toEqual([]);
    // 50% YZ21 volatility: a normal day is 50 / √252 = 3.15%, so 3× is 9.45%.
    expect(filterTickerForPluto(input({ scored: scored({ dayChangePercent: -9.6 }) })).tickerBlocks[0]).toBe("day change -9.6% is 3.05× its normal 3.15% day, beyond 3×");
    expect(filterTickerForPluto(input({ scored: scored({ dayChangePercent: -9.3 }) })).tickerBlocks).toEqual([]);
    expect(filterTickerForPluto(input({ scored: scored({ dayChangePercent: 7.2 }) })).tickerBlocks).toEqual([]); // the old fixed ±6% would have blocked it
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
    expect(rejectionsFor({ model: model({ edgeMargin: 0.15, grade: "weak" }) })).toEqual(["grade weak (edge margin 15%) below good"]);
    expect(rejectionsFor({ model: model({ expectedAnnualizedReturn: 0.12 }) })).toEqual(["Edge Yield 12% below 15%"]);
    expect(rejectionsFor({ delta: -0.35 })).toEqual(["|delta| 0.35 above 0.3"]);
    expect(rejectionsFor({ dte: 1 })).toEqual(["DTE 1 outside 2–45"]);
    expect(rejectionsFor({ dte: 60 })).toEqual(["DTE 60 outside 2–45"]);
    expect(rejectionsFor({ model: model({ premiumYield: 0.3 }) })).toEqual(["premium yield 30% a year below 50%"]);
    expect(rejectionsFor({ spreadPercent: 22 })).toEqual(["spread 22.0% above 15%"]);
    expect(rejectionsFor({ openInterest: 120 })).toEqual(["open interest 120 below 500"]);
    expect(rejectionsFor({ openInterest: null })).toEqual(["open interest unknown below 500"]);
    expect(rejectionsFor({ volume: 3 })).toEqual(["session volume 3 below 50"]);
  });
  it("holds every contract to the same yearly rate, whatever its dollars: $5 over 2 days passes, $40 over 45 days does not", () => {
    // $5 on $4,000 over 2 days = 22.8% a year; $40 on $4,000 over 45 days = 8.1% a year.
    expect(rejectionsFor({ model: model({ expectedPnlDollars: 5, capitalAtRiskDollars: 4_000, expectedAnnualizedReturn: (5 / 4_000) * (365 / 2) }) })).toEqual([]);
    expect(rejectionsFor({ model: model({ expectedPnlDollars: 40, capitalAtRiskDollars: 4_000, expectedAnnualizedReturn: (40 / 4_000) * (365 / 45) }) })).toEqual(["Edge Yield 8% below 15%"]);
  });
  it("judges value on the model only: the old Edge's grade, Edge $ and yield are ignored, and an unvalued contract is out", () => {
    expect(rejectionsFor({ grade: "avoid", edgeDollars: -50, netEdge: -0.1, annualizedYield: 0.01 })).toEqual([]);
    expect(rejectionsFor({ model: null })).toEqual(["not valued by the model (no YZ21 forecast or no variance time left)"]);
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
    expect(rejectionsFor({ model: model({ edgeMargin: 0.15, grade: "weak" }), volume: 1 })).toHaveLength(2);
  });
  it("records the rule behind each reason, in the same order", () => {
    const codesFor = (overrides: Partial<SignalCandidate>, extra: Partial<PlutoTickerFilterInput> = {}) => filterTickerForPluto(input({ scored: scored({ candidates: [candidate(overrides)] }), ...extra })).rejected[0]?.codes ?? [];
    expect(codesFor({ model: model({ edgeMargin: 0.15, grade: "weak", expectedAnnualizedReturn: 0.12, premiumYield: 0.3 }), delta: -0.35, dte: 1, spreadPercent: 22, openInterest: null, volume: 3 })).toEqual(["grade", "edge_yield", "yield", "delta", "dte", "spread", "open_interest", "volume"]);
    expect(codesFor({ model: null })).toEqual(["no_model"]);
    expect(codesFor({ quoteSource: "snapshot", quotedAt: null })).toEqual(["quote_age"]);
    expect(codesFor({}, { slices: [] })).toEqual(["no_slice"]);
    expect(codesFor({}, { slices: [slice({ rmseVolatility: 0.031, pointCount: 6, calendarViolations: 1 })] })).toEqual(["slice_rmse", "slice_points", "calendar_arbitrage"]);
    expect(codesFor({ midImpliedVolatility: null })).toEqual(["no_mid_iv"]);
    expect(codesFor({ midImpliedVolatility: 0.54 })).toEqual(["mid_iv_gap"]);
    expect(codesFor({ flags: ["outside_fitted_range", "insufficient_cash", "earnings_calendar_unresolved"], executable: false })).toEqual(["outside_fitted_range", "insufficient_cash", "earnings_unresolved", "not_executable"]);
    expect(codesFor({}, { opensBlockedReason: "ticker cooldown" })).toEqual(["opens_blocked"]);
    expect(codesFor({}, { occupiedContracts: [{ expiry: "2026-10-16", strike: 100, detail: "held" }] })).toEqual(["same_contract"]);
  });
  it("a ticker whose opens are barred for the round (the ticker cooldown) offers no open, whatever its quality", () => {
    expect(rejectionsFor({}, { opensBlockedReason: "ticker cooldown: last filled Pluto action on this symbol 20 min ago (cooldown 60 min)" })).toEqual(["ticker cooldown: last filled Pluto action on this symbol 20 min ago (cooldown 60 min)"]);
    expect(filterTickerForPluto(input({ scored: scored({ candidates: [candidate()] }), opensBlockedReason: "ticker cooldown" })).eligible).toEqual([]);
  });
});

describe("rolls, the deterministic pick and the fingerprint", () => {
  const roll: RollSignalCandidate = {
    legId: "leg1", positionId: "pos1", strategyKey: "cash_secured_put", quantity: 2,
    // The replacement alone would fail the grade and Edge Yield rules: a roll is judged on the roll's own model figures.
    replacement: candidate({ expiry: "2026-10-16", strike: 95, model: model({ edgeMargin: 0.15, grade: "weak", expectedPnlDollars: 10, expectedAnnualizedReturn: 10 / 9000 / (7 / 365) }) }),
    netRollEdge: 0.07, netRollEdgeDollarsPerContract: 45, netRollEdgeDollars: 90, netCreditPerShare: 0.4, deltaChange: -0.03, dollarRiskChange: -500, flags: [], warnings: [], grade: "good",
    model: fixtureRollModel({ netExpectedPnlPerContract: 45, netExpectedPnl: 90, edgeMargin: 0.25 }),
  };
  it("judges a roll on its own model grade and Edge Yield, and the replacement on every other dial", () => {
    const result = filterTickerForPluto(input({ scored: scored({ rolls: [roll] }) }));
    expect(result.eligibleRolls.map((entry) => entry.id)).toEqual(["HOOD:roll:leg1:2026-10-16:95"]);
    const bad = filterTickerForPluto(input({ scored: scored({ rolls: [{ ...roll, replacement: candidate({ strike: 95, spreadPercent: 30 }) }] }) }));
    expect(bad.rejectedRolls[0]!.reasons).toEqual(["replacement: spread 30.0% above 15%"]);
  });
  it("judges a roll's Edge Yield per contract on the new leg's exposure and days, not its total across the held quantity", () => {
    const result = filterTickerForPluto(input({ scored: scored({ rolls: [{ ...roll, model: fixtureRollModel({ netExpectedPnlPerContract: 20, netExpectedPnl: 40, edgeMargin: 0.25 }) }] }) }));
    expect(result.eligibleRolls).toEqual([]);
    // $20 on the new leg's $9,000 over 7 days = 11.6% a year; the $40 total would have passed at 23%.
    expect(result.rejectedRolls[0]!.reasons).toEqual(["net roll Edge Yield 12% below 15%"]);
    expect(result.rejectedRolls[0]!.codes).toEqual(["edge_yield"]);
  });
  it("rejects a roll the model could not value, whatever its old-Edge grade", () => {
    const result = filterTickerForPluto(input({ scored: scored({ rolls: [{ ...roll, grade: "strong", model: null }] }) }));
    expect(result.rejectedRolls[0]!.codes).toEqual(["no_model"]);
  });
  it("a roll's replacement keeps the rule codes of an open, under the replacement's reason text", () => {
    const bad = filterTickerForPluto(input({ scored: scored({ rolls: [{ ...roll, model: fixtureRollModel({ netExpectedPnlPerContract: 45, edgeMargin: 0.15 }), replacement: candidate({ strike: 95, spreadPercent: 30 }) }] }) }));
    expect(bad.rejectedRolls[0]!.codes).toEqual(["grade", "spread"]);
  });
  it("the deterministic pick is Edge Yield first, the model's Edge $ second, unvalued last", () => {
    const a = { id: "a", kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ model: model({ expectedAnnualizedReturn: 0.3, calibratedAnnualizedReturn: 0.1, expectedPnlDollars: 50 }) }) };
    const b = { id: "b", kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ model: model({ expectedAnnualizedReturn: 0.3, calibratedAnnualizedReturn: 0.1, expectedPnlDollars: 70 }) }) };
    const c = { id: "c", kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ model: model({ expectedAnnualizedReturn: 0.2, calibratedAnnualizedReturn: 0.9, expectedPnlDollars: 200 }), edgeDollars: 500 }) };
    const unvalued = { id: "d", kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ model: null, edgeDollars: 900 }) };
    expect(deterministicTopPick([unvalued, a, b, c])!.id).toBe("b");
    expect(deterministicTopPick([unvalued, c])!.id).toBe("c");
    expect(deterministicTopPick([])).toBeNull();
    // The ledger keeps the top pick's model figures and the one after it.
    expect(summarizeTopPick([unvalued, a, b, c])).toEqual({ id: "b", edgeDollars: 70, edgeMargin: b.candidate.model!.edgeMargin, grade: b.candidate.model!.grade, calibratedAnnualizedReturn: 0.1, expectedAnnualizedReturn: 0.3, capitalAtRiskDollars: 9000, rankedBy: "edge_yield", runnerUp: { id: "a", calibratedAnnualizedReturn: 0.1, expectedAnnualizedReturn: 0.3 } });
    expect(summarizeTopPick([unvalued, c])!.runnerUp).toBeNull();
    expect(summarizeTopPick([unvalued])).toBeNull();
  });
  it("the fingerprint ignores sub-step noise but sees grade and membership changes", () => {
    const base = { id: openCandidateId("HOOD", candidate()), kind: "open_cash_secured_put" as const, symbol: "HOOD", candidate: candidate({ model: model({ expectedPnlDollars: 80, edgeMargin: 0.35 }) }) };
    const noisy = { ...base, candidate: candidate({ model: model({ expectedPnlDollars: 81.5, edgeMargin: 0.3504 }), edgeDollars: 10, netEdge: 0.5 }) };
    expect(candidateSetFingerprint([base], [])).toBe(candidateSetFingerprint([noisy], []));
    expect(candidateSetFingerprint([base], [])).not.toBe(candidateSetFingerprint([{ ...base, candidate: candidate({ model: model({ expectedPnlDollars: 80, edgeMargin: 0.35, grade: "good" }) }) }], []));
    expect(candidateSetFingerprint([base], [])).not.toBe(candidateSetFingerprint([{ ...base, candidate: candidate({ model: model({ expectedPnlDollars: 90, edgeMargin: 0.35 }) }) }], []));
    expect(candidateSetFingerprint([base], [])).not.toBe(candidateSetFingerprint([{ ...base, candidate: candidate({ model: model({ expectedPnlDollars: 80, edgeMargin: 0.37 }) }) }], []));
    expect(candidateSetFingerprint([base], [])).not.toBe(candidateSetFingerprint([], []));
  });
});

describe("describeCandidateId", () => {
  it("words each candidate id kind in the platform's contract standard", () => {
    expect(describeCandidateId("SMCI:covered_call:2026-10-09:47", "2026-10-07")).toBe("SMCI $47 Call · 9 Oct (2DTE)");
    expect(describeCandidateId("HOOD:cash_secured_put:2026-10-17:42.5", "2026-10-07")).toBe("HOOD $42.5 Put · 17 Oct (10DTE)");
    expect(describeCandidateId("MU:roll:leg-1:2026-10-16:100", "2026-10-07")).toBe("MU Roll → $100 · 16 Oct (9DTE)");
    expect(describeCandidateId("COIN:close_leg:leg-1", "2026-10-07")).toBe("COIN Buy back");
    expect(describeCandidateId("SMCI:close_position:p-1", "2026-10-07")).toBe("SMCI Close covered Call");
    expect(describeCandidateId("not-an-id", "2026-10-07")).toBe("not-an-id");
  });
});

describe("covered calls on held shares (Marcelo, 2026-10-12)", () => {
  // 100 shares acquired for $10,800 (average $108) with $300 of premium: break-even $105, floor max(1% × $108 × 100, $50) = $108.
  const cycle = { breakEvenPerShare: 105, unavailableReason: null, sharesAcquired: 100, acquisitionCost: 10_800 };
  const weakCall = (overrides: Partial<SignalCandidate> = {}) =>
    candidate({ strategyKey: "covered_call", strike: 112, delta: 0.25, bid: 1.0, ask: 1.1, model: model({ edgeMargin: 0.12, expectedAnnualizedReturn: 0.05, premiumYield: 0.2, calibratedExpectedPnlDollars: 4, calibratedAnnualizedReturn: 0.1 }), ...overrides });
  const held = (overrides: Partial<TickerSignals> = {}, extra: Partial<PlutoTickerFilterInput> = {}) => filterTickerForPluto(input({ scored: scored({ freeShares: 100, candidates: [weakCall()], ...overrides }), cycleBreakEven: cycle, ...extra }));

  it("drops the grade, Edge Yield and premium-yield minimums for a call on held shares, and carries the cycle if assigned", () => {
    const result = held();
    expect(result.rejected).toEqual([]);
    // $112 at 1.05 mid less $0.0068 commission: break-even 103.9568, (112 − 103.9568) × 100 = $804.32
    expect(result.eligible[0]!.heldShares!.contracts).toBe(1);
    expect(result.eligible[0]!.heldShares!.breakEvenAfter).toBeCloseTo(103.9568, 6);
    expect(result.eligible[0]!.heldShares!.profitIfCalledAway).toBeCloseTo(804.32, 6);
    // the same call with no free shares is a buy-write and meets the usual minimums
    expect(filterTickerForPluto(input({ scored: scored({ candidates: [weakCall()] }) })).rejected[0]!.codes).toEqual(["grade", "edge_yield", "yield"]);
  });
  it("still asks for a positive Edge, whatever Hist Edge says", () => {
    expect(held({ candidates: [weakCall({ model: model({ edgeMargin: 0.12, expectedPnlDollars: 0, calibratedExpectedPnlDollars: 9 }) })] }).rejected[0]).toMatchObject({ codes: ["edge"], reasons: ["Edge $0/contract not above 0"] });
    expect(held({ candidates: [weakCall({ model: model({ edgeMargin: 0.12, expectedPnlDollars: 4, calibratedExpectedPnlDollars: -9 }) })] }).eligible).toHaveLength(1);
  });
  it("blocks a strike whose assignment would close the shares below the break-even plus the floor", () => {
    // $104: (104 − 103.9568) × 100 = $4.32, below $108
    const result = held({ candidates: [weakCall({ strike: 104 })] });
    expect(result.eligible).toEqual([]);
    expect(result.rejected[0]).toEqual({ id: "HOOD:covered_call:2026-10-16:104", codes: ["below_break_even"], reasons: ["if assigned, the $104 strike closes 100 shares $4 over the cycle break-even of 103.96 (after this premium), below the $108 minimum profit"] });
    // the floor is 103.9568 + 1.08 = 105.0368 a share: $105.04 passes ($108.32), $105.03 does not ($107.32)
    expect(held({ candidates: [weakCall({ strike: 105.04 })] }).eligible).toHaveLength(1);
    expect(held({ candidates: [weakCall({ strike: 105.03 })] }).rejected[0]!.codes).toEqual(["below_break_even"]);
  });
  it("blocks every call on held shares when the break-even is unknown or was not loaded", () => {
    const unknown = held({}, { cycleBreakEven: { ...cycle, breakEvenPerShare: null, unavailableReason: "ledger says 100 sh held but the open stock legs total 200 sh" } });
    expect(unknown.rejected[0]).toMatchObject({ codes: ["no_break_even"], reasons: ["no cycle break-even for the held shares: ledger says 100 sh held but the open stock legs total 200 sh"] });
    expect(held({}, { cycleBreakEven: undefined }).rejected[0]!.codes).toEqual(["no_break_even"]);
  });
  it("offers the held shares one call, the best by Edge Yield; puts on the ticker are unaffected", () => {
    const better = weakCall({ strike: 114, model: model({ edgeMargin: 0.12, expectedPnlDollars: 6, expectedAnnualizedReturn: 0.2, calibratedAnnualizedReturn: -0.5 }) });
    const put = candidate();
    const result = held({ candidates: [weakCall(), better, put] });
    expect(result.eligible.map((entry) => entry.id).sort()).toEqual(["HOOD:cash_secured_put:2026-10-16:100", "HOOD:covered_call:2026-10-16:114"]);
    expect(result.rejected).toEqual([{ id: "HOOD:covered_call:2026-10-16:112", codes: ["held_shares_runner_up"], reasons: ["the held shares are offered one call, the best by Edge Yield: HOOD:covered_call:2026-10-16:114"] }]);
  });
  it("sizes the floor on every free round lot, and treats an odd lot as no held shares", () => {
    // 300 shares: 3 contracts, floor max(1% × $108 × 300, $50) = $324; break-even after 105 − 1.0432 × 300 / 300 = 103.9568 → $2,412.96
    const three = held({ freeShares: 350 }, { cycleBreakEven: { ...cycle, sharesAcquired: 300, acquisitionCost: 32_400 } });
    expect(three.eligible[0]!.heldShares!.contracts).toBe(3);
    expect(three.eligible[0]!.heldShares!.profitIfCalledAway).toBeCloseTo(2412.96, 6);
    expect(held({ freeShares: 80 }).rejected[0]!.codes).toEqual(["grade", "edge_yield", "yield"]);
  });

  describe("covered-call rolls", () => {
    const heldCall = { legId: "leg-call", positionId: "pos-cc", strategyKey: "covered_call", expiry: "2026-10-09", strike: 112, right: "C", quantity: 1, entryPrice: 1.2, entryAtIso: "2026-10-01T15:00:00Z" } as HeldLegScore;
    const callRoll = (strike: number, netCreditPerShare: number): RollSignalCandidate => ({
      legId: "leg-call", positionId: "pos-cc", strategyKey: "covered_call", quantity: 1,
      replacement: candidate({ strategyKey: "covered_call", strike, delta: 0.25 }),
      netRollEdge: 0.07, netRollEdgeDollarsPerContract: 45, netRollEdgeDollars: 45, netCreditPerShare, deltaChange: -0.03, dollarRiskChange: 0, flags: [], warnings: [], grade: "good",
      model: fixtureRollModel({ netExpectedPnlPerContract: 45, netExpectedPnl: 45, edgeMargin: 0.25 }),
    });
    const rolls = (roll: RollSignalCandidate, cycleBreakEven: PlutoTickerFilterInput["cycleBreakEven"] = cycle) =>
      filterTickerForPluto(input({ scored: scored({ candidates: [], heldLegs: [heldCall], rolls: [roll] }), cycleBreakEven }));

    it("blocks a roll that lowers the strike below the break-even plus the floor, counting the buyback", () => {
      // net credit 0.30 less two commissions = 0.2864: break-even 104.7136; $108 → $328.64 passes, $105.50 → $78.64 is below $108
      expect(rolls(callRoll(108, 0.3)).eligibleRolls).toHaveLength(1);
      const low = rolls(callRoll(105.5, 0.3));
      expect(low.rejectedRolls[0]).toEqual({ id: "HOOD:roll:leg-call:2026-10-16:105.5", codes: ["below_break_even"], reasons: ["replacement: if assigned, the $105.5 strike closes 100 shares $79 over the cycle break-even of 104.71 (after this premium), below the $108 minimum profit"] });
    });
    it("always allows a roll that keeps or raises the strike, even below break-even or with no break-even", () => {
      expect(rolls(callRoll(112, 0.3), null).eligibleRolls).toHaveLength(1);
      expect(rolls(callRoll(115, -0.1), { ...cycle, breakEvenPerShare: 120 }).eligibleRolls).toHaveLength(1);
    });
    it("blocks a strike-lowering roll when the break-even is unknown, and leaves put rolls alone", () => {
      expect(rolls(callRoll(108, 0.3), null).rejectedRolls[0]!.codes).toEqual(["no_break_even"]);
      const putRoll = { ...callRoll(95, 0.4), strategyKey: "cash_secured_put" as const, replacement: candidate({ strike: 95 }) };
      expect(rolls(putRoll, null).eligibleRolls).toHaveLength(1);
    });
  });
});
