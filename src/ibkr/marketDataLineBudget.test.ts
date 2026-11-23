import { describe, expect, it } from "vitest";
import { computeAvailableLines, computeMarketDataLineBudget, describeMarketDataLineShortage, totalMarketDataLineBudget } from "./marketDataLineBudget.js";

describe("computeMarketDataLineBudget", () => {
  it("follows the lowest recent night's equity on the live account, less the 10 spare lines", () => {
    expect(computeMarketDataLineBudget({ tradingMode: "live", recentNightlyNetLiquidations: [1_250_000, 1_210_000, 1_300_000] })).toEqual({ budget: 111, estimatedIbkrCeiling: 121, netLiquidationUsed: 1_210_000 });
    expect(computeMarketDataLineBudget({ tradingMode: "live", recentNightlyNetLiquidations: [1_182_249, 1_195_283, 1_222_075] }).budget).toBe(108);
  });

  it("keeps IBKR's floor of 100 below $1M", () => {
    expect(computeMarketDataLineBudget({ tradingMode: "live", recentNightlyNetLiquidations: [964_402, 1_091_638] })).toEqual({ budget: 90, estimatedIbkrCeiling: 100, netLiquidationUsed: 964_402 });
  });

  it("uses the floor on the paper login and when no recent snapshot exists", () => {
    expect(computeMarketDataLineBudget({ tradingMode: "paper", recentNightlyNetLiquidations: [5_000_000] })).toEqual({ budget: totalMarketDataLineBudget, estimatedIbkrCeiling: 100, netLiquidationUsed: null });
    expect(computeMarketDataLineBudget({ tradingMode: "live", recentNightlyNetLiquidations: [] }).budget).toBe(90);
  });

  it("ignores unusable values instead of letting them set the budget", () => {
    expect(computeMarketDataLineBudget({ tradingMode: "live", recentNightlyNetLiquidations: [0, Number.NaN, 1_500_000] }).budget).toBe(140);
  });
});

describe("computeAvailableLines", () => {
  it("gives a non-priority holder what is left after both priority and other holders", () => {
    expect(computeAvailableLines({ priorityInUse: 0, otherInUse: 0 }, false)).toBe(totalMarketDataLineBudget);
    expect(computeAvailableLines({ priorityInUse: 50, otherInUse: 25 }, false)).toBe(15);
    expect(computeAvailableLines({ priorityInUse: 50, otherInUse: 60 }, false)).toBe(0);
  });

  it("lets a priority holder ignore non-priority usage entirely", () => {
    expect(computeAvailableLines({ priorityInUse: 0, otherInUse: 85 }, true)).toBe(totalMarketDataLineBudget);
    expect(computeAvailableLines({ priorityInUse: 50, otherInUse: 85 }, true)).toBe(40);
  });

  it("works against a budget above the floor", () => {
    expect(computeAvailableLines({ priorityInUse: 50, otherInUse: 25 }, false, 111)).toBe(36);
  });

  it("never goes negative", () => {
    expect(computeAvailableLines({ priorityInUse: 100, otherInUse: 100 }, true)).toBe(0);
  });
});

describe("describeMarketDataLineShortage", () => {
  it("names the market quote loop and Pluto when a priority reservation is the reason", () => {
    const message = describeMarketDataLineShortage({ ok: false, availableLines: 12, priorityLinesHeld: 50 }, "AAOI", 40);
    expect(message).toContain("market quote loop and Pluto");
    expect(message).toContain("reserved lines (50)");
    expect(message).toContain("AAOI needs 40 lines, 12 available");
  });

  it("falls back to the plain busy message otherwise", () => {
    const message = describeMarketDataLineShortage({ ok: false, availableLines: 3, priorityLinesHeld: 0 }, "AAOI", 40);
    expect(message).not.toContain("scheduled scan");
    expect(message).toContain("only 3 available");
  });

  it("says so when lines are disabled by the environment switch", () => {
    const message = describeMarketDataLineShortage({ ok: false, availableLines: 0, priorityLinesHeld: 0, disabled: true }, "AAOI", 40);
    expect(message).toContain("IBKR_MARKET_DATA_LINES_ENABLED=false");
  });
});
