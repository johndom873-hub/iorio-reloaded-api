import { describe, expect, it } from "vitest";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoDecision } from "./decisionSchema.js";
import { computeSizingRoom, computeStressCap, midLimitPrice, runPostModelGates, tickerCooldownStatus, type PostModelBookInput, type PostModelGateInput } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { openDaysFromCalendarRows } from "../lib/marketSessionStatus.js";

// Every weekday of 2026-27 (the scoring inputs list only open sessions; counts start after the scoring date).
const fixtureWeekdaySessions = openDaysFromCalendarRows("2026-01-01", "2027-12-31", []);

const settings: PlutoSettings = {
  capitalBudgetPct: 50, maxTickerExposurePct: 10, maxSectorExposurePct: 100, maxOpenPositions: 8, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
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
    strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 100, dte: 18, delta: -0.22, bid: 2.0, ask: 2.1, spreadPercent: 4.9, openInterest: 1200, volume: 300, bidSize: 40, askSize: 35,
    surfaceImpliedVolatility: 0.62, midImpliedVolatility: 0.61, forecastVolatility: 0.5, edge: 0.12, frictionVolatility: 0.02, netEdge: 0.1, edgeDollars: 80, vega: 0.08,
    dollarRisk: 9795, riskAdjustedRatio: 0.008, annualizedYield: 0.83, uncompensatedSharePercent: null,
    quoteSource: "live", quotedAt: null, flags: [], executable: true, grade: "strong", ...overrides,
  };
}

const book: PostModelBookInput = {
  netLiquidationValue: 1_000_000, freeCash: 600_000, committedDollars: 50_000, inFlight: { totalNotional: 0, tickerNotional: 0, managedNotional: 0 }, openPositionCount: 2, existingTickerExposure: 20_000, existingSectorExposure: 100_000, freeShares: 0,
  workingOrderOnSymbol: false, lastFilledActionAt: null, nowMs: Date.parse("2026-09-28T16:00:00Z"), spotPrice: 110, sameContractConflict: null,
};

const stress = { forecastVolatility: 0.5, elevatedVolatility: false, dayMoveSigmas: 0.2, todayEasternIso: "2026-09-28", openSessionDatesIso: fixtureWeekdaySessions };

const trade: PlutoDecision = { decision: "trade", actionKind: "open_cash_secured_put", candidateId: "HOOD:cash_secured_put:2026-10-16:100", confidence: 0.8, reasons: ["r"], risksAcknowledged: [], systemConcerns: [] };

function input(overrides: Partial<PostModelGateInput> = {}): PostModelGateInput {
  return { decision: trade, candidate: candidate(), roll: null, freshRejectionReasons: [], netEdgeAtDecision: 0.1, settings, book, sector: "Financial", stress, ...overrides };
}

function failed(output: ReturnType<typeof runPostModelGates>): string[] {
  return output.gates.filter((gate) => !gate.ok).map((gate) => gate.gate);
}

describe("runPostModelGates — a clean cash-secured put", () => {
  it("passes every gate and sizes to the standard order size", () => {
    const output = runPostModelGates(input());
    expect(failed(output)).toEqual([]);
    // order size 1M × 50% × 10% = 50k; budget room 450k, ticker room 80k, cash room 550k → 50k / 10k = 5; volume share 60 → 5
    expect(output.plan).toEqual({ quantity: 5, limitPrice: 2.05, notional: 50_000, fullSizeQuantity: 5 });
  });
  it("the order size is NLV × capital budget % × order size %", () => {
    expect(computeSizingRoom(settings, book, false).orderCap).toBe(50_000);
    expect(computeSizingRoom({ ...settings, capitalBudgetPct: 30, orderSizePctOfBudget: 20 }, book, false).orderCap).toBe(60_000);
    expect(computeSizingRoom(settings, { ...book, netLiquidationValue: 1_100_000 }, false).orderCap).toBe(55_000);
  });
  it("a tighter limit than the order size wins, and contracts round down", () => {
    // cash room 64k − 50k reserve = 14k → 1 contract
    expect(runPostModelGates(input({ book: { ...book, freeCash: 64_000 } })).plan?.quantity).toBe(1);
    // a $600 strike costs 60k a contract: more than the 50k order size → nothing
    expect(failed(runPostModelGates(input({ candidate: candidate({ strike: 600 }) })))).toEqual(["sizing"]);
  });
  it("the volume share caps the quantity", () => {
    expect(runPostModelGates(input({ candidate: candidate({ volume: 20 }) })).plan?.quantity).toBe(4);
    expect(runPostModelGates(input({ candidate: candidate({ volume: 20 }) })).gates.find((gate) => gate.gate === "sizing")?.detail).toBe("order size $50000, budget left $450000, ticker room $80000, cash room $550000 → 5 contract(s) at $10000 each; volume share allows 4; stress cap off → $40000");
    expect(failed(runPostModelGates(input({ candidate: candidate({ volume: 3 }) })))).toEqual(["sizing"]);
  });
});

