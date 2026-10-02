import { describe, expect, it } from "vitest";
import { annualiseReturnPercent, chainReturnFractions, computeDailyPerformancePoints, summarizePerformance, type PerformanceSnapshotRow } from "./performanceReturns.js";

const row = (snapshotDate: string, netLiquidationValue: number | null, netCashFlow: number | null = 0): PerformanceSnapshotRow => ({ snapshotDate, netLiquidationValue, netCashFlow });

describe("computeDailyPerformancePoints", () => {
  it("is empty without at least two usable snapshots", () => {
    expect(computeDailyPerformancePoints([])).toEqual([]);
    expect(computeDailyPerformancePoints([row("2026-10-01", 100_000)])).toEqual([]);
  });

  it("measures each day against the previous NAV when there are no flows", () => {
    const points = computeDailyPerformancePoints([row("2026-10-01", 100_000), row("2026-10-02", 101_000), row("2026-10-05", 100_495)]);
    expect(points.map((point) => point.returnFraction)).toEqual([0.01, -0.005]);
    expect(points.map((point) => point.profitDollars)).toEqual([1_000, -505]);
  });

  it("removes a deposit from the return", () => {
    const [point] = computeDailyPerformancePoints([row("2026-10-01", 100_000), row("2026-10-02", 110_000, 5_000)]);
    expect(point?.profitDollars).toBe(5_000);
    expect(point?.returnFraction).toBeCloseTo(0.05, 12);
  });

  it("removes a withdrawal from the return", () => {
    const [point] = computeDailyPerformancePoints([row("2026-10-01", 100_000), row("2026-10-02", 95_500, -5_000)]);
    expect(point?.profitDollars).toBe(500);
    expect(point?.returnFraction).toBeCloseTo(0.005, 12);
  });

  it("treats a transfer the size of the account as a flow at the close, not performance", () => {
    const [point] = computeDailyPerformancePoints([row("2026-10-01", 100_000), row("2026-10-02", 200_500, 100_000)]);
    expect(point?.profitDollars).toBe(500);
    expect(point?.returnFraction).toBeCloseTo(0.005, 12);
  });

  it("ignores a flow on the first snapshot, since it is the starting point", () => {
    const points = computeDailyPerformancePoints([row("2026-10-01", 100_000, 100_000), row("2026-10-02", 101_000)]);
    expect(points).toHaveLength(1);
    expect(points[0]?.returnFraction).toBeCloseTo(0.01, 12);
  });

  it("carries the cash flow of a row with no NAV into the next usable row", () => {
    const points = computeDailyPerformancePoints([row("2026-10-01", 100_000), row("2026-10-02", null, 1_000), row("2026-10-05", 102_000)]);
    expect(points).toHaveLength(1);
    expect(points[0]?.profitDollars).toBe(1_000);
    expect(points[0]?.returnFraction).toBeCloseTo(0.01, 12);
  });

  it("treats a missing cash flow as zero", () => {
    const [point] = computeDailyPerformancePoints([row("2026-10-01", 100_000, null), row("2026-10-02", 101_000, null)]);
    expect(point?.profitDollars).toBe(1_000);
  });

  it("gives no return for a day whose previous NAV is zero", () => {
    const points = computeDailyPerformancePoints([row("2026-10-01", 0), row("2026-10-02", 100, 100), row("2026-10-05", 101)]);
    expect(points.map((point) => point.snapshotDate)).toEqual(["2026-10-05"]);
    expect(points[0]?.returnFraction).toBeCloseTo(0.01, 12);
  });

  it("orders rows by date before computing", () => {
    const points = computeDailyPerformancePoints([row("2026-10-02", 101_000), row("2026-10-01", 100_000)]);
    expect(points[0]?.returnFraction).toBeCloseTo(0.01, 12);
  });
});

describe("chainReturnFractions", () => {
  it("compounds rather than adds", () => {
    expect(chainReturnFractions([0.01, 0.01])).toBeCloseTo(0.0201, 12);
    expect(chainReturnFractions([0.1, -0.1])).toBeCloseTo(-0.01, 12);
  });
  it("is null for no days", () => {
    expect(chainReturnFractions([])).toBeNull();
  });
});

