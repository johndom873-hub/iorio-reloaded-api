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
      callMinAbsDelta: 0.05, callMaxAbsDelta: 0.5, maxSpreadPctOfMid: 50, minimumBid: 0.05, maxVolumeSharePct: 20, callMaxCommissionPctOfPremium: 20, firstPositionPct: 80,
      putsStartCallYieldPct: 5, putMaxAbsDelta: 0.3, stepRule: "implied_move_at_put_sale", stepBelowFirstBreakEvenPct: 15,
      leapsMinDte: 180, leapsAbsDelta: 0.6, leapsMaxAllocationPct: 10,
      rebalanceBandPct: 20, rebalances: "both_positions", firstPositionAfterCalledAway: "wait", optionsExpiry: "today", optionsMaxDaysToExpiry: 45,
      callStrikeFloor: "none", putsSold: "calls_yield_little", putStrikeCap: "first_break_even_less_step", trimsSell: "higher_break_even_first",
      topUpCapPct: 0, callsInTheMoneyAtLastLook: "assigned", buyBackMinutesBeforeWindowEnd: 2, buyBackStartsEt: "15:28", buyBackCancelledAtEt: "15:58",
    });
    // Pot 240,000; 80% = 192,000: floor(192,000 ÷ 10,000.50) = 19 lots. The band ± 20% of the pot, 48,000. At $70 the lots are
    // worth 133,000, under 144,000: topped up to floor(192,000 ÷ 7,000.50) = 27; at $130, 247,000 over 240,000: trimmed to
    // floor(192,000 ÷ 13,000.50) = 14. Step 60% × √(21 ÷ 252) = 17.32%, so the Puts are struck at most 96 × (1 − 17.32%) =
    // 79.37. The LEAPS is bought half a Step, 8.66%, below B-E2 and spends at most 10% of the 240,000. No top-up cap (0): all eight
    // lots are bought, 19 × 10,000.50 + 8 × 7,000.50 = 246,013.50 in. At 15:29 the 19 $100 Calls, the stock at $101, are bought
    // back at the $1.10 mid: 19 × 110 = 2,090, plus 19 × $0.68 = 12.92 commission.
    expect(example).toMatchObject({
      accountValue: 2_000_000, allocationPct: 20, pot: 240_000, stockPrice: 100, lots: 19, targetDollars: 192_000, bandDollars: 48_000,
      fallPrice: 70, valueAfterFall: 133_000, lotsAfterFallTopUp: 27, topUpCapDollars: null, moneyInAfterFallTopUp: 246_013.5, risePrice: 130, valueAfterRise: 247_000, lotsAfterRiseTrim: 14,
      firstBreakEven: 96, impliedVolatilityPct: 60, leapsCap: 24_000,
      buyBackTimeEt: "15:29", buyBackStockPrice: 101, buyBackMid: 1.1, buyBackCostDollars: 2_090, buyBackCommissionDollars: 12.92,
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
    // A 30% band (72,000): $70's 133,000 and $130's 247,000 stay inside 192,000 ± 72,000, so neither trades.
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4RebalanceBandPct: 30 }, figures).volFarmerV4.example).toMatchObject({ bandDollars: 72_000, lotsAfterFallTopUp: 19, lotsAfterRiseTrim: 19 });
    // An 80% cap (192,000): the 190,009.50 in leaves 1,990.50, no lot at $70; 85%
    // (204,000) leaves 13,990.50, one lot of the eight; 100% (240,000) leaves 49,990.50, seven.
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4TopUpCapPct: 80 }, figures).volFarmerV4.example).toMatchObject({ topUpCapDollars: 192_000, lotsAfterFallTopUp: 19, moneyInAfterFallTopUp: 190_009.5 });
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4TopUpCapPct: 85 }, figures).volFarmerV4.example).toMatchObject({ topUpCapDollars: 204_000, lotsAfterFallTopUp: 20, moneyInAfterFallTopUp: 197_010 });
    expect(buildPlutoHowItWorks({ ...settings, volFarmerV4TopUpCapPct: 100 }, figures).volFarmerV4.example).toMatchObject({ topUpCapDollars: 240_000, lotsAfterFallTopUp: 26, moneyInAfterFallTopUp: 239_013 });
  });

  it("times the buyback from the window's end, and quotes the setting as it is", () => {
    const values = buildPlutoHowItWorks({ ...settings, windowEndEt: "15:00", volFarmerV4CallsInTheMoneyAtLastLook: "bought_back_before_weekends" }, figures).volFarmerV4;
    expect(values).toMatchObject({ callsInTheMoneyAtLastLook: "bought_back_before_weekends", buyBackStartsEt: "14:58", buyBackCancelledAtEt: "15:58", example: { buyBackTimeEt: "14:59" } });
    // A 100% budget, as on staging: pot 480,000, 38 lots, the mockup's $4,180 + $25.84.
    expect(buildPlutoHowItWorks({ ...settings, capitalBudgetPct: 100 }, figures).volFarmerV4.example).toMatchObject({ lots: 38, buyBackCostDollars: 4_180, buyBackCommissionDollars: 25.84 });
  });

  it("raises the example's pot by the excess allowance", () => {
    const values = buildPlutoHowItWorks({ ...settings, excessAllowancePct: 0 }, figures);
    // Without it, the pot is the allocation alone, 2,000,000 × 20% × 50% = 200,000: floor(160,000 ÷ 10,000.50) = 15 lots; the LEAPS cap 10% of 200,000.
    expect(values.shared.excessAllowancePct).toBe(0);
    expect(values.volFarmerV4.example).toMatchObject({ pot: 200_000, lots: 15, leapsCap: 20_000 });
  });
});
