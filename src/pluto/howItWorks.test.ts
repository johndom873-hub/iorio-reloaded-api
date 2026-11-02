import { describe, expect, it } from "vitest";
import { buildPlutoHowItWorks } from "./howItWorks.js";
import { plutoSafetyLimitsSettingsFixture, plutoVolFarmerV4SettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";

// The "How it works" tab quotes these numbers to its readers. This test pins every one at today's defaults: when a
// setting's default or a code constant changes, it fails here, and the tab's wording must be checked for the new value
// before the expectation is updated (CLAUDE.md, "Pluto's How it works tab").

/** Pluto's settings at their migration defaults. */
const settings: PlutoSettings = {
  ...plutoSafetyLimitsSettingsFixture,
  ...plutoVolFarmerV4SettingsFixture,
  capitalBudgetPct: 50, excessAllowancePct: 20,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2,
  maxQuoteAgeMinutes: 10, maxFillSlippagePct: 5,
  bandQuotePollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, maxEnabledTickers: 15,
  crashLoopRestartsPerHour: 3, telegramVerbosity: "actions",
  updatedAt: "2026-10-15T00:00:00.000Z", updatedByUserId: null,
};
const figures = { unfilledOrderCancelMinutes: 15 };

describe("buildPlutoHowItWorks", () => {
  it("quotes every number the tab shows, at today's defaults and constants", () => {
    const { volFarmerV4: _volFarmerV4, ...rest } = buildPlutoHowItWorks(settings, figures);
    expect(rest).toEqual({ shared: { windowStartEt: "10:45", windowEndEt: "15:30", windowEndMinutesBeforeCloseAtLeast: 30, capitalBudgetPct: 50, excessAllowancePct: 20, dailyLossBreakerPct: 2, unfilledOrderCancelMinutes: 15, premiumYieldSessionsPerYear: 252 },
      safetyLimits: { maxWorkingOrdersPerTicker: 10, maxOrdersPerTickerPerDay: 30, maxOpenPositionsPerTicker: 30, maxOpenPositions: 120, maxOrdersPerDay: 100, spyStressBreakerPct: 5, tickerCooldownMinutes: 0 },
    });
  });

  it("quotes Vol Farmer v4's settings and works its example with the strategy's own functions", () => {
    const { example, ...values } = buildPlutoHowItWorks(settings, figures).volFarmerV4;
    expect(values).toEqual({
      callMinAbsDelta: 0.05, callMaxAbsDelta: 0.5, maxSpreadPctOfMid: 50, minimumBid: 0.05, maxVolumeSharePct: 20, firstPositionPct: 80,
      putsStartCallYieldPct: 5, putMaxAbsDelta: 0.3, stepRule: "implied_move_at_put_sale", stepBelowFirstBreakEvenPct: 15,
      leapsMinDte: 180, leapsAbsDelta: 0.6, leapsMaxAllocationPct: 10,
      rebalanceBandPct: 5, rebalances: "both_positions", firstPositionAfterCalledAway: "wait", optionsExpiry: "today", optionsMaxDaysToExpiry: 45,
      callStrikeFloor: "none", putsSold: "calls_yield_little", putStrikeCap: "first_break_even_less_step", trimsSell: "higher_break_even_first",
      topUpCapPct: 0,
    });
    // Pot 240,000; 80% = 192,000: floor(192,000 ÷ 10,000.50) = 19 lots. The band ± 5% of the pot, 12,000. At $90 the lots are
    // worth 171,000, under 180,000: topped up to floor(192,000 ÷ 9,000.50) = 21; at $110, 209,000 over 204,000: trimmed to
    // floor(192,000 ÷ 11,000.50) = 17. Step 60% × √(21 ÷ 252) = 17.32%, so the Puts are struck at most 96 × (1 − 17.32%) =
    // 79.37. The LEAPS is bought half a Step, 8.66%, below B-E2 and spends at most 10% of the 240,000. No top-up cap (0): both
    // lots are bought, 19 × 10,000.50 + 2 × 9,000.50 = 208,010.50 in.
    expect(example).toMatchObject({
      accountValue: 2_000_000, allocationPct: 20, pot: 240_000, stockPrice: 100, lots: 19, targetDollars: 192_000, bandDollars: 12_000,
      fallPrice: 90, valueAfterFall: 171_000, lotsAfterFallTopUp: 21, topUpCapDollars: null, moneyInAfterFallTopUp: 208_010.5, risePrice: 110, valueAfterRise: 209_000, lotsAfterRiseTrim: 17,
      firstBreakEven: 96, impliedVolatilityPct: 60, leapsCap: 24_000,
    });
    expect(example.stepPct).toBeCloseTo(17.3205, 4);
    expect(example.putStrikeCap).toBeCloseTo(79.3723, 4);
    expect(example.leapsEntryBelowSecondBreakEvenPct).toBeCloseTo(8.6603, 4);
    // The fixed Step rule quotes the fixed Step.
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4StepRule: "fixed" }, figures).volFarmerV4.example).toMatchObject({ stepPct: 15, putStrikeCap: 81.6, leapsEntryBelowSecondBreakEvenPct: 7.5 });
  });

  it("sizes Vol Farmer v4's first position with the First position share of the pot, and its rebalancing with the band", () => {
    // Pot 240,000 × 70% = 168,000: floor(168,000 ÷ 10,000.50) = 16 lots.
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4FirstPositionPct: 70 }, figures).volFarmerV4).toMatchObject({ firstPositionPct: 70, example: { pot: 240_000, lots: 16 } });
    // A 15% band (36,000): $90's 171,000 and $110's 209,000 stay inside 192,000 ± 36,000, so neither trades.
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4RebalanceBandPct: 15 }, figures).volFarmerV4.example).toMatchObject({ bandDollars: 36_000, lotsAfterFallTopUp: 19, lotsAfterRiseTrim: 19 });
    // An 80% cap (192,000): the 190,009.50 in leaves 1,990.50, no lot at $90; 85%
    // (204,000) leaves 13,990.50, one lot of the two; 100% (240,000) leaves room for both.
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4TopUpCapPct: 80 }, figures).volFarmerV4.example).toMatchObject({ topUpCapDollars: 192_000, lotsAfterFallTopUp: 19, moneyInAfterFallTopUp: 190_009.5 });
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4TopUpCapPct: 85 }, figures).volFarmerV4.example).toMatchObject({ topUpCapDollars: 204_000, lotsAfterFallTopUp: 20, moneyInAfterFallTopUp: 199_010 });
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4TopUpCapPct: 100 }, figures).volFarmerV4.example).toMatchObject({ topUpCapDollars: 240_000, lotsAfterFallTopUp: 21, moneyInAfterFallTopUp: 208_010.5 });
  });

  it("raises the example's pot by the excess allowance", () => {
    const values = buildPlutoHowItWorks({ ...settings, excessAllowancePct: 0 }, figures);
    // Without it, the pot is the allocation alone, 2,000,000 × 20% × 50% = 200,000: floor(160,000 ÷ 10,000.50) = 15 lots; the LEAPS cap 10% of 200,000.
    expect(values.shared.excessAllowancePct).toBe(0);
    expect(values.volFarmerV4.example).toMatchObject({ pot: 200_000, lots: 15, leapsCap: 20_000 });
  });
});
