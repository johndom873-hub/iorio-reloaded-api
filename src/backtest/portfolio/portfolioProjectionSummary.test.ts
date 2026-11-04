import { describe, expect, it } from "vitest";
import { addRegressionDay, type PathOutcome, type RegressionSums } from "./portfolioDayProjection.js";
import { drawdownAtOddsOf, percentilesOf, slopeOfSums, summarizeProjection } from "./portfolioProjectionSummary.js";

const outcome = (cagr: number, maxDrawdown: number, calls: number): PathOutcome => ({
  cagr,
  maxDrawdown,
  maxDrawdownFrom: 0,
  maxDrawdownTo: 1,
  endValue: 1_000_000 * (1 + cagr) ** 2,
  yearEndValues: [1_000_000 * (1 + cagr), 1_000_000 * (1 + cagr) ** 2],
  sources: { callsDollars: calls, putsDollars: 0, leapsDollars: 0, interestDollars: 80_000, dividendsDollars: 0, sharesDollars: 0 },
  byTicker: [{ symbol: "XLE", premiumDollars: calls, callsSold: 200, callAways: 60, daysWithoutShares: 63 }],
  spyRegression: null,
});

describe("the drawdown at each odds", () => {
  it("is the fall reached in 1 path in 10, 20 and 100: the value at floor(n ÷ N) from the worst", () => {
    // 200 paths with Max drawdowns of −0.1%, −0.2%, …, −20%. From the worst, index floor(200 ÷ N): 20 → −18%, 10 → −19%, 2 → −19.8%.
    const drawdowns = Array.from({ length: 200 }, (_, at) => -(at + 1) / 1000);
    expect(drawdownAtOddsOf(drawdowns)).toEqual([
      { oneIn: 10, maxDrawdown: -0.18 },
      { oneIn: 20, maxDrawdown: -0.19 },
      { oneIn: 100, maxDrawdown: -0.198 },
    ]);
  });
});

describe("the book betas", () => {
  const sumsOf = (days: [number, number][]): RegressionSums => {
    const sums: RegressionSums = { count: 0, sumSpy: 0, sumBook: 0, sumSpyBook: 0, sumSpySquared: 0 };
    for (const [spy, book] of days) addRegressionDay(sums, spy, book);
    return sums;
  };

  it("is the least-squares slope of the book's days on SPY's, pooled over the paths", () => {
    // The book moves 0.6 × SPY's day + 0.0002: slope 0.6 whatever the split into paths.
    const days: [number, number][] = [-0.03, -0.01, 0.002, 0.012, 0.025, -0.02].map((spy) => [spy, 0.6 * spy + 0.0002]);
    expect(slopeOfSums([sumsOf(days.slice(0, 3)), sumsOf(days.slice(3))])).toBeCloseTo(0.6, 12);
  });

  it("reads the downside beta on the days SPY fell only, where Covered Calls keep more of the move", () => {
    // Rises captured at 0.3, falls at 0.9: the downside slope is 0.9.
    const days: [number, number][] = [-0.03, -0.01, -0.02, 0.01, 0.02, 0.03].map((spy) => [spy, spy < 0 ? 0.9 * spy : 0.3 * spy]);
    expect(slopeOfSums([sumsOf(days.filter(([spy]) => spy < 0))])).toBeCloseTo(0.9, 12);
    expect(slopeOfSums([sumsOf(days)])).toBeGreaterThan(0.3);
  });
});

describe("the projection's figures over its paths", () => {
  it("takes the value at floor(q × n) of the sorted values for the 10th, 50th and 90th percentiles", () => {
    expect(percentilesOf([5, 1, 4, 2, 3, 10, 9, 8, 7, 6])).toEqual({ p10: 2, p50: 6, p90: 10 });
  });

  it("works Excess Calmar per path, the drawdowns at each odds, and each source's average year", () => {
    const outcomes = [outcome(0.14, -0.25, 300_000), outcome(0.04, -0.35, 100_000)];
    const summary = summarizeProjection(outcomes, { accountDollars: 1_000_000, horizonYears: 2, riskFreeRatePercent: 4, horizonDays: 504 });
    // (14% − 4%) ÷ 25% = 0.4; (4% − 4%) ÷ 35% = 0.
    expect(summary.excessCalmar.p10).toBeCloseTo(0, 12);
    expect(summary.excessCalmar.p90).toBeCloseTo(0.4, 12);
    // Two paths: floor(2 ÷ N) = 0 for every odds, the worse one.
    expect(summary.drawdownAtOdds).toEqual([{ oneIn: 10, maxDrawdown: -0.35 }, { oneIn: 20, maxDrawdown: -0.35 }, { oneIn: 100, maxDrawdown: -0.35 }]);
    // Calls (300,000 + 100,000) ÷ 2 paths ÷ 2 years = 100,000 a year, 10% of the account.
    expect(summary.averageYear.calls).toEqual({ dollars: 100_000, share: 0.1 });
    expect(summary.averageYear.interest.dollars).toBe(40_000);
    expect(summary.tickers[0]).toEqual({ symbol: "XLE", premiumYear: 100_000, callsSoldYear: 100, callAwaysYear: 30, daysWithoutSharesShare: 63 / 504 });
    expect(summary.yearEnds.map((entry) => entry.year)).toEqual([1, 2]);
  });
});