describe("runPostModelGates — the gates", () => {
  it("refuses a non-trade verdict, low confidence, a stale candidate and edge drift", () => {
    expect(failed(runPostModelGates(input({ decision: { ...trade, decision: "no_trade" } })))).toContain("verdict");
    expect(failed(runPostModelGates(input({ decision: { ...trade, confidence: 0.5 } })))).toEqual(["confidence_floor"]);
    expect(failed(runPostModelGates(input({ freshRejectionReasons: ["spread 22% above 15%"] })))).toEqual(["candidate_fresh"]);
    expect(failed(runPostModelGates(input({ netEdgeAtDecision: 0.12 })))).toEqual(["edge_drift"]);
    expect(failed(runPostModelGates(input({ netEdgeAtDecision: 0.105 })))).toEqual([]);
  });
  it("refuses a symbol with a working order, one filled inside the cooldown, and a full book", () => {
    const filledMinutesAgo = (minutes: number) => new Date(book.nowMs - minutes * 60_000);
    expect(failed(runPostModelGates(input({ book: { ...book, workingOrderOnSymbol: true } })))).toEqual(["working_order"]);
    const inside = runPostModelGates(input({ book: { ...book, lastFilledActionAt: filledMinutesAgo(59) } }));
    expect(failed(inside)).toEqual(["ticker_cooldown"]);
    expect(inside.gates.find((gate) => gate.gate === "ticker_cooldown")?.detail).toBe("last filled Pluto action on this symbol 59 min ago (cooldown 60 min)");
    expect(failed(runPostModelGates(input({ book: { ...book, lastFilledActionAt: filledMinutesAgo(60) } })))).toEqual([]);
    expect(failed(runPostModelGates(input({ book: { ...book, openPositionCount: 8 } })))).toEqual(["open_positions_cap"]);
    expect(failed(runPostModelGates(input({ settings: { ...settings, tickerCooldownMinutes: 0 }, book: { ...book, lastFilledActionAt: filledMinutesAgo(1) } })))).toEqual([]);
  });
  it("sizes net of orders already in flight: every origin's against cash, the symbol's against the ticker, Pluto's own against the budget", () => {
    const idle = computeSizingRoom(settings, book, false);
    const busy = computeSizingRoom(settings, { ...book, inFlight: { totalNotional: 30_000, tickerNotional: 12_000, managedNotional: 8_000 } }, false);
    expect(idle.cashRoom - busy.cashRoom).toBe(30_000);
    expect(idle.tickerRoom - busy.tickerRoom).toBe(12_000);
    expect(idle.budgetRoom - busy.budgetRoom).toBe(8_000);
    expect(busy.orderCap).toBe(idle.orderCap);
  });
  it("sector room only bites when a sector cap is set", () => {
    expect(computeSizingRoom(settings, book, true).sectorRoom).toBe(Number.POSITIVE_INFINITY);
    const capped = runPostModelGates(input({ settings: { ...settings, maxSectorExposurePct: 11 } }));
    // sector room 110k − 100k = 10k → 1 contract
    expect(capped.plan?.quantity).toBe(1);
  });
  it("refuses a contract that is already held or has a working order, puts and calls alike", () => {
    const held = runPostModelGates(input({ book: { ...book, sameContractConflict: "open position on HOOD 2026-10-16 $100 (call)" } }));
    expect(failed(held)).toEqual(["same_contract"]);
    expect(held.gates.find((gate) => gate.gate === "same_contract")?.detail).toBe("open position on HOOD 2026-10-16 $100 (call)");
    expect(runPostModelGates(input()).gates.find((gate) => gate.gate === "same_contract")).toEqual({ gate: "same_contract", ok: true, detail: "no open position or working order on $100 Put · 16 Oct (18DTE)" });
  });
  it("lists every failing gate, not just the first", () => {
    expect(failed(runPostModelGates(input({ decision: { ...trade, confidence: 0.1 }, book: { ...book, workingOrderOnSymbol: true } })))).toEqual(["confidence_floor", "working_order"]);
  });
});