describe("annualiseReturnPercent", () => {
  it("annualises over the span of days", () => {
    expect(annualiseReturnPercent(10, 730)).toBeCloseTo((Math.sqrt(1.1) - 1) * 100, 10);
    expect(annualiseReturnPercent(5, 365)).toBeCloseTo(5, 10);
  });
  it("extrapolates a short span", () => {
    expect(annualiseReturnPercent(1, 73)).toBeCloseTo((Math.pow(1.01, 5) - 1) * 100, 10);
  });
  it("is null for a span under a day or a total loss", () => {
    expect(annualiseReturnPercent(1, 0)).toBeNull();
    expect(annualiseReturnPercent(-100, 100)).toBeNull();
    expect(annualiseReturnPercent(-150, 100)).toBeNull();
  });
});

describe("summarizePerformance", () => {
  const rows = [
    row("2026-12-30", 100_000),
    row("2026-12-31", 101_000), // +1.00% (December)
    row("2027-01-04", 102_010), // +1.00% (January)
    row("2027-01-05", 112_010, 10_000), // 0% after the 10,000 deposit
    row("2027-02-01", 113_130.1), // +1.00% (February)
  ];

  it("names the starting point and the latest snapshot", () => {
    const summary = summarizePerformance(rows, "2027-02-01");
    expect(summary.trackingSince).toBe("2026-12-30");
    expect(summary.asOf).toBe("2027-02-01");
    expect(summary.trackingSpanDays).toBe(33);
  });

  it("groups daily returns into calendar months, leaving the deposit out", () => {
    const summary = summarizePerformance(rows, "2027-02-01");
    expect(summary.months.map((month) => [month.year, month.month])).toEqual([[2026, 12], [2027, 1], [2027, 2]]);
    expect(summary.months[0]?.percent).toBeCloseTo(1, 10);
    expect(summary.months[1]?.percent).toBeCloseTo(1, 10); // 1% then 0%
    expect(summary.months[2]?.percent).toBeCloseTo(1, 10);
    expect(summary.months[1]?.profitDollars).toBeCloseTo(1_010, 6);
  });

  it("chains months into calendar years and since inception", () => {
    const summary = summarizePerformance(rows, "2027-02-01");
    expect(summary.years.map((year) => year.year)).toEqual([2026, 2027]);
    expect(summary.years[0]?.percent).toBeCloseTo(1, 10);
    expect(summary.years[1]?.percent).toBeCloseTo((1.01 * 1.01 - 1) * 100, 8);
    expect(summary.sinceInceptionPercent).toBeCloseTo((1.01 * 1.01 * 1.01 - 1) * 100, 8);
  });

  it("annualises since inception over the calendar days tracked", () => {
    const summary = summarizePerformance(rows, "2027-02-01");
    const expected = (Math.pow(1.01 ** 3, 365 / 33) - 1) * 100;
    expect(summary.compoundAnnualGrowthRatePercent).toBeCloseTo(expected, 6);
  });

  it("month to date is the current Eastern month, and null before its first snapshot", () => {
    expect(summarizePerformance(rows, "2027-02-01").monthToDate?.percent).toBeCloseTo(1, 10);
    expect(summarizePerformance(rows, "2027-01-20").monthToDate?.percent).toBeCloseTo(1, 10);
    expect(summarizePerformance(rows, "2027-03-01").monthToDate).toBeNull();
  });

  it("reports nothing but the starting point after a single snapshot", () => {
    const summary = summarizePerformance([row("2026-09-30", 100_033.8)], "2026-09-30");
    expect(summary.trackingSince).toBe("2026-09-30");
    expect(summary.months).toEqual([]);
    expect(summary.years).toEqual([]);
    expect(summary.monthToDate).toBeNull();
    expect(summary.sinceInceptionPercent).toBeNull();
    expect(summary.compoundAnnualGrowthRatePercent).toBeNull();
  });

  it("matches the live account's first two snapshots", () => {
    const summary = summarizePerformance([row("2026-09-30", 100_033.8), row("2026-10-01", 100_026.45)], "2026-10-01");
    expect(summary.monthToDate?.percent).toBeCloseTo((-7.35 / 100_033.8) * 100, 10);
    expect(summary.monthToDate?.profitDollars).toBeCloseTo(-7.35, 10);
    expect(summary.months).toHaveLength(1);
    expect(summary.years[0]?.year).toBe(2026);
  });

  it("handles no rows", () => {
    const summary = summarizePerformance([], "2026-10-01");
    expect(summary).toEqual({ trackingSince: null, asOf: null, trackingSpanDays: null, monthToDate: null, months: [], years: [], sinceInceptionPercent: null, compoundAnnualGrowthRatePercent: null });
  });
});
