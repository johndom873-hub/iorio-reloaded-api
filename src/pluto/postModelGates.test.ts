import { describe, expect, it } from "vitest";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoDecision } from "./decisionSchema.js";
import { computeSizingRoom, midLimitPrice, runPostModelGates, type PostModelBookInput, type PostModelGateInput } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";

const settings: PlutoSettings = {
  capitalBudgetPct: 50, maxTickerExposurePct: 10, maxSectorExposurePct: 100, maxOpenPositions: 8, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
  minGrade: "good", minEdgeDollars: 30, maxAbsDelta: 0.3, minDte: 2, maxDte: 45, minAnnualizedYieldPct: 50, maxSpreadPct: 15, minOpenInterest: 500, minSessionVolume: 50, maxQuoteAgeMinutes: 10, maxContractsVolumeSharePct: 20,
  maxSliceRmseVp: 2, minSlicePointCount: 10, maxMidVsSurfaceIvVp: 5, maxIvShiftVp: 8, maxAbsDayChangePct: 6,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2, spyStressBreakerPct: 3,
  maxEdgeDriftVp: 1, tickerCooldownMinutes: 60, maxFillSlippagePct: 25,
  modelId: "openai/gpt-6-luna", reasoningEffort: "medium", callTimeoutSeconds: 90, dailyCostCeilingUsd: 3, confidenceFloor: 0.6, consecutiveModelFailuresBreaker: 3, promptVersion: "v1",
  daySignalsPollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, perTickerModelCooldownMinutes: 10, globalMinCallIntervalSeconds: 60, maxEnabledTickers: 15, messageRateLimitPerSecond: 8,
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
  netLiquidationValue: 1_000_000, freeCash: 600_000, committedDollars: 50_000, inFlight: { totalNotional: 0, tickerNotional: 0, plutoNotional: 0 }, openPositionCount: 2, existingTickerExposure: 20_000, existingSectorExposure: 100_000, freeShares: 0,
  workingOrderOnSymbol: false, lastFilledActionAt: null, nowMs: Date.parse("2026-09-28T16:00:00Z"), spotPrice: 110, sameContractConflict: null,
};

const trade: PlutoDecision = { decision: "trade", actionKind: "open_cash_secured_put", candidateId: "HOOD:cash_secured_put:2026-10-16:100", confidence: 0.8, reasons: ["r"], risksAcknowledged: [], systemConcerns: [] };

function input(overrides: Partial<PostModelGateInput> = {}): PostModelGateInput {
  return { decision: trade, candidate: candidate(), roll: null, freshRejectionReasons: [], netEdgeAtDecision: 0.1, settings, book, sector: "Financial", ...overrides };
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
    expect(runPostModelGates(input({ candidate: candidate({ volume: 20 }) })).gates.find((gate) => gate.gate === "sizing")?.detail).toBe("order size $50000, budget left $450000, ticker room $80000, cash room $550000 → 5 contract(s) at $10000 each; volume share allows 4 → $40000");
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
    const busy = computeSizingRoom(settings, { ...book, inFlight: { totalNotional: 30_000, tickerNotional: 12_000, plutoNotional: 8_000 } }, false);
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
    expect(runPostModelGates(input()).gates.find((gate) => gate.gate === "same_contract")).toEqual({ gate: "same_contract", ok: true, detail: "no open position or working order on 2026-10-16 $100" });
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