describe("runPostModelGates — covered calls and rolls", () => {
  it("a covered call uses free shares first, then buy-writes sized like a put from the tightest room", () => {
    const call = candidate({ strategyKey: "covered_call", strike: 130, delta: 0.22 });
    const decision: PlutoDecision = { ...trade, actionKind: "open_covered_call", candidateId: "HOOD:covered_call:2026-10-16:130" };
    // 350 free shares → 3 covered; order size 50k / (110 × 100) = 4 buy-writes → 7 contracts, 4 × 11,000 bought
    expect(runPostModelGates(input({ decision, candidate: call, book: { ...book, freeShares: 350 } })).plan).toEqual({ quantity: 7, limitPrice: 2.05, notional: 44_000, fullSizeQuantity: 7 });
    // no free shares at all: a pure buy-write
    expect(runPostModelGates(input({ decision, candidate: call })).plan).toEqual({ quantity: 4, limitPrice: 2.05, notional: 44_000, fullSizeQuantity: 4 });
    // no room and no shares → nothing
    const none = runPostModelGates(input({ decision, candidate: call, book: { ...book, freeShares: 80, freeCash: 40_000 } }));
    expect(failed(none)).toEqual(["sizing"]);
    // no live spot: free shares only
    expect(runPostModelGates(input({ decision, candidate: call, book: { ...book, freeShares: 350, spotPrice: null } })).plan).toEqual({ quantity: 3, limitPrice: 2.05, notional: 0, fullSizeQuantity: 3 });
  });
  it("a roll keeps the held quantity and only counts a strike increase as notional", () => {
    const roll: RollSignalCandidate = { legId: "leg1", positionId: "p1", strategyKey: "cash_secured_put", quantity: 3, replacement: candidate({ strike: 95 }), netRollEdge: 0.07, netRollEdgeDollarsPerContract: 40, netRollEdgeDollars: 120, netCreditPerShare: 0.4, deltaChange: -0.02, dollarRiskChange: -500, flags: [], warnings: [], grade: "good" };
    const decision: PlutoDecision = { ...trade, actionKind: "roll", candidateId: "HOOD:roll:leg1:2026-10-16:95" };
    const output = runPostModelGates(input({ decision, candidate: null, roll, netEdgeAtDecision: 0.07 }));
    expect(failed(output)).toEqual([]);
    expect(output.plan).toEqual({ quantity: 3, limitPrice: 2.05, notional: 0, fullSizeQuantity: 3 });
    const up = runPostModelGates(input({ decision, candidate: null, roll: { ...roll, dollarRiskChange: 500 }, netEdgeAtDecision: 0.07 }));
    expect(up.plan?.notional).toBe(1500);
  });
});

describe("midLimitPrice", () => {
  it("is the mid rounded to cents, clamped inside the market", () => {
    expect(midLimitPrice(2.0, 2.1)).toBe(2.05);
    expect(midLimitPrice(1.01, 1.02)).toBe(1.02); // 1.015 rounds up to 1.02, still inside
    expect(midLimitPrice(0.61, 0.62)).toBe(0.62);
  });
});

describe("tickerCooldownStatus (shared by the round's filters and the post-model gate)", () => {
  const filledAt = new Date("2026-10-07T14:14:26Z");
  it("is over with no filled action, at exactly the cooldown, or with the cooldown set to 0", () => {
    expect(tickerCooldownStatus(null, filledAt.getTime(), 60)).toEqual({ cooledDown: true, detail: "no filled Pluto action on this symbol" });
    expect(tickerCooldownStatus(filledAt, filledAt.getTime() + 60 * 60_000, 60).cooledDown).toBe(true);
    expect(tickerCooldownStatus(filledAt, filledAt.getTime() + 60_000, 0).cooledDown).toBe(true);
  });
  it("is still running 48 minutes after a fill (the 10-07 SMCI case)", () => {
    expect(tickerCooldownStatus(filledAt, filledAt.getTime() + 48.7 * 60_000, 60)).toEqual({ cooledDown: false, detail: "last filled Pluto action on this symbol 48 min ago (cooldown 60 min)" });
  });
});

