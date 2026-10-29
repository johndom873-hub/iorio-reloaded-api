import { describe, expect, it } from "vitest";
import { buildPlutoHowItWorks } from "./howItWorks.js";
import { plutoLadderSettingsFixture, plutoVolFarmerV2SettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";

// The "How it works" tab quotes these numbers to its readers. This test pins every one at today's defaults: when a
// setting's default or a code constant changes, it fails here, and the tab's wording must be checked for the new value
// before the expectation is updated (CLAUDE.md, "Pluto's How it works tab").

/** Pluto's settings at their migration defaults. */
const settings: PlutoSettings = {
  ...plutoLadderSettingsFixture,
  ...plutoVolFarmerV2SettingsFixture,
  capitalBudgetPct: 50, excessAllowancePct: 0,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2,
  maxQuoteAgeMinutes: 10, maxFillSlippagePct: 5,
  bandQuotePollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, maxEnabledTickers: 15,
  crashLoopRestartsPerHour: 3, telegramVerbosity: "actions",
  updatedAt: "2026-10-15T00:00:00.000Z", updatedByUserId: null,
};
const figures = { unfilledOrderCancelMinutes: 15 };

describe("buildPlutoHowItWorks", () => {
  it("quotes every number the tab shows, at today's defaults and constants", () => {
    const { ladder, volFarmerV2: _volFarmerV2, ...rest } = buildPlutoHowItWorks(settings, figures);
    expect(rest).toEqual({ shared: { windowStartEt: "10:45", windowEndEt: "15:30", windowEndMinutesBeforeCloseAtLeast: 30, capitalBudgetPct: 50, excessAllowancePct: 0, dailyLossBreakerPct: 2, unfilledOrderCancelMinutes: 15, premiumYieldSessionsPerYear: 252 } });
    const { example: ladderExample, ...ladderValues } = ladder;
    expect(ladderValues).toEqual({
      minAbsDelta: 0.05, maxAbsDelta: 0.3, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 50, minimumBid: 0.05, maxVolumeSharePct: 20,
      rungs: 5, sharesPct: 50, shockMinPct: 60, shockMaxPct: 80, shockNoHistoryPct: 90, shockLookbackYears: 10, putOverCallYieldMarginPct: 0, minEntryYieldPct: 20, maxQuoteAgeMinutes: 10,
      maxWorkingOrdersPerTicker: 10, maxOrdersPerTickerPerDay: 30, maxOpenPositionsPerTicker: 30, maxOpenPositions: 120, maxOrdersPerDay: 100, spyStressBreakerPct: 5, tickerCooldownMinutes: 0,
    });
    expect(ladderExample).toMatchObject({ accountValue: 2_000_000, allocationPct: 20, pot: 200_000, sharesBudget: 100_000, reserve: 100_000, rungCollateral: 20_000, averageCost: 104, breakEven: 100, shockPct: 70 });
  });

  it("works the ladder example with the strategy's own strike cap: the last rung sits on the floor", () => {
    const { example } = buildPlutoHowItWorks(settings, figures).ladder;
    // Floor 104 × (1 − 70%) = 31.20; rung n: 100 − (100 − 31.20) × n × 20,000 ÷ 100,000.
    expect(example.floor).toBeCloseTo(31.2, 10);
    expect(example.rungs.map((entry) => entry.rung)).toEqual([1, 2, 3, 4, 5]);
    expect(example.rungs.map((entry) => Math.round(entry.strikeCap * 100) / 100)).toEqual([86.24, 72.48, 58.72, 44.96, 31.2]);
  });

  it("quotes Vol Farmer v2's settings and works its example with the strategy's own functions", () => {
    const { example, ...values } = buildPlutoHowItWorks(settings, figures).volFarmerV2;
    expect(values).toEqual({
      callMinAbsDelta: 0.05, callMaxAbsDelta: 0.3, maxSpreadPctOfMid: 50, minimumBid: 0.05, maxVolumeSharePct: 20,
      putsStartCallYieldPct: 5, putMaxAbsDelta: 0.3, stepRule: "implied_move_at_put_sale", stepBelowFirstBreakEvenPct: 15,
      leapsMinDte: 365, leapsAbsDelta: 0.7, leapsMaxAllocationPct: 10,
    });
    // Pot 2,000,000 × 20% × 50% = 200,000: floor(100,000 ÷ 10,000.50) = 9 lots. Step 60% × √(21 ÷ 252) = 17.32%, so the
    // Puts are struck at most 96 × (1 − 17.32%) = 79.37. The LEAPS is bought half a Step, 8.66%, below B-E2 and spends at
    // most 10% of the 200,000.
    expect(example).toMatchObject({ accountValue: 2_000_000, allocationPct: 20, pot: 200_000, stockPrice: 100, lots: 9, firstBreakEven: 96, impliedVolatilityPct: 60, leapsCap: 20_000 });
    expect(example.stepPct).toBeCloseTo(17.3205, 4);
    expect(example.putStrikeCap).toBeCloseTo(79.3723, 4);
    expect(example.leapsEntryBelowSecondBreakEvenPct).toBeCloseTo(8.6603, 4);
    // The fixed Step rule quotes the fixed Step.
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV2StepRule: "fixed" }, figures).volFarmerV2.example).toMatchObject({ stepPct: 15, putStrikeCap: 81.6, leapsEntryBelowSecondBreakEvenPct: 7.5 });
  });

  it("follows the live settings: the example's pot, rungs and shock move with them", () => {
    const { example } = buildPlutoHowItWorks({ ...settings, capitalBudgetPct: 40, ladderRungs: 4, ladderSharesPct: 30, ladderShockMinPct: 75 }, figures).ladder;
    // Pot 2,000,000 × 20% × 40% = 160,000: 48,000 in shares, 112,000 reserve in 4 rungs of 28,000; shock 70% lifted to 75%.
    expect(example).toMatchObject({ pot: 160_000, sharesBudget: 48_000, reserve: 112_000, rungCollateral: 28_000, shockPct: 75 });
    expect(example.rungs).toHaveLength(4);
    expect(example.rungs[3]!.strikeCap).toBeCloseTo(example.floor, 10);
  });

  it("raises both examples' pots by the excess allowance", () => {
    const values = buildPlutoHowItWorks({ ...settings, excessAllowancePct: 20 }, figures);
    // Pot 2,000,000 × 20% × (1 + 20%) × 50% = 240,000: floor(120,000 ÷ 10,000.50) = 11 lots; the LEAPS cap 10% of 240,000.
    expect(values.shared.excessAllowancePct).toBe(20);
    expect(values.ladder.example).toMatchObject({ pot: 240_000, sharesBudget: 120_000, reserve: 120_000 });
    expect(values.volFarmerV2.example).toMatchObject({ pot: 240_000, lots: 11, leapsCap: 24_000 });
  });
});
