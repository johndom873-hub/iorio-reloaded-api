import { describe, expect, it } from "vitest";
import { combineBatchRuns, type CombinedRunInput } from "./batchCombined.js";

const run = (runNumber: number, values: [string, number, number | null][], cycles: CombinedRunInput["book"]["cycles"] = []): CombinedRunInput => ({
  runNumber,
  startingValue: values[0]![1],
  days: values.map(([tradingDate, value, spyBaselineValue]) => ({ tradingDate, value, exposureDollars: value / 2, interestDollars: 1, baselineValue: value, spyBaselineValue })),
  book: { optionSales: cycles.map(() => ({ inTheMoneyAtExpiry: false })), cycles },
});
const cycle = (totalDollars: number) => ({ status: "closed" as const, totalDollars, firstSaleEdgeMargin: null, expectedPnlDollars: 0, calibratedExpectedPnlDollars: 0, optionSaleCount: 1 });

describe("a batch's combined portfolio (F1)", () => {
  it("adds the runs up on the days they all have, counting the others left out", () => {
    const combined = combineBatchRuns([
      run(1, [
        ["2026-01-02", 100_000, 100_000],
        ["2026-01-05", 110_000, 101_000],
        ["2026-01-06", 120_000, 102_000],
      ]),
      run(2, [
        ["2026-01-02", 50_000, 50_000],
        ["2026-01-06", 40_000, 51_000],
      ]),
    ]);
    expect(combined.points).toEqual([
      { tradingDate: "2026-01-02", value: 150_000, baselineValue: 150_000, spyBaselineValue: 150_000 },
      { tradingDate: "2026-01-06", value: 160_000, baselineValue: 160_000, spyBaselineValue: 153_000 },
    ]);
    expect(combined.daysLeftOut).toBe(1);
    expect(combined.metrics).toMatchObject({ startValue: 150_000, endValue: 160_000, interestDollars: 4 });
    // Capital in use: Σ exposure ÷ Σ value each day, averaged (exposure is half of each run's value here).
    expect(combined.metrics.capitalInUse).toBeCloseTo(0.5, 10);
  });

  it("pools the runs' cycles and leaves SPY out when a run did not keep it", () => {
    const combined = combineBatchRuns([
      run(1, [["2026-01-02", 100_000, 100_000], ["2026-01-05", 101_000, 100_500]], [cycle(500), cycle(-200)]),
      run(3, [["2026-01-02", 100_000, null], ["2026-01-05", 99_000, null]], [cycle(300)]),
    ]);
    expect(combined.runNumbers).toEqual([1, 3]);
    expect(combined.metrics).toMatchObject({ tradeCount: 3, cycleCount: 3, closedCycleCount: 3, averageWinDollars: 400, averageLossDollars: -200 });
    expect(combined.metrics.winRate).toBeCloseTo(2 / 3, 10);
    expect(combined.spyBaselineFigures).toBeNull();
    expect(combined.points.every((point) => point.spyBaselineValue === null)).toBe(true);
  });

  it("needs two or more runs", () => {
    expect(() => combineBatchRuns([run(1, [["2026-01-02", 1, 1]])])).toThrow("A combined portfolio needs two or more runs.");
  });
});
