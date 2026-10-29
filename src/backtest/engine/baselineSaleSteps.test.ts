import { describe, expect, it } from "vitest";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { baselineSaleYield, hedgePutCostYield, hedgePutCostYieldOnCalendarDays } from "./baselineSaleSteps.js";

const commissionDollarsPerContract = 0.68;

describe("baselineSaleYield", () => {
  it("is the time value net of one contract's commission on the capital, annualized over the sessions held", () => {
    // HOOD $72 Call · 13 Aug 2021 (7DTE) sold @ 2.875 on Friday 6 August with the stock at 57.81, held 6 sessions (6 to 13
    // August): (287.50 − 0.68) ÷ ((57.81 − 2.875) × 100) × 252 ÷ 6 = 219.3%.
    const { premiumYield } = baselineSaleYield({ isCall: true, fillPrice: 2.875, strike: 72, stockPrice: 57.81, sessionsHeld: 6, commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator } });
    expect(premiumYield).toBeCloseTo(2.1929, 4);
  });
});

describe("hedgePutCostYield", () => {
  it("is the time value plus one contract's commission on the stock price, annualized over the sessions held", () => {
    // HOOD $55 Put · 19 Nov 2021 (105DTE) bought @ 16.30 on Friday 6 August with the stock at 57.81 (out of the money: all
    // time value), held 75 sessions (18 in August, 21 in September with Labor Day closed, 21 in October, 15 in November):
    // (1,630 + 0.68) ÷ 5,781 × 252 ÷ 75 = 94.8% a year.
    expect(hedgePutCostYield({ fillPrice: 16.3, strike: 55, stockPrice: 57.81, sessionsHeld: 75, commissionDollarsPerContract })).toBeCloseTo(0.94777, 5);
  });

  it("leaves out the in-the-money part, which the Put does not lose", () => {
    // A $60 Put @ 5.00 with the stock at 57.81: 2.19 in the money, 2.81 time value; 21 sessions: (281 + 0.68) ÷ 5,781 × 252 ÷ 21.
    expect(hedgePutCostYield({ fillPrice: 5, strike: 60, stockPrice: 57.81, sessionsHeld: 21, commissionDollarsPerContract })).toBeCloseTo((281.68 / 5_781) * (252 / 21), 10);
  });

  it("annualizes over at least a session", () => {
    expect(hedgePutCostYield({ fillPrice: 0.5, strike: 50, stockPrice: 50, sessionsHeld: 0, commissionDollarsPerContract })).toBeCloseTo(((50 + 0.68) / 5_000) * 252, 10);
  });

  it("is null when the purchase cost nothing beyond its in-the-money part, or with no stock price", () => {
    expect(hedgePutCostYield({ fillPrice: 2, strike: 60, stockPrice: 57, sessionsHeld: 21, commissionDollarsPerContract })).toBeNull();
    expect(hedgePutCostYield({ fillPrice: 1, strike: 50, stockPrice: 0, sessionsHeld: 21, commissionDollarsPerContract })).toBeNull();
  });

  it("over calendar days, at least one, as a purchase recorded before engine 4 shows it", () => {
    // The same HOOD Put over its 105 days: (1,630 + 0.68) ÷ 5,781 ÷ (105 ÷ 365) = 98.1% a year.
    expect(hedgePutCostYieldOnCalendarDays({ fillPrice: 16.3, strike: 55, stockPrice: 57.81, dte: 105, commissionDollarsPerContract })).toBeCloseTo(0.98055, 5);
    expect(hedgePutCostYieldOnCalendarDays({ fillPrice: 0.5, strike: 50, stockPrice: 50, dte: 0, commissionDollarsPerContract })).toBeCloseTo(((50 + 0.68) / 5_000) * 365, 10);
    expect(hedgePutCostYieldOnCalendarDays({ fillPrice: 2, strike: 60, stockPrice: 57, dte: 30, commissionDollarsPerContract })).toBeNull();
  });
});
