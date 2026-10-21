import { describe, expect, it } from "vitest";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { PlutoDecision } from "./decisionSchema.js";
import { computeKellyCap, computeSizingRoom, computeStressCap, kellyFraction, midLimitPrice, runHeldShareCallGates, runPostModelGates, tickerCooldownStatus, type HeldShareCallGateInput, type PostModelBookInput, type PostModelGateInput } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { plutoLadderSettingsFixture } from "./plutoSettingsFixture.js";
import type { CandidateModelScore } from "../lib/signalCandidates.js";
import { fixtureCandidateModel, fixtureRollModel } from "../lib/testSupport/valuationModelFixtures.js";

const settings: PlutoSettings = {
  ...plutoLadderSettingsFixture,
  capitalBudgetPct: 50, maxTickerPctOfBudget: 20, maxSectorPctOfBudget: 100, maxOpenPositions: 8, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
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
    strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 100, dte: 18, delta: -0.22, bid: 2.0, ask: 2.1, spreadPercent: 4.9, openInterest: 1200, volume: 300, bidSize: 40, askSize: 35,
    surfaceImpliedVolatility: 0.62, midImpliedVolatility: 0.61, vega: 0.08,
    dollarRisk: 9795, annualizedYield: 0.83, uncompensatedSharePercent: null,
    quoteSource: "live", quotedAt: null, flags: [], executable: true, model: model(), ...overrides,
  };
}

/**
 * The default model block: margin 35%, 14 sessions of variance, Edge $80/contract (Hist Edge $30) over a $150 P&L
 * standard deviation, so the half-Kelly cap on Edge $ is floor(0.5 × $500,000 budget × 80 ÷ 22,500) = 888 contracts and never binds unless a test
 * says so. A Covered Call entry's variance is set by the call fixtures.
 */
function model(overrides: Partial<CandidateModelScore> = {}): CandidateModelScore {
  return fixtureCandidateModel({ edgeMargin: 0.35, expectedPnlDollars: 80, calibratedExpectedPnlDollars: 30, pnlVarianceDollars: 150 ** 2, varianceSessions: 14, ...overrides });
}
const coveredCallEntryVariance = 500 ** 2;

const book: PostModelBookInput = {
  netLiquidationValue: 1_000_000, freeCash: 600_000, committedDollars: 50_000, inFlight: { totalNotional: 0, tickerNotional: 0, managedNotional: 0 }, openPositionCount: 2, existingTickerExposure: 20_000, existingSectorExposure: 100_000, freeShares: 0,
  workingOrderOnSymbol: false, lastFilledActionAt: null, nowMs: Date.parse("2026-09-28T16:00:00Z"), spotPrice: 110, sameContractConflict: null,
};

const stress = { forecastVolatility: 0.5, elevatedVolatility: false, dayMoveSigmas: 0.2 };

/** 500 shares acquired for $50,000 with $1,000 of premium: break-even $98, far below the calls' strikes. */
const heldCycle = { breakEvenPerShare: 98, unavailableReason: null, sharesAcquired: 500, acquisitionCost: 50_000 };

const trade: PlutoDecision = { decision: "trade", actionKind: "open_cash_secured_put", candidateId: "HOOD:cash_secured_put:2026-10-16:100", confidence: 0.8, reasons: ["r"], risksAcknowledged: [], systemConcerns: [] };

function input(overrides: Partial<PostModelGateInput> = {}): PostModelGateInput {
  return { decision: trade, candidate: candidate(), roll: null, freshRejectionReasons: [], marginAtDecision: 0.35, settings, book, sector: "Financial", stress, ...overrides };
}

function failed(output: ReturnType<typeof runPostModelGates>): string[] {
  return output.gates.filter((gate) => !gate.ok).map((gate) => gate.gate);
}

