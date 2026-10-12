import { describe, expect, it } from "vitest";
import { computeAccuracyBands, computeBacktestMetrics, computeDailyReturns, computeDrawdowns, computeMonthlyReturns, computeSortino, type AccountDay, type ClosedTradeFigures } from "./sessionAnalytics.js";

const day = (tradingDate: string, value: number, exposureDollars = 0, interestDollars = 0): AccountDay => ({ tradingDate, value, exposureDollars, interestDollars });

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
    const metrics = computeBacktestMetrics([day("2021-01-04", 1_000_000), day("2026-09-30", 1_418_000)], [], 1_000_000);
    expect(metrics.totalReturn).toBeCloseTo(0.418, 10);
    expect(metrics.cagr).toBeCloseTo(0.0627, 4);
    expect(metrics.tradeCount).toBe(0);
    expect(metrics.winRate).toBeNull();
  });

  it("computes drawdown, capital in use, interest and the trade figures", () => {
    const days = [day("2024-03-01", 1_000_000, 0, 0), day("2024-03-04", 1_010_000, 202_000, 300), day("2024-03-05", 959_500, 191_900, 100)];
    const trades = [
      trade({ pnlDollars: 300, expectedPnlDollars: 200, exposureDollars: 10_000, openedOn: "2024-03-01", settledOn: "2024-03-08", inTheMoneyAtExpiry: false }),
      trade({ pnlDollars: -100, expectedPnlDollars: 200, exposureDollars: 20_000, openedOn: "2024-03-04", settledOn: "2024-03-04", inTheMoneyAtExpiry: true }),
      trade({ pnlDollars: null, settledOn: null, inTheMoneyAtExpiry: null }),
    ];
    const metrics = computeBacktestMetrics(days, trades, 1_000_000);
    expect(metrics.maxDrawdown).toBeCloseTo(959_500 / 1_010_000 - 1, 12);
    expect(metrics.capitalInUse).toBeCloseTo((0 + 0.2 + 0.2) / 3, 12);
    expect(metrics.interestDollars).toBe(400);
    expect(metrics.tradeCount).toBe(3);
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.averageWinDollars).toBe(300);
    expect(metrics.averageLossDollars).toBe(-100);
    expect(metrics.edgeCapture).toBeCloseTo(200 / 400, 12);
    // Σ P&L 200 ÷ (10,000 × 7 days + 20,000 × 1 day) × 365
    expect(metrics.returnOnCapitalInUse).toBeCloseTo((200 / 90_000) * 365, 12);
    expect(metrics.inTheMoneyAtExpiryShare).toBe(0.5);
    expect(metrics.worstMonth).toBeCloseTo(-0.0405, 4);
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
    expect(months).toEqual([
      { month: "2024-01", sessionReturn: expect.closeTo(0.02, 12), baselineReturn: expect.closeTo(-0.02, 12) },
      { month: "2024-02", sessionReturn: expect.closeTo(0.05, 12), baselineReturn: expect.closeTo(0.05, 12) },
    ]);
  });
});

describe("computeAccuracyBands", () => {
  it("groups closed trades by the edge margin at the open", () => {
    const bands = computeAccuracyBands([trade({ edgeMargin: -0.05, pnlDollars: -50 }), trade({ edgeMargin: 0.25 }), trade({ edgeMargin: 0.3, pnlDollars: 200 }), trade({ edgeMargin: 0.25, pnlDollars: null })]);
    expect(bands.map((band) => [band.label, band.tradeCount, band.realizedPnlDollars])).toEqual([
      ["under 0%", 1, -50],
      ["0–10%", 0, 0],
      ["10–20%", 0, 0],
      ["20–30%", 1, 100],
      ["30% and over", 1, 200],
    ]);
  });
});
