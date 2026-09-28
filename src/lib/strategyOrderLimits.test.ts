import { describe, expect, it } from "vitest";
import { applyOrderLimitThresholds, type OrderLimitFigures, type OrderLimitThresholds } from "./signalOrderLimits.js";

// The pure ceiling check shared by the Signals-tab limits and the Trade Alerts tab's
// strategy_settings maxima (gap fix 6, 2026-09-28).
const figures: OrderLimitFigures = {
  symbol: "AAOI",
  sector: "Communications",
  strategyKey: "cash_secured_put",
  totalPortfolioValue: 1_000_000,
  freeCash: 400_000,
  orderNotional: 50_000,
  existingTickerExposure: 100_000,
  existingSectorExposure: 250_000,
  cashLockedInCsps: 300_000,
};

const signalsThresholds: OrderLimitThresholds = { sourceLabel: "Signals tab", maxPositionPctOfPortfolio: 10, maxConcentrationPerTickerPct: 20, minCashReservePct: 5 };
const strategyThresholds: OrderLimitThresholds = { ...signalsThresholds, sourceLabel: "Trade Alerts tab", maxConcentrationPerSectorPct: 30, maxAggregateCollateralPct: 80 };

describe("applyOrderLimitThresholds", () => {
  it("passes when every ceiling holds", () => {
    expect(applyOrderLimitThresholds(figures, signalsThresholds)).toEqual({ blocked: false, reasons: [] });
    expect(applyOrderLimitThresholds(figures, strategyThresholds)).toEqual({ blocked: false, reasons: [] });
  });

  it("the three shared ceilings block and name their tab", () => {
    const result = applyOrderLimitThresholds({ ...figures, orderNotional: 150_000 }, signalsThresholds);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toEqual([
      "This order is 15.0% of portfolio value, above the Signals tab's 10% max position size.",
      "AAOI would be 25.0% of portfolio value, above the Signals tab's 20% max concentration per ticker.",
    ]);
    expect(applyOrderLimitThresholds({ ...figures, freeCash: 60_000 }, strategyThresholds).reasons).toEqual([
      "Placing this order would leave only 1.0% of portfolio value as cash, below the Trade Alerts tab's 5% min cash reserve.",
    ]);
  });

  it("the sector ceiling only exists for strategy thresholds", () => {
    const crowded = { ...figures, existingSectorExposure: 280_000 };
    expect(applyOrderLimitThresholds(crowded, signalsThresholds).blocked).toBe(false);
    expect(applyOrderLimitThresholds(crowded, strategyThresholds).reasons).toEqual([
      "The Communications sector would be 33.0% of portfolio value, above the Trade Alerts tab's 30% max concentration per sector.",
    ]);
  });

  it("aggregate CSP collateral counts this put's own reservation and ignores covered calls", () => {
    const heavy = { ...figures, cashLockedInCsps: 760_000 };
    expect(applyOrderLimitThresholds(heavy, strategyThresholds).reasons).toEqual([
      "Cash-secured-put collateral would be 81.0% of portfolio value, above the Trade Alerts tab's 80% max aggregate collateral.",
    ]);
    expect(applyOrderLimitThresholds({ ...heavy, strategyKey: "covered_call" }, strategyThresholds).blocked).toBe(false);
  });

  it("an unknown sector is reported as unknown rather than skipped", () => {
    const result = applyOrderLimitThresholds({ ...figures, sector: null, existingSectorExposure: 0, orderNotional: 350_000, freeCash: 900_000 }, { ...strategyThresholds, maxPositionPctOfPortfolio: 50, maxConcentrationPerTickerPct: 60 });
    expect(result.reasons).toEqual(["The unknown sector would be 35.0% of portfolio value, above the Trade Alerts tab's 30% max concentration per sector."]);
  });
});