describe("runPostModelGates — a clean cash-secured put", () => {
  it("passes every gate and sizes to the standard order size", () => {
    const output = runPostModelGates(input());
    expect(failed(output)).toEqual([]);
    // order size 1M × 50% × 10% = 50k; budget room 450k, ticker room 80k, cash room 550k → 50k / ((100 − 2.05) × 100) = 5; volume share 60 → 5
    expect(output.plan).toEqual({ quantity: 5, limitPrice: 2.05, notional: 48_975, fullSizeQuantity: 5 });
  });
  it("the order size is NLV × capital budget % × order size %", () => {
    expect(computeSizingRoom(settings, book, false).orderCap).toBe(50_000);
    expect(computeSizingRoom({ ...settings, capitalBudgetPct: 30, orderSizePctOfBudget: 20 }, book, false).orderCap).toBe(60_000);
    expect(computeSizingRoom(settings, { ...book, netLiquidationValue: 1_100_000 }, false).orderCap).toBe(55_000);
  });
  it("the ticker and sector caps are shares of the capital budget, not of the account", () => {
    // 1M × 50% budget = 500k; ticker 20% of it = 100k − 20k on the ticker = 80k; sector 30% of it = 150k − 100k in the sector = 50k
    const room = computeSizingRoom({ ...settings, maxSectorPctOfBudget: 30 }, book, true);
    expect(room.tickerRoom).toBe(80_000);
    expect(room.sectorRoom).toBe(50_000);
    // A smaller budget shrinks both: 1M × 40% = 400k → ticker 80k − 20k = 60k, sector 120k − 100k = 20k
    const smaller = computeSizingRoom({ ...settings, capitalBudgetPct: 40, maxSectorPctOfBudget: 30 }, book, true);
    expect(smaller.tickerRoom).toBe(60_000);
    expect(smaller.sectorRoom).toBe(20_000);
  });
  it("a tighter limit than the order size wins, and contracts round down", () => {
    // cash room 64k − 50k reserve = 14k → 1 contract
    expect(runPostModelGates(input({ book: { ...book, freeCash: 64_000 } })).plan?.quantity).toBe(1);
    // a $600 strike costs 60k a contract: more than the 50k order size → nothing
    expect(failed(runPostModelGates(input({ candidate: candidate({ strike: 600 }) })))).toEqual(["sizing"]);
  });
  it("the volume share caps the quantity", () => {
    expect(runPostModelGates(input({ candidate: candidate({ volume: 20 }) })).plan?.quantity).toBe(4);
    expect(runPostModelGates(input({ candidate: candidate({ volume: 20 }) })).gates.find((gate) => gate.gate === "sizing")?.detail).toBe("order size $50,000, budget left $450,000, ticker room $80,000, cash room $550,000 → 5 contract(s) at $9,795 each; volume share allows 4; stress cap off; Kelly cap: 0.5 × $500,000 budget × Edge $80/contract ÷ P&L variance → 888 contract(s) → $39,180");
    expect(failed(runPostModelGates(input({ candidate: candidate({ volume: 3 }) })))).toEqual(["sizing"]);
  });
});

