import { describe, expect, it } from "vitest";
import { computeBacktestMetrics, computeCycleAccuracyBands, computeDailyReturns, computeDrawdowns, computeMonthlyReturns, computeSortino, computeTradeAccuracyBands, cycleFiguresOf, type AccountDay, type ClosedTradeFigures, type CycleFigures } from "./sessionAnalytics.js";

const day = (tradingDate: string, value: number, exposureDollars = 0, interestDollars = 0): AccountDay => ({ tradingDate, value, exposureDollars, interestDollars });

const cycle = (overrides: Partial<CycleFigures>): CycleFigures => ({ status: "closed", totalDollars: 100, firstSaleEdgeMargin: 0.25, expectedPnlDollars: 150, calibratedExpectedPnlDollars: 120, optionSaleCount: 1, ...overrides });

const trade = (overrides: Partial<ClosedTradeFigures>): ClosedTradeFigures => ({
  openedOn: "2024-03-01",
  settledOn: "2024-03-08",
  exposureDollars: 10_000,
  pnlDollars: 100,
  expectedPnlDollars: 150,
  calibratedExpectedPnlDollars: 120,
  edgeMargin: 0.25,
  inTheMoneyAtExpiry: false,
  ...overrides,
});

describe("computeDailyReturns and computeDrawdowns", () => {
  it("returns value ÷ previous − 1, null first, and the fall from the running peak", () => {
    expect(computeDailyReturns([100, 110, 99])).toEqual([null, expect.closeTo(0.1, 12), expect.closeTo(-0.1, 12)]);
    expect(computeDrawdowns([100, 120, 90, 130])).toEqual([0, 0, -0.25, 0]);
  });
});

describe("computeSortino", () => {
  it("annualizes mean over downside deviation on 252 days (FORMULAS.md example: 0.025% mean, 0.35% downside → 1.13)", () => {
    // Two returns with mean 0.00025 and downside deviation 0.0035: r1 = −0.0035 × √2, r2 = 0.0005 − r1.
    const r1 = -0.0035 * Math.SQRT2;
    const r2 = 0.0005 - r1;
    expect(computeSortino([r1, r2])).toBeCloseTo(1.134, 3);
  });

  it("is null without a losing day", () => {
    expect(computeSortino([0.01, 0.02])).toBeNull();
  });
});

describe("computeBacktestMetrics", () => {
  it("reproduces the FORMULAS.md CAGR example: $1,000,000 → $1,418,000 over 2,095 days = +6.3%", () => {
    // A buy-and-hold series has no book: no trades, no cycles.
    const metrics = computeBacktestMetrics([day("2021-01-04", 1_000_000), day("2026-09-30", 1_418_000)], null, 1_000_000);
    expect(metrics.totalReturn).toBeCloseTo(0.418, 10);
    expect(metrics.cagr).toBeCloseTo(0.0627, 4);
    expect(metrics.tradeCount).toBe(0);
    expect(metrics.winRate).toBeNull();
    expect(metrics.returnOnCapitalInUse).toBeNull();
    expect(metrics).not.toHaveProperty("cycleCount");
  });

  it("computes drawdown, capital in use and interest from the days, and win rate, averages and edge capture from the wheel cycles", () => {
    const days = [day("2024-03-01", 1_000_000, 0, 0), day("2024-03-04", 1_010_000, 202_000, 300), day("2024-03-05", 959_500, 191_900, 100)];
    // Three options sold; two closed cycles (+300 and -100, 200 of Edge $ predicted for each) and one still open (+50).
    const book = {
      optionSales: [{ inTheMoneyAtExpiry: false }, { inTheMoneyAtExpiry: true }, { inTheMoneyAtExpiry: null }],
      cycles: [cycle({ totalDollars: 300, expectedPnlDollars: 200 }), cycle({ totalDollars: -100, expectedPnlDollars: 200 }), cycle({ status: "open", totalDollars: 50, expectedPnlDollars: 900 })],
    };
    const metrics = computeBacktestMetrics(days, book, 1_000_000);
    expect(metrics.maxDrawdown).toBeCloseTo(959_500 / 1_010_000 - 1, 12);
    expect(metrics.capitalInUse).toBeCloseTo((0 + 0.2 + 0.2) / 3, 12);
    expect(metrics.interestDollars).toBe(400);
    expect(metrics.tradeCount).toBe(3);
    expect(metrics).toMatchObject({ cycleCount: 3, closedCycleCount: 2 });
    // Closed cycles only: one of two made money.
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.averageWinDollars).toBe(300);
    expect(metrics.averageLossDollars).toBe(-100);
    expect(metrics.edgeCapture).toBeCloseTo(200 / 400, 12);
    // Every cycle's total (250) ÷ Σ EXP $ × calendar days to the next session day (0 × 3 + 202,000 × 1) × 365.
    expect(metrics.returnOnCapitalInUse).toBeCloseTo((250 / 202_000) * 365, 12);
    expect(metrics.inTheMoneyAtExpiryShare).toBe(0.5);
    expect(metrics.worstMonth).toBeCloseTo(-0.0405, 4);
  });

  it("has no win rate or edge capture before a cycle closes", () => {
    const metrics = computeBacktestMetrics([day("2024-03-01", 1_000_000), day("2024-03-04", 1_000_500, 50_000)], { optionSales: [{ inTheMoneyAtExpiry: null }], cycles: [cycle({ status: "open", totalDollars: 500 })] }, 1_000_000);
    expect(metrics).toMatchObject({ tradeCount: 1, cycleCount: 1, closedCycleCount: 0, winRate: null, averageWinDollars: null, averageLossDollars: null, edgeCapture: null });
  });
});

