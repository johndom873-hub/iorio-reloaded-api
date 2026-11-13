import { describe, expect, it } from "vitest";
import type { DailyPerformancePoint } from "./performanceReturns.js";
import { computeBookRiskFigures } from "./performanceRisk.js";

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const point = (snapshotDate: string, returnFraction: number, profitDollars = returnFraction * 100_000): DailyPerformancePoint => ({ snapshotDate, returnFraction, profitDollars });

describe("computeBookRiskFigures", () => {
  it("measures the drawdown on the growth index, with its dollars and dates, and holds back what lacks history", () => {
    const figures = computeBookRiskFigures("2026-01-01", [point("2026-01-02", 0.01, 1_000), point("2026-01-03", -0.02, -2_020), point("2026-01-04", 0.005, 494.9)], () => 4);
    expect(figures.returnPercent).toBeCloseTo((1.01 * 0.98 * 1.005 - 1) * 100, 10);
    expect(figures.maxDrawdown.percent).toBeCloseTo(-2, 10); // 0.9898 ÷ 1.01 − 1
    expect(figures.maxDrawdown.dollars).toBeCloseTo(-2_020, 6);
    expect(figures.maxDrawdown).toMatchObject({ peakNight: "2026-01-02", troughNight: "2026-01-03", recoveryNight: null, lengthDays: 2 });
    expect(figures.cagrPercent).toEqual({ value: null, have: 3, need: 90, unit: "calendar days" });
    expect(figures.sortino).toEqual({ value: null, have: 3, need: 60, unit: "daily returns" });
    expect(figures.excessCalmar.value).toBeNull();
    expect(figures.bestDay).toEqual({ night: "2026-01-02", returnPercent: 1 });
    expect(figures.positiveDaysPercent).toBeCloseTo(200 / 3, 10);
  });

  it("dates the recovery to the first night back at the peak", () => {
    const figures = computeBookRiskFigures("2026-01-01", [point("2026-01-02", 0.02), point("2026-01-03", -0.01), point("2026-01-04", 1.02 / (1.02 * 0.99) - 1), point("2026-01-05", 0.01)], () => 4);
    expect(figures.maxDrawdown).toMatchObject({ peakNight: "2026-01-02", troughNight: "2026-01-03", recoveryNight: "2026-01-04", lengthDays: 2 });
  });

  it("computes volatility, Sharpe and Sortino against the T-bill once 60 daily returns exist", () => {
    // 30 days of +1% then 30 of −0.5%, every other calendar day (120 days), T-bill 2.52% a year = 0.0001 a day.
    const points = Array.from({ length: 60 }, (_, index) => point(addDays("2026-01-01", 2 * (index + 1)), index < 30 ? 0.01 : -0.005));
    const figures = computeBookRiskFigures("2026-01-01", points, () => 2.52);
    const mean = 0.0025;
    const sampleStandardDeviation = Math.sqrt((60 * 0.0075 ** 2) / 59);
    const downsideDeviation = Math.sqrt((30 * 0.0051 ** 2) / 60); // excess returns of −0.5% − 0.01% on 30 of 60 days
    expect(figures.volatilityPercent.value).toBeCloseTo(sampleStandardDeviation * Math.sqrt(252) * 100, 8);
    expect(figures.sharpe.value).toBeCloseTo(((mean - 0.0001) / sampleStandardDeviation) * Math.sqrt(252), 8);
    expect(figures.sortino.value).toBeCloseTo(((mean - 0.0001) * Math.sqrt(252)) / downsideDeviation, 8);
    expect(figures.treasuryBillPercent).toBeCloseTo(2.52, 10);
    const totalReturn = 1.01 ** 30 * 0.995 ** 30;
    expect(figures.cagrPercent.value).toBeCloseTo((totalReturn ** (365 / 120) - 1) * 100, 8);
    expect(figures.maxDrawdown.percent).toBeCloseTo((0.995 ** 30 - 1) * 100, 8);
    expect(figures.excessCalmar).toEqual({ value: null, have: 120, need: 180, unit: "calendar days" });
  });

  it("gives Excess Calmar from 180 days as (CAGR − T-bill) ÷ |Max drawdown|", () => {
    const points = Array.from({ length: 200 }, (_, index) => point(addDays("2026-01-01", index + 1), index === 10 ? -0.06 : 0.001));
    const figures = computeBookRiskFigures("2026-01-01", points, () => 4.05);
    expect(figures.excessCalmar.value).toBeCloseTo((figures.cagrPercent.value! - 4.05) / 6, 8);
  });

  it("leaves the T-bill ratios empty when a night has no rate", () => {
    const points = Array.from({ length: 60 }, (_, index) => point(addDays("2026-01-01", index + 1), 0.001 * (index % 3)));
    const figures = computeBookRiskFigures("2026-01-01", points, (night) => (night < "2026-01-10" ? null : 4));
    expect(figures.sharpe.value).toBeNull();
    expect(figures.volatilityPercent.value).not.toBeNull();
  });
});