describe("runPostModelGates — the gates", () => {
  it("refuses a non-trade verdict, low confidence, a stale candidate and edge drift", () => {
    expect(failed(runPostModelGates(input({ decision: { ...trade, decision: "no_trade" } })))).toContain("verdict");
    expect(failed(runPostModelGates(input({ decision: { ...trade, confidence: 0.5 } })))).toEqual(["confidence_floor"]);
    expect(failed(runPostModelGates(input({ freshRejectionReasons: ["spread 22% above 15%"] })))).toEqual(["candidate_fresh"]);
  });
  it("measures drift as the edge margin's move in points, either way, against maxEdgeMarginDriftPts (10)", () => {
    // Decided at 46% or 24%, now 35%: 11 points → out. At 44% or 26%: 9 points → fine.
    for (const marginAtDecision of [0.46, 0.24]) expect(failed(runPostModelGates(input({ marginAtDecision })))).toEqual(["edge_drift"]);
    for (const marginAtDecision of [0.44, 0.26]) expect(failed(runPostModelGates(input({ marginAtDecision })))).toEqual([]);
    expect(runPostModelGates(input({ marginAtDecision: 0.24 })).gates.find((gate) => gate.gate === "edge_drift")?.detail).toBe("edge margin moved 11.0 points since the decision, max 10");
    expect(failed(runPostModelGates(input({ marginAtDecision: 0.3, settings: { ...settings, maxEdgeMarginDriftPts: 4 } })))).toEqual(["edge_drift"]);
    // The plain mid-price yield moving does not matter: drift is the model's margin only.
    expect(failed(runPostModelGates(input({ candidate: candidate({ annualizedYield: 0.01 }) })))).toEqual([]);
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
    const capped = runPostModelGates(input({ settings: { ...settings, maxSectorPctOfBudget: 22 } }));
    // sector room 1M × 50% budget × 22% = 110k − 100k = 10k → 1 contract
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
  it("a covered call the model chose is a Covered Call entry sized like a put; an odd lot of free shares covers nothing", () => {
    const call = candidate({ strategyKey: "covered_call", strike: 130, delta: 0.22, model: model({ coveredPositionPnlVarianceDollars: coveredCallEntryVariance }) });
    const decision: PlutoDecision = { ...trade, actionKind: "open_covered_call", candidateId: "HOOD:covered_call:2026-10-16:130" };
    // order size 50k / ((110 − 2.05) × 100) = 4
    expect(runPostModelGates(input({ decision, candidate: call })).plan).toEqual({ quantity: 4, limitPrice: 2.05, notional: 43_180, fullSizeQuantity: 4 });
    // an odd lot covers nothing: no room and no round lot → nothing
    const none = runPostModelGates(input({ decision, candidate: call, book: { ...book, freeShares: 80, freeCash: 40_000 } }));
    expect(failed(none)).toEqual(["sizing"]);
  });
  it("the open-positions cap refuses a Covered Call entry or a put at the cap", () => {
    const call = candidate({ strategyKey: "covered_call", strike: 130, delta: 0.22, model: model({ coveredPositionPnlVarianceDollars: coveredCallEntryVariance }) });
    const decision: PlutoDecision = { ...trade, actionKind: "open_covered_call", candidateId: "HOOD:covered_call:2026-10-16:130" };
    const atCap = { ...book, openPositionCount: 8 };
    expect(failed(runPostModelGates(input({ decision, candidate: call, book: atCap })))).toContain("open_positions_cap");
    expect(failed(runPostModelGates(input({ book: atCap })))).toEqual(["open_positions_cap"]);
  });
  it("a roll keeps the held quantity and only counts a rise in exposure (strike increase less net credit) as notional", () => {
    const roll: RollSignalCandidate = { legId: "leg1", positionId: "p1", strategyKey: "cash_secured_put", quantity: 3, replacement: candidate({ strike: 95 }), netCreditPerShare: 0.4, deltaChange: -0.02, dollarRiskChange: -500, flags: [], warnings: [], model: fixtureRollModel({ edgeMargin: 0.25, netExpectedPnlPerContract: 40, netExpectedPnl: 120 }) };
    const decision: PlutoDecision = { ...trade, actionKind: "roll", candidateId: "HOOD:roll:leg1:2026-10-16:95" };
    const output = runPostModelGates(input({ decision, candidate: null, roll, marginAtDecision: 0.25 }));
    expect(failed(output)).toEqual([]);
    expect(output.plan).toEqual({ quantity: 3, limitPrice: 2.05, notional: 0, fullSizeQuantity: 3 });
    const up = runPostModelGates(input({ decision, candidate: null, roll: { ...roll, dollarRiskChange: 500 }, marginAtDecision: 0.25 }));
    expect(up.plan?.notional).toBe(1500);
    // A roll's drift is the roll's own margin, not the replacement's (35%).
    expect(failed(runPostModelGates(input({ decision, candidate: null, roll, marginAtDecision: 0.36 })))).toEqual(["edge_drift"]);
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

describe("stress cap (Marcelo, 2026-10-08; on the model's τ since 2026-10-10)", () => {
  const on = { ...settings, stressRiskBudgetPct: 1, stressSigmas: 2 };
  // SMCI on 2026-10-07: spot 44.02, forecast 76.1%, $46 call 2026-10-09 at 0.37/0.40, two sessions of variance to the close.
  const smciCall = { strategyKey: "covered_call" as const, strike: 46, expiry: "2026-10-09", bid: 0.37, ask: 0.4, model: model({ varianceSessions: 2 }) };
  const smciDay = { forecastVolatility: 0.761, elevatedVolatility: false, dayMoveSigmas: 0.31 };
  it("sizes a Covered Call entry from a 2σ move to expiry: σ_T 6.78%, stressed spot 38.05, loss $558/contract, 18 contracts within $10,383", () => {
    const cap = computeStressCap(on, smciDay, smciCall, 44.02, 1_038_326);
    expect(cap.contracts).toBe(18);
    expect(cap.detail).toBe("stress cap: a 2σ move to expiry (−13.6% over 2.00 sessions of variance) loses $558/contract → 18 within $10,383 (1% of account)");
  });
  it("a cash-secured put loses only below its strike: far out of the money, the cap does not bind", () => {
    const farPut = { strategyKey: "cash_secured_put" as const, strike: 30, expiry: "2026-10-09", bid: 0.01, ask: 0.02, model: model({ varianceSessions: 2 }) };
    expect(computeStressCap(on, smciDay, farPut, 44.02, 1_000_000).contracts).toBe(Number.POSITIVE_INFINITY);
    const nearPut = { strategyKey: "cash_secured_put" as const, strike: 43, expiry: "2026-10-09", bid: 0.56, ask: 0.61, model: model({ varianceSessions: 2 }) };
    // stressed spot 44.02 × (1 − 0.1356) = 38.05 → (43 − 38.05) × 100 − 58.5 = $436 → floor(10,000 / 436) = 22
    expect(computeStressCap(on, smciDay, nearPut, 44.02, 1_000_000).contracts).toBe(22);
  });
  it("uses the contract's own variance time: Wednesday 11:00 ET leaves 0.193 of the day + 2 sessions, a wider move than 2 flat sessions", () => {
    const fromWednesdayMorning = computeStressCap(on, smciDay, { ...smciCall, model: model({ varianceSessions: 2.193 }) }, 44.02, 1_038_326);
    // σ_T = 76.1% × √(2.193 / 252) = 7.10% → 2σ = 14.2%, stressed 37.77 → $586/contract → 17
    expect(fromWednesdayMorning.contracts).toBe(17);
    expect(fromWednesdayMorning.detail).toContain("over 2.19 sessions of variance");
  });
  it("adds 0.5σ for an elevated-volatility stretch and 0.5σ on a day down more than one normal day", () => {
    expect(computeStressCap(on, { ...smciDay, elevatedVolatility: true }, smciCall, 44.02, 1_038_326).detail).toContain("a 2.5σ (elevated volatility) move");
    expect(computeStressCap(on, { ...smciDay, dayMoveSigmas: -1 }, smciCall, 44.02, 1_038_326).detail).toContain("a 2.5σ (down more than a normal day) move");
    expect(computeStressCap(on, { ...smciDay, dayMoveSigmas: 1.8 }, smciCall, 44.02, 1_038_326).detail).toContain("a 2σ move");
    expect(computeStressCap(on, { ...smciDay, elevatedVolatility: true, dayMoveSigmas: -2 }, smciCall, 44.02, 1_038_326).contracts).toBeLessThan(18);
  });
  it("a longer expiry carries a bigger tail and gets fewer contracts: 22 sessions, a 45% move, $1,941/contract → 5", () => {
    const thirtyDays = { ...smciCall, strike: 50, expiry: "2026-11-06", model: model({ varianceSessions: 22 }) };
    expect(computeStressCap(on, smciDay, thirtyDays, 44.02, 1_038_326).contracts).toBe(5);
  });
  it("0 turns it off; no forecast, no model valuation or no live spot refuses the order (fail closed)", () => {
    expect(computeStressCap({ ...on, stressRiskBudgetPct: 0 }, smciDay, smciCall, 44.02, 1_000_000)).toEqual({ contracts: Number.POSITIVE_INFINITY, detail: "stress cap off" });
    expect(computeStressCap(on, { ...smciDay, forecastVolatility: null }, smciCall, 44.02, 1_000_000).contracts).toBe(0);
    expect(computeStressCap(on, smciDay, { ...smciCall, model: null }, 44.02, 1_000_000).contracts).toBe(0);
    expect(computeStressCap(on, smciDay, smciCall, null, 1_000_000).contracts).toBe(0);
  });
  it("caps the put's quantity in the sizing gate, and says so", () => {
    // put $100, 2.05 mid, spot 110, forecast 50%, 14 sessions of variance: σ_T 11.8%, stressed 84.07 → loss $1,388 → 7 at 1%, 3 at 0.5%
    expect(runPostModelGates(input({ settings: { ...on, stressRiskBudgetPct: 0.5 } })).plan?.quantity).toBe(3);
    expect(runPostModelGates(input({ settings: { ...on, stressRiskBudgetPct: 0.5 } })).gates.find((gate) => gate.gate === "sizing")?.detail).toContain("stress cap: a 2σ move to expiry");
    expect(runPostModelGates(input({ settings: on })).plan?.quantity).toBe(5); // the 5-contract order size binds first
  });
  it("caps a Covered Call entry's contracts: they buy shares", () => {
    const callTrade = { ...trade, actionKind: "open_covered_call" as const, candidateId: "HOOD:covered_call:2026-10-16:120" };
    const call = candidate({ strategyKey: "covered_call", strike: 120, delta: 0.25, bid: 1.5, ask: 1.6, volume: 1000, model: model({ coveredPositionPnlVarianceDollars: coveredCallEntryVariance }) });
    const capped = { ...on, stressRiskBudgetPct: 0.2 }; // $2,000: a Covered Call entry's 2σ loss (~$2,440 here) allows none
    expect(runPostModelGates(input({ decision: callTrade, candidate: call, settings: capped, book: { ...book, freeShares: 0 } })).plan).toBeNull();
  });
});

describe("half-Kelly cap on Edge $ (model review P5, 2026-10-10; half-Kelly on Edge $ since 2026-10-12)", () => {
  // Budget = $1M × 50% = $500,000.
  it("allows floor(0.5 × budget × Edge $ ÷ P&L variance) contracts, whatever Hist Edge says; a put on the option's variance", () => {
    expect(kellyFraction).toBe(0.5);
    const cap = computeKellyCap(settings, { strategyKey: "cash_secured_put", model: model({ expectedPnlDollars: 30, calibratedExpectedPnlDollars: -5, pnlVarianceDollars: 150 ** 2 }) }, 1_000_000);
    expect(cap.contracts).toBe(333); // 0.5 × 500,000 × 30 ÷ 22,500 = 333.3
    expect(cap.detail).toBe("Kelly cap: 0.5 × $500,000 budget × Edge $30/contract ÷ P&L variance → 333 contract(s)");
    // The approved example: AAPL $330 Put · 14 Oct on staging 2026-10-09, 0.5 × $519,698 × $43 ÷ $402² = 69.1
    expect(computeKellyCap({ ...settings, capitalBudgetPct: 50 }, { strategyKey: "cash_secured_put", model: model({ expectedPnlDollars: 43, pnlVarianceDollars: 402 ** 2 }) }, 1_039_395).contracts).toBe(69);
  });
  it("sizes every covered call on the shares + call variance, whether the shares are held or bought with it", () => {
    const cap = computeKellyCap(settings, { strategyKey: "covered_call", model: model({ expectedPnlDollars: 30, pnlVarianceDollars: 150 ** 2, coveredPositionPnlVarianceDollars: 500 ** 2 }) }, 1_000_000);
    expect(cap.contracts).toBe(30); // 0.5 × 500,000 × 30 ÷ 250,000
    expect(cap.detail).toContain("P&L variance (shares + call) → 30 contract(s)");
  });
  it("allows nothing when the model expects no profit (Edge $ ≤ 0) or there is no valuation", () => {
    expect(computeKellyCap(settings, { strategyKey: "cash_secured_put", model: model({ expectedPnlDollars: -2, calibratedExpectedPnlDollars: 10 }) }, 1_000_000)).toEqual({ contracts: 0, detail: "Kelly cap: Edge −$2/contract ≤ 0, so no contracts" });
    expect(computeKellyCap(settings, { strategyKey: "cash_secured_put", model: null }, 1_000_000).contracts).toBe(0);
  });
  it("binds in the sizing gate when tighter than the order size, and refuses when it allows none", () => {
    // 0.5 × 500,000 × 0.25 ÷ 22,500 = 2.8 → 2 of the 5 the order size allows
    const tight = runPostModelGates(input({ candidate: candidate({ model: model({ expectedPnlDollars: 0.25 }) }) }));
    expect(tight.plan?.quantity).toBe(2);
    expect(tight.gates.find((gate) => gate.gate === "sizing")?.detail).toContain("→ 2 contract(s)");
    expect(failed(runPostModelGates(input({ candidate: candidate({ model: model({ expectedPnlDollars: 0 }) }) })))).toEqual(["sizing"]);
  });
  it("caps a Covered Call entry's contracts on shares + call", () => {
    const decision: PlutoDecision = { ...trade, actionKind: "open_covered_call", candidateId: "HOOD:covered_call:2026-10-16:130" };
    // shares + call Kelly: 0.5 × 500,000 × 2.5 ÷ 250,000 = 2.5 → 2
    const call = candidate({ strategyKey: "covered_call", strike: 130, delta: 0.22, model: model({ expectedPnlDollars: 2.5, coveredPositionPnlVarianceDollars: coveredCallEntryVariance }) });
    // a Covered Call entry: the order size allows 4, the cap 2
    expect(runPostModelGates(input({ decision, candidate: call })).plan).toEqual({ quantity: 2, limitPrice: 2.05, notional: 21_590, fullSizeQuantity: 2 });
  });
});

describe("runHeldShareCallGates — a call code sells on held shares", () => {
  const callAt = (strike: number, bid: number, ask: number, overrides: Partial<SignalCandidate> = {}) => candidate({ strategyKey: "covered_call", strike, bid, ask, delta: 0.25, volume: 0, openInterest: 0, ...overrides });
  // 100 shares assigned at $40 with $1.00 of put premium: break-even $39.00, floor max(1% × $40 × 100, $50) = $50
  const assigned = { breakEvenPerShare: 39, unavailableReason: null, sharesAcquired: 100, acquisitionCost: 4000 };
  const heldBook = { freeShares: 100, workingOrderOnSymbol: false, lastFilledActionAt: null, nowMs: book.nowMs, sameContractConflict: null };
  const heldInput = (overrides: Partial<HeldShareCallGateInput> = {}): HeldShareCallGateInput => ({ candidate: callAt(39, 0.5, 0.6), settings, book: heldBook, cycleBreakEven: assigned, ...overrides });

  it("covers every free round lot at the mid, buys no shares and has no volume, budget, Kelly or positions cap", () => {
    const output = runHeldShareCallGates(heldInput({ book: { ...heldBook, freeShares: 350 }, cycleBreakEven: heldCycle, candidate: callAt(130, 2.0, 2.1) }));
    expect(failed(output)).toEqual([]);
    expect(output.plan).toEqual({ quantity: 3, limitPrice: 2.05, notional: 0, fullSizeQuantity: 3 });
    expect(output.gates.map((gate) => gate.gate)).toEqual(["live_quote", "working_order", "ticker_cooldown", "same_contract", "sizing", "break_even", "limit_price"]);
    expect(output.gates.find((gate) => gate.gate === "sizing")?.detail).toBe("350 free shares cover 3 contract(s), no shares bought");
  });
  it("re-checks the break-even rule at the size sent and the limit price", () => {
    // $39 at 0.55 mid: 39 − (0.55 − 0.0068) = 38.4568 → $54.32 if assigned
    const passes = runHeldShareCallGates(heldInput());
    expect(failed(passes)).toEqual([]);
    expect(passes.gates.find((gate) => gate.gate === "break_even")?.detail).toBe("strike at or above the cycle break-even of 39.00; if assigned, 100 shares close $54 over the break-even of 38.46 after this premium, minimum $50");
    // $38.90 at 1.20: $109.32 with the premium counted, but the strike is under the $39.00 break-even before it
    const underStrike = runHeldShareCallGates(heldInput({ candidate: callAt(38.9, 1.15, 1.25) }));
    expect(underStrike.gates.find((gate) => gate.gate === "break_even")).toEqual({ gate: "break_even", ok: false, detail: "the $38.9 strike is below the cycle break-even of 39.00 before this premium" });
    // $38.50 at 0.60: $9.32
    const blocked = runHeldShareCallGates(heldInput({ candidate: callAt(38.5, 0.55, 0.65) }));
    expect(failed(blocked)).toEqual(["break_even"]);
    expect(blocked.gates.find((gate) => gate.gate === "break_even")?.detail).toBe("if assigned, the $38.5 strike closes 100 shares $9 over the cycle break-even of 38.41 (after this premium), below the $50 minimum profit");
    const unknown = runHeldShareCallGates(heldInput({ cycleBreakEven: { ...assigned, breakEvenPerShare: null, unavailableReason: "no expiry-date price bar for put $40 (2026-10-09)" } }));
    expect(unknown.gates.find((gate) => gate.gate === "break_even")).toEqual({ gate: "break_even", ok: false, detail: "no cycle break-even for the held shares: no expiry-date price bar for put $40 (2026-10-09)" });
    expect(failed(runHeldShareCallGates(heldInput({ cycleBreakEven: null })))).toEqual(["break_even"]);
  });
  it("refuses a quote that is not live, a working order, the ticker cooldown, a taken contract and an odd lot", () => {
    expect(failed(runHeldShareCallGates(heldInput({ candidate: callAt(39, 0.5, 0.6, { quoteSource: "day" }) })))).toEqual(["live_quote"]);
    expect(failed(runHeldShareCallGates(heldInput({ book: { ...heldBook, workingOrderOnSymbol: true } })))).toEqual(["working_order"]);
    expect(failed(runHeldShareCallGates(heldInput({ book: { ...heldBook, lastFilledActionAt: new Date(book.nowMs - 10 * 60_000) } })))).toEqual(["ticker_cooldown"]);
    expect(failed(runHeldShareCallGates(heldInput({ book: { ...heldBook, sameContractConflict: "open position on SMCI $39 Call" } })))).toEqual(["same_contract"]);
    expect(failed(runHeldShareCallGates(heldInput({ book: { ...heldBook, freeShares: 80 } })))).toContain("sizing");
  });
  it("refuses when no call is left on fresh quotes", () => {
    expect(runHeldShareCallGates(heldInput({ candidate: null }))).toEqual({ ok: false, gates: [{ gate: "candidate_present", ok: false, detail: "no call on the held shares passes every rule on fresh quotes" }], plan: null });
  });
});
