import { describe, expect, it } from "vitest";
import type { PathOutcome } from "./portfolioDayProjection.js";
import { percentilesOf, summarizeProjection } from "./portfolioProjectionSummary.js";

const outcome = (cagr: number, maxDrawdown: number, calls: number): PathOutcome => ({
  cagr,
  maxDrawdown,
  maxDrawdownFrom: 0,
  maxDrawdownTo: 1,
  endValue: 1_000_000 * (1 + cagr) ** 2,
  yearEndValues: [1_000_000 * (1 + cagr), 1_000_000 * (1 + cagr) ** 2],
  sources: { callsDollars: calls, putsDollars: 0, leapsDollars: 0, interestDollars: 80_000, sharesDollars: 0 },
  byTicker: [{ symbol: "XLE", premiumDollars: calls, callsSold: 200, callAways: 60, daysWithoutShares: 63 }],
});

describe("the projection's figures over its paths", () => {
  it("takes the value at floor(q × n) of the sorted values for the 10th, 50th and 90th percentiles", () => {
    expect(percentilesOf([5, 1, 4, 2, 3, 10, 9, 8, 7, 6])).toEqual({ p10: 2, p50: 6, p90: 10 });
  });

  it("works Excess Calmar per path, the falls past each threshold, and each source's average year", () => {
    const outcomes = [outcome(0.14, -0.25, 300_000), outcome(0.04, -0.35, 100_000)];
    const summary = summarizeProjection(outcomes, { accountDollars: 1_000_000, horizonYears: 2, riskFreeRatePercent: 4, horizonDays: 504 });
    // (14% − 4%) ÷ 25% = 0.4; (4% − 4%) ÷ 35% = 0.
    expect(summary.excessCalmar.p10).toBeCloseTo(0, 12);
    expect(summary.excessCalmar.p90).toBeCloseTo(0.4, 12);
    expect(summary.fallWorseThan.map((entry) => entry.share)).toEqual([1, 1, 0.5, 0]);
    // Calls (300,000 + 100,000) ÷ 2 paths ÷ 2 years = 100,000 a year, 10% of the account.
    expect(summary.averageYear.calls).toEqual({ dollars: 100_000, share: 0.1 });
    expect(summary.averageYear.interest.dollars).toBe(40_000);
    expect(summary.tickers[0]).toEqual({ symbol: "XLE", premiumYear: 100_000, callsSoldYear: 100, callAwaysYear: 30, daysWithoutSharesShare: 63 / 504 });
    expect(summary.yearEnds.map((entry) => entry.year)).toEqual([1, 2]);
  });
});