describe("cycleFiguresOf", () => {
  it("gives each cycle the predictions of the options sold in it, the first one's edge margin as its own", () => {
    const sale = (symbol: string, cycleNumber: number | null, edgeMargin: number, expectedPnlDollars: number) => ({ symbol, cycleNumber, edgeMargin, expectedPnlDollars, calibratedExpectedPnlDollars: expectedPnlDollars / 2 });
    const figures = cycleFiguresOf(
      [
        { symbol: "HOOD", cycleNumber: 1, status: "closed", totalDollars: 900 },
        { symbol: "HOOD", cycleNumber: 2, status: "open", totalDollars: -40 },
        { symbol: "SMCI", cycleNumber: 1, status: "closed", totalDollars: 10 },
      ],
      [sale("HOOD", 1, 0.22, 100), sale("SMCI", 1, 0.05, 30), sale("HOOD", 1, 0.31, 60), sale("HOOD", 2, 0.12, 80), sale("HOOD", null, 0.5, 999)],
    );
    expect(figures).toEqual([
      { status: "closed", totalDollars: 900, firstSaleEdgeMargin: 0.22, expectedPnlDollars: 160, calibratedExpectedPnlDollars: 80, optionSaleCount: 2 },
      { status: "open", totalDollars: -40, firstSaleEdgeMargin: 0.12, expectedPnlDollars: 80, calibratedExpectedPnlDollars: 40, optionSaleCount: 1 },
      { status: "closed", totalDollars: 10, firstSaleEdgeMargin: 0.05, expectedPnlDollars: 30, calibratedExpectedPnlDollars: 15, optionSaleCount: 1 },
    ]);
  });
});

describe("computeMonthlyReturns", () => {
  it("compounds each month from the previous month's last value, the first from the start value", () => {
    const months = computeMonthlyReturns(
      [
        { tradingDate: "2024-01-30", accountValue: 1_010_000, baselineValue: 990_000 },
        { tradingDate: "2024-01-31", accountValue: 1_020_000, baselineValue: 980_000 },
        { tradingDate: "2024-02-01", accountValue: 1_071_000, baselineValue: 1_029_000 },
      ],
      1_000_000,
    );
    // No SPY series on these days: its column is null.
    expect(months).toEqual([
      { month: "2024-01", sessionReturn: expect.closeTo(0.02, 12), baselineReturn: expect.closeTo(-0.02, 12), spyBaselineReturn: null },
      { month: "2024-02", sessionReturn: expect.closeTo(0.05, 12), baselineReturn: expect.closeTo(0.05, 12), spyBaselineReturn: null },
    ]);
  });

  it("adds SPY's months when every day carries its value", () => {
    const months = computeMonthlyReturns(
      [
        { tradingDate: "2024-01-31", accountValue: 1_020_000, baselineValue: 980_000, spyBaselineValue: 1_010_000 },
        { tradingDate: "2024-02-01", accountValue: 1_071_000, baselineValue: 1_029_000, spyBaselineValue: 1_030_200 },
      ],
      1_000_000,
    );
    expect(months.map((month) => month.spyBaselineReturn)).toEqual([expect.closeTo(0.01, 12), expect.closeTo(0.02, 12)]);
  });
});

describe("computeCycleAccuracyBands", () => {
  it("groups closed cycles by the edge margin of their first option sold: predicted for their sales vs the cycle's total", () => {
    const bands = computeCycleAccuracyBands([
      cycle({ firstSaleEdgeMargin: -0.05, totalDollars: -50, expectedPnlDollars: -10, optionSaleCount: 1 }),
      cycle({ firstSaleEdgeMargin: 0.25, totalDollars: 400, expectedPnlDollars: 300, calibratedExpectedPnlDollars: 250, optionSaleCount: 3 }),
      cycle({ firstSaleEdgeMargin: 0.29, totalDollars: -100, expectedPnlDollars: 100, calibratedExpectedPnlDollars: 50, optionSaleCount: 1 }),
      // An open cycle and a cycle that sold nothing are in no band.
      cycle({ firstSaleEdgeMargin: 0.25, status: "open", totalDollars: 9_999 }),
      cycle({ firstSaleEdgeMargin: null, totalDollars: 9_999, optionSaleCount: 0 }),
    ]);
    expect(bands.map((band) => [band.label, band.cycleCount, band.tradeCount, band.predictedPnlDollars, band.calibratedPnlDollars, band.realizedPnlDollars])).toEqual([
      ["under 0%", 1, 1, -10, 120, -50],
      ["0–10%", 0, 0, 0, 0, 0],
      ["10–20%", 0, 0, 0, 0, 0],
      ["20–30%", 2, 4, 400, 300, 300],
      ["30% and over", 0, 0, 0, 0, 0],
    ]);
  });
});

describe("computeTradeAccuracyBands", () => {
  it("groups the closed options of a session measured per option by their own edge margin", () => {
    const bands = computeTradeAccuracyBands([trade({ edgeMargin: -0.05, pnlDollars: -50 }), trade({ edgeMargin: 0.25 }), trade({ edgeMargin: 0.3, pnlDollars: 200 }), trade({ edgeMargin: 0.25, pnlDollars: null })]);
    expect(bands.map((band) => [band.label, band.tradeCount, band.realizedPnlDollars])).toEqual([
      ["under 0%", 1, -50],
      ["0–10%", 0, 0],
      ["10–20%", 0, 0],
      ["20–30%", 1, 100],
      ["30% and over", 1, 200],
    ]);
    expect(bands.every((band) => band.cycleCount === null)).toBe(true);
  });
});
