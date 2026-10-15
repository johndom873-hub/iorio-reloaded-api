import { describe, expect, it } from "vitest";
import { buildPlutoHowItWorks } from "./howItWorks.js";
import { plutoLadderSettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";

// The "How it works" tab quotes these numbers to its readers. This test pins every one at today's defaults: when a
// setting's default or a code constant changes, it fails here, and the tab's wording must be checked for the new value
// before the expectation is updated (CLAUDE.md, "Pluto's How it works tab").

/** Pluto's settings at their migration defaults. */
const settings: PlutoSettings = {
  ...plutoLadderSettingsFixture,
  capitalBudgetPct: 50, maxTickerExposurePct: 10, maxSectorExposurePct: 100, maxOpenPositions: 15, maxActionsPerSession: 10, orderSizePctOfBudget: 10, minCashReservePct: 5,
  minGrade: "good", minEdgeYieldPct: 15, maxAbsDelta: 0.3, minDte: 2, maxDte: 45, minAnnualizedYieldPct: 50, maxSpreadPct: 15, minOpenInterest: 500, minSessionVolume: 50, maxQuoteAgeMinutes: 10, maxContractsVolumeSharePct: 20,
  maxSliceRmseVp: 2, minSlicePointCount: 10, maxMidVsSurfaceIvVp: 5, maxIvShiftVp: 8, maxDayMoveMultiple: 3, stressRiskBudgetPct: 1, stressSigmas: 2,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2, spyStressBreakerPct: 3,
  maxEdgeMarginDriftPts: 10, tickerCooldownMinutes: 60, maxFillSlippagePct: 5,
  modelId: "openai/gpt-6-luna", reasoningEffort: "medium", callTimeoutSeconds: 90, dailyCostCeilingUsd: 1, confidenceFloor: 0.6, consecutiveModelFailuresBreaker: 3, promptVersion: "v4.4",
  daySignalsPollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, perTickerModelCooldownMinutes: 5, maxEnabledTickers: 15, messageRateLimitPerSecond: 8,
  crashLoopRestartsPerHour: 3, telegramVerbosity: "actions",
  unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50, buybackMinDte: 2,
  updatedAt: "2026-10-15T00:00:00.000Z", updatedByUserId: null,
};
const figures = { unfilledOrderCancelMinutes: 15, todayIso: "2026-10-15" };

describe("buildPlutoHowItWorks", () => {
  it("quotes every number the tab shows, at today's defaults and constants", () => {
    const { ladder, edgeMargin, ...rest } = buildPlutoHowItWorks(settings, figures);
    expect(rest).toEqual({ activeStrategy: "edge_margin", shared: { capitalBudgetPct: 50, dailyLossBreakerPct: 2, unfilledOrderCancelMinutes: 15 } });
    const { example: ladderExample, ...ladderValues } = ladder;
    expect(ladderValues).toEqual({
      minAbsDelta: 0.05, maxAbsDelta: 0.3, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 50, minimumBid: 0.05, maxVolumeSharePct: 20,
      rungs: 5, sharesPct: 50, shockMinPct: 60, shockMaxPct: 80, shockNoHistoryPct: 90, shockLookbackYears: 10, putOverCallYieldMarginPct: 0,
      maxWorkingOrdersPerTicker: 5, maxOrdersPerTickerPerDay: 30, maxOpenPositionsPerTicker: 5, spyStressBreakerPct: 5, tickerCooldownMinutes: 0,
    });
    const { example: edgeExample, ...edgeValues } = edgeMargin;
    expect(edgeValues).toEqual({
      windowStartEt: "10:45", windowEndEt: "15:30", windowEndMinutesBeforeCloseAtLeast: 30,
      minGrade: "good", gradeCutsPct: { strong: 20, good: 10, weak: 0 }, minEdgeYieldPct: 15, minAnnualizedYieldPct: 50,
      maxAbsDelta: 0.3, minDte: 2, maxDte: 45, maxSpreadPct: 15, minOpenInterest: 500, minSessionVolume: 50, maxQuoteAgeMinutes: 10, maxDayMoveMultiple: 3,
      burstLines: 10, candidatesPerTickerPerStrategy: 3, confidenceFloor: 0.6, maxEdgeMarginDriftPts: 10,
      orderSizePctOfBudget: 10, maxTickerExposurePct: 10, minCashReservePct: 5, maxContractsVolumeSharePct: 20, stressRiskBudgetPct: 1, stressSigmas: 2, kellyFraction: 0.5, maxOpenPositions: 15,
      spyStressBreakerPct: 3, maxActionsPerSession: 10, tickerCooldownMinutes: 60, consecutiveModelFailuresBreaker: 3, dailyCostCeilingUsd: 1,
      heldShareCallMinProfitPct: 1, heldShareCallMinProfitDollars: 50, buybackMinDte: 2, buybackUnscoredMinKeptPremiumPct: 75, earningsCloseWindowSessions: 5, eventCloseWindowSessions: 5,
    });
    expect(ladderExample).toMatchObject({ accountValue: 2_000_000, allocationPct: 20, pot: 200_000, sharesBudget: 100_000, reserve: 100_000, rungCollateral: 20_000, averageCost: 104, breakEven: 100, shockPct: 70 });
    expect(edgeExample).toMatchObject({ contractLabel: "$45 Put · 22 Oct (7DTE)", strike: 45, daysToExpiry: 7, mid: 1, fair: 0.85, frictionDollars: 2, exposure: 4_400, edgeMarginPct: 15, grade: "good", passesMinEdgeYield: true });
  });

  it("works the ladder example with the strategy's own strike cap: the last rung sits on the floor", () => {
    const { example } = buildPlutoHowItWorks(settings, figures).ladder;
    // Floor 104 × (1 − 70%) = 31.20; rung n: 100 − (100 − 31.20) × n × 20,000 ÷ 100,000.
    expect(example.floor).toBeCloseTo(31.2, 10);
    expect(example.rungs.map((entry) => entry.rung)).toEqual([1, 2, 3, 4, 5]);
    expect(example.rungs.map((entry) => Math.round(entry.strikeCap * 100) / 100)).toEqual([86.24, 72.48, 58.72, 44.96, 31.2]);
  });

  it("works the Edge Margin example with the valuation's own grade and yield", () => {
    const { example } = buildPlutoHowItWorks(settings, figures).edgeMargin;
    // Edge $ (1.00 − 0.85) × 100 − 2 = 13; Edge Yield 13 ÷ 4,400 × 365 ÷ 7 = 15.41% a year.
    expect(example.edgeDollars).toBeCloseTo(13, 10);
    expect(example.edgeYieldPct).toBeCloseTo(15.41, 2);
    expect(buildPlutoHowItWorks({ ...settings, minEdgeYieldPct: 20 }, figures).edgeMargin.example.passesMinEdgeYield).toBe(false);
  });

  it("follows the live settings: the example's pot, rungs and shock move with them", () => {
    const { example } = buildPlutoHowItWorks({ ...settings, capitalBudgetPct: 40, ladderRungs: 4, ladderSharesPct: 30, ladderShockMinPct: 75 }, figures).ladder;
    // Pot 2,000,000 × 20% × 40% = 160,000: 48,000 in shares, 112,000 reserve in 4 rungs of 28,000; shock 70% lifted to 75%.
    expect(example).toMatchObject({ pot: 160_000, sharesBudget: 48_000, reserve: 112_000, rungCollateral: 28_000, shockPct: 75 });
    expect(example.rungs).toHaveLength(4);
    expect(example.rungs[3]!.strikeCap).toBeCloseTo(example.floor, 10);
  });
});
