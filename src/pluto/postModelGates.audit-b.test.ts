import { describe, expect, it } from "vitest";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { PlutoDecision } from "./decisionSchema.js";
import { computeSizingRoom, runPostModelGates, type PostModelBookInput, type PostModelGateInput } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { openDaysFromCalendarRows } from "../lib/marketSessionStatus.js";

// Audit B (2026-10-07): the budget nets the managed book's in-flight orders (managedNotional), the positions cap counts managed positions.
const settings = {
  capitalBudgetPct: 50, maxTickerExposurePct: 10, maxSectorExposurePct: 100, maxOpenPositions: 8, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
  minGrade: "good", minEdgeDollars: 30, maxAbsDelta: 0.3, minDte: 2, maxDte: 45, minAnnualizedYieldPct: 50, maxSpreadPct: 15, minOpenInterest: 500, minSessionVolume: 50, maxQuoteAgeMinutes: 10, maxContractsVolumeSharePct: 20,
  maxSliceRmseVp: 2, minSlicePointCount: 10, maxMidVsSurfaceIvVp: 5, maxIvShiftVp: 8, maxDayMoveMultiple: 3, stressRiskBudgetPct: 0, stressSigmas: 2,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2, spyStressBreakerPct: 3, maxEdgeDriftVp: 1, tickerCooldownMinutes: 60, maxFillSlippagePct: 25,
  modelId: "m", reasoningEffort: "medium", callTimeoutSeconds: 90, dailyCostCeilingUsd: 3, confidenceFloor: 0.6, consecutiveModelFailuresBreaker: 3, promptVersion: "v3.5",
  daySignalsPollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, perTickerModelCooldownMinutes: 5, maxEnabledTickers: 15, messageRateLimitPerSecond: 8, crashLoopRestartsPerHour: 3, telegramVerbosity: "actions",
  unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50, buybackMinDte: 2, updatedAt: "2026-10-07T00:00:00.000Z", updatedByUserId: null,
} as PlutoSettings;

const book: PostModelBookInput = {
  netLiquidationValue: 1_000_000, freeCash: 600_000, committedDollars: 50_000, inFlight: { totalNotional: 0, tickerNotional: 0, managedNotional: 0 }, openPositionCount: 2, existingTickerExposure: 20_000, existingSectorExposure: 100_000, freeShares: 0,
  workingOrderOnSymbol: false, lastFilledActionAt: null, nowMs: Date.parse("2026-10-07T16:00:00Z"), spotPrice: 110, sameContractConflict: null,
};

const candidate = {
  strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 100, dte: 9, delta: -0.22, bid: 2.0, ask: 2.1, spreadPercent: 4.9, openInterest: 1200, volume: 300, bidSize: 40, askSize: 35,
  surfaceImpliedVolatility: 0.62, midImpliedVolatility: 0.61, forecastVolatility: 0.5, edge: 0.12, frictionVolatility: 0.02, netEdge: 0.1, edgeDollars: 80, vega: 0.08,
  dollarRisk: 9795, riskAdjustedRatio: 0.008, annualizedYield: 0.83, uncompensatedSharePercent: null, quoteSource: "live", quotedAt: null, flags: [], executable: true, grade: "strong",
} as SignalCandidate;

const trade: PlutoDecision = { decision: "trade", actionKind: "open_cash_secured_put", candidateId: "HOOD:cash_secured_put:2026-10-16:100", confidence: 0.8, reasons: ["r"], risksAcknowledged: [], systemConcerns: [] };
const input = (overrides: Partial<PostModelGateInput> = {}): PostModelGateInput => ({ decision: trade, candidate, roll: null, freshRejectionReasons: [], netEdgeAtDecision: 0.1, settings, book, sector: "Financial", stress: { forecastVolatility: 0.5, elevatedVolatility: false, dayMoveSigmas: 0, todayEasternIso: "2026-09-28", openSessionDatesIso: openDaysFromCalendarRows("2026-09-29", "2027-12-31", []) }, ...overrides });

describe("computeSizingRoom — managedNotional", () => {
  it("budget room = NLV × budget % − committed − the managed book's in-flight notional; total and ticker notionals do not touch it", () => {
    expect(computeSizingRoom(settings, { ...book, inFlight: { totalNotional: 900_000, tickerNotional: 30_000, managedNotional: 120_000 } }, true).budgetRoom).toBe(500_000 - 50_000 - 120_000);
    expect(computeSizingRoom(settings, { ...book, inFlight: { totalNotional: 900_000, tickerNotional: 0, managedNotional: 0 } }, true).budgetRoom).toBe(450_000);
  });

  it("a budget fully taken by in-flight managed orders blocks the order", () => {
    const output = runPostModelGates(input({ book: { ...book, inFlight: { totalNotional: 450_000, tickerNotional: 0, managedNotional: 450_000 } } }));
    expect(output.ok).toBe(false);
  });
});

describe("runPostModelGates — open positions cap wording", () => {
  it("reads as managed positions, and a roll is exempt", () => {
    const full = runPostModelGates(input({ book: { ...book, openPositionCount: 8 } }));
    const gate = full.gates.find((entry) => entry.gate === "open_positions_cap");
    expect(gate).toEqual({ gate: "open_positions_cap", ok: false, detail: "8 of 8 managed positions" });
  });

  // The flagged_ticker check lives in passRunner, not here: runPostModelGates passes a decision that flags its own ticker.
  it("does not itself refuse a trade on a ticker the same decision flagged", () => {
    const flagged = { ...trade, systemConcerns: [{ symbol: "HOOD", concern: "surface far from market" }] };
    expect(runPostModelGates(input({ decision: flagged })).gates.some((entry) => entry.gate === "flagged_ticker")).toBe(false);
  });
});
