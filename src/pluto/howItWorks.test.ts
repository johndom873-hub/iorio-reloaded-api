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
  capitalBudgetPct: 50, 
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2,
  maxQuoteAgeMinutes: 10, maxFillSlippagePct: 5,
  bandQuotePollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, maxEnabledTickers: 15,
  crashLoopRestartsPerHour: 3, telegramVerbosity: "actions",
  updatedAt: "2026-10-15T00:00:00.000Z", updatedByUserId: null,
};
const figures = { unfilledOrderCancelMinutes: 15 };

describe("buildPlutoHowItWorks", () => {
  it("quotes every number the tab shows, at today's defaults and constants", () => {
    const { ladder, ...rest } = buildPlutoHowItWorks(settings, figures);
    expect(rest).toEqual({ shared: { windowStartEt: "10:45", windowEndEt: "15:30", windowEndMinutesBeforeCloseAtLeast: 30, capitalBudgetPct: 50, dailyLossBreakerPct: 2, unfilledOrderCancelMinutes: 15 } });
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

  it("follows the live settings: the example's pot, rungs and shock move with them", () => {
    const { example } = buildPlutoHowItWorks({ ...settings, capitalBudgetPct: 40, ladderRungs: 4, ladderSharesPct: 30, ladderShockMinPct: 75 }, figures).ladder;
    // Pot 2,000,000 × 20% × 40% = 160,000: 48,000 in shares, 112,000 reserve in 4 rungs of 28,000; shock 70% lifted to 75%.
    expect(example).toMatchObject({ pot: 160_000, sharesBudget: 48_000, reserve: 112_000, rungCollateral: 28_000, shockPct: 75 });
    expect(example.rungs).toHaveLength(4);
    expect(example.rungs[3]!.strikeCap).toBeCloseTo(example.floor, 10);
  });
});
