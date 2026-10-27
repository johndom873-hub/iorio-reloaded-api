import { describe, expect, it } from "vitest";
import { computeBacktestMetrics, computeCycleAccuracyBands, computeDailyReturns, computeDrawdowns, computeMonthlyReturns, computePnlSources, computeSortino, computeTradeAccuracyBands, cycleFiguresOf, type AccountDay, type ClosedTradeFigures, type CycleFigures } from "./sessionAnalytics.js";
import type { BacktestCycle, BacktestPositionLeg } from "./backtestTypes.js";

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

describe("computePnlSources", () => {
  const bucket = (premium: number, stock = 0) => ({ premium, stock, total: premium + stock, capital: 0 });
  const buckets = (cc: [number, number], hedge: number, csp: number, unstructuredStock: number): Pick<BacktestCycle, "buckets"> => ({ buckets: { cc: bucket(...cc), hedge: bucket(hedge), csp: bucket(csp), unstructured: bucket(0, unstructuredStock) } });
  const leg = (overrides: Partial<BacktestPositionLeg>): BacktestPositionLeg => ({ legId: "leg", parentLegId: null, legType: "stock", side: "long", quantity: 100, optionType: null, strike: null, expiry: null, multiplier: 1, entryPrice: 10, entryAt: "2026-03-03T15:00:00.000Z", exitPrice: null, exitAt: null, settledAs: null, expiryClose: null, dteAtEntry: null, realizedPnlDollars: null, priceScale: 1, ...overrides });
  const tradingDates = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"];
  // Shares from Tuesday on, still held; a Call sold Tuesday that expired Friday at 16:00 ET; a hedge Put bought and sold on Monday.
  const positions = [
    { strategyKey: "unstructured" as const, legs: [leg({})] },
    { strategyKey: "covered_call" as const, legs: [leg({ exitAt: "2026-03-04T20:00:00.000Z" }), leg({ legType: "option", side: "short", optionType: "call", multiplier: 100, quantity: 1, exitAt: "2026-03-06T21:00:00.000Z" })] },
    { strategyKey: "hedge" as const, legs: [leg({ legType: "option", optionType: "put", multiplier: 100, quantity: 1, entryAt: "2026-03-02T15:00:00.000Z", exitAt: "2026-03-02T19:00:00.000Z" })] },
  ];
  const metrics = { startValue: 100_000, endValue: 120_000, cagr: 0.1, interestDollars: 1_000 };

  it("splits the account's P&L into shares, Calls and hedge, each with its part of the CAGR and its days held", () => {
    const sources = computePnlSources({ metrics, tradingDates, cycles: [buckets([3_000, 5_000], -1_500, 500, 2_000), buckets([1_000, 0], -500, 0, 4_000)], positions, callSaleYields: [0.5, 1.2, 0.8], hedgeCostYields: [0.4, 0.2] })!;
    // Options: Calls 4,000, hedge -2,000, Puts sold 500; the shares are the rest after 1,000 of interest: 20,000 - 1,000 - 2,500.
    expect(sources.shares).toEqual({ pnlDollars: 16_500, cagrPart: expect.closeTo(0.0825, 12), daysHeldShare: 0.8 });
    // The Call counts its expiry Friday: Tuesday to Friday.
    expect(sources.coveredCalls).toEqual({ pnlDollars: 4_000, cagrPart: expect.closeTo(0.02, 12), daysHeldShare: 0.8, quotedYieldMedian: 0.8, quotedCount: 3 });
    expect(sources.hedge).toEqual({ pnlDollars: -2_000, cagrPart: expect.closeTo(-0.01, 12), daysHeldShare: 0.2, quotedCostMedian: expect.closeTo(0.3, 10), quotedCount: 2 });
    // With the Puts sold and interest, the parts add up to the CAGR.
    expect(sources.shares!.cagrPart! + sources.coveredCalls!.cagrPart! + sources.hedge!.cagrPart! + (0.1 * 500) / 20_000 + (0.1 * 1_000) / 20_000).toBeCloseTo(0.1, 12);
  });

  it("leaves out what was never held, gives no CAGR part when the account made nothing, and nothing without cycles", () => {
    const sharesOnly = computePnlSources({ metrics: { ...metrics, endValue: 100_000 }, tradingDates, cycles: [buckets([0, 0], 0, 0, 0)], positions: [positions[0]!], callSaleYields: [], hedgeCostYields: [] })!;
    expect(sharesOnly).toEqual({ shares: { pnlDollars: -1_000, cagrPart: null, daysHeldShare: 0.8 }, coveredCalls: null, hedge: null, leaps: null });
    expect(computePnlSources({ metrics, tradingDates, cycles: [], positions, callSaleYields: [], hedgeCostYields: [] })).toBeNull();
  });

  it("gives Vol Farmer v2's LEAPS a part of its own, from the cycles' leaps bucket, and none to the hedge", () => {
    // A LEAPS Call bought Wednesday and still held: its mark is 3,000 under what it cost.
    const leaps = { strategyKey: "leaps" as const, legs: [leg({ legType: "option", optionType: "call", multiplier: 100, quantity: 10, entryAt: "2026-03-04T15:00:00.000Z" })] };
    const sources = computePnlSources({ metrics, tradingDates, cycles: [{ buckets: { ...buckets([1_000, 0], 0, 0, 0).buckets, leaps: bucket(-3_000) } }], positions: [positions[0]!, positions[1]!, leaps], callSaleYields: [], hedgeCostYields: [] })!;
    expect(sources.leaps).toEqual({ pnlDollars: -3_000, cagrPart: expect.closeTo(-0.015, 12), daysHeldShare: 0.6 });
    expect(sources.hedge).toBeNull();
    // The shares are the rest after interest and every option's: 20,000 - 1,000 - (1,000 - 3,000).
    expect(sources.shares!.pnlDollars).toBe(21_000);
  });
});