describe("stress cap (Marcelo, 2026-10-08)", () => {
  const on = { ...settings, stressRiskBudgetPct: 1, stressSigmas: 2 };
  // SMCI on 2026-10-07: spot 44.02, forecast 76.1%, $46 call 2026-10-09 at 0.37/0.40, Wed → Fri = 2 trading days.
  const smciCall = { strategyKey: "covered_call" as const, strike: 46, expiry: "2026-10-09", bid: 0.37, ask: 0.4 };
  const smciDay = { forecastVolatility: 0.761, elevatedVolatility: false, dayMoveSigmas: 0.31, todayEasternIso: "2026-10-07", openSessionDatesIso: fixtureWeekdaySessions };
  it("sizes a buy-write from a 2σ move to expiry: σ_T 6.78%, stressed spot 38.05, loss $558/contract, 18 contracts within $10,383", () => {
    const cap = computeStressCap(on, smciDay, smciCall, 44.02, 1_038_326);
    expect(cap.contracts).toBe(18);
    expect(cap.detail).toBe("stress cap: a 2σ move to expiry (−13.6% in 2 trading day(s)) loses $558/contract → 18 within $10383 (1% of account)");
  });
  it("a cash-secured put loses only below its strike: far out of the money, the cap does not bind", () => {
    const farPut = { strategyKey: "cash_secured_put" as const, strike: 30, expiry: "2026-10-09", bid: 0.01, ask: 0.02 };
    expect(computeStressCap(on, smciDay, farPut, 44.02, 1_000_000).contracts).toBe(Number.POSITIVE_INFINITY);
    const nearPut = { strategyKey: "cash_secured_put" as const, strike: 43, expiry: "2026-10-09", bid: 0.56, ask: 0.61 };
    // stressed spot 44.02 × (1 − 0.1356) = 38.05 → (43 − 38.05) × 100 − 58.5 = $436 → floor(10,000 / 436) = 22
    expect(computeStressCap(on, smciDay, nearPut, 44.02, 1_000_000).contracts).toBe(22);
  });
  it("counts market sessions, not weekdays: Tue 24 Nov → Fri 27 Nov is 2 sessions around Thanksgiving", () => {
    const thanksgivingWeek = { ...smciDay, todayEasternIso: "2026-11-24", openSessionDatesIso: fixtureWeekdaySessions.filter((dateIso) => dateIso !== "2026-11-26") };
    expect(computeStressCap(on, thanksgivingWeek, { ...smciCall, expiry: "2026-11-27" }, 44.02, 1_038_326).detail).toContain("in 2 trading day(s)");
  });
  it("adds 0.5σ for an elevated-volatility stretch and 0.5σ on a day down more than one normal day", () => {
    expect(computeStressCap(on, { ...smciDay, elevatedVolatility: true }, smciCall, 44.02, 1_038_326).detail).toContain("a 2.5σ (elevated volatility) move");
    expect(computeStressCap(on, { ...smciDay, dayMoveSigmas: -1 }, smciCall, 44.02, 1_038_326).detail).toContain("a 2.5σ (down more than a normal day) move");
    expect(computeStressCap(on, { ...smciDay, dayMoveSigmas: 1.8 }, smciCall, 44.02, 1_038_326).detail).toContain("a 2σ move");
    expect(computeStressCap(on, { ...smciDay, elevatedVolatility: true, dayMoveSigmas: -2 }, smciCall, 44.02, 1_038_326).contracts).toBeLessThan(18);
  });
  it("a longer expiry carries a bigger tail and gets fewer contracts: 22 trading days, a 45% move, $1,941/contract → 5", () => {
    const thirtyDays = { ...smciCall, strike: 50, expiry: "2026-11-06" };
    expect(computeStressCap(on, smciDay, thirtyDays, 44.02, 1_038_326).contracts).toBe(5);
  });
  it("0 turns it off; no forecast or no live spot refuses the order (fail closed)", () => {
    expect(computeStressCap({ ...on, stressRiskBudgetPct: 0 }, smciDay, smciCall, 44.02, 1_000_000)).toEqual({ contracts: Number.POSITIVE_INFINITY, detail: "stress cap off" });
    expect(computeStressCap(on, { ...smciDay, forecastVolatility: null }, smciCall, 44.02, 1_000_000).contracts).toBe(0);
    expect(computeStressCap(on, smciDay, smciCall, null, 1_000_000).contracts).toBe(0);
  });
  it("caps the put's quantity in the sizing gate, and says so", () => {
    // put $100, 2.05 mid, spot 110, forecast 50%, 2026-09-28 → 2026-10-16 = 14 trading days: σ_T 11.8%, stressed 84.07 → loss $1,388 → 7 at 1%, 3 at 0.5%
    expect(runPostModelGates(input({ settings: { ...on, stressRiskBudgetPct: 0.5 } })).plan?.quantity).toBe(3);
    expect(runPostModelGates(input({ settings: { ...on, stressRiskBudgetPct: 0.5 } })).gates.find((gate) => gate.gate === "sizing")?.detail).toContain("stress cap: a 2σ move to expiry");
    expect(runPostModelGates(input({ settings: on })).plan?.quantity).toBe(5); // the 5-contract order size binds first
  });
  it("caps only the contracts that buy shares: calls on shares already held are never capped", () => {
    const callTrade = { ...trade, actionKind: "open_covered_call" as const, candidateId: "HOOD:covered_call:2026-10-16:120" };
    const call = candidate({ strategyKey: "covered_call", strike: 120, delta: 0.25, bid: 1.5, ask: 1.6, volume: 1000 });
    const capped = { ...on, stressRiskBudgetPct: 0.2 }; // $2,000: a buy-write's 2σ loss (~$2,450 here) allows none
    expect(runPostModelGates(input({ decision: callTrade, candidate: call, settings: capped, book: { ...book, freeShares: 0 } })).plan).toBeNull();
    expect(runPostModelGates(input({ decision: callTrade, candidate: call, settings: capped, book: { ...book, freeShares: 300 } })).plan?.quantity).toBe(3);
  });
});
