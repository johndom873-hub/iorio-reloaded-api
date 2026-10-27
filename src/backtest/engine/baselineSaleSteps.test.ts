import { describe, expect, it } from "vitest";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { baselineSaleYield, hedgePutCostYield } from "./baselineSaleSteps.js";

const commissionDollarsPerContract = 0.68;

describe("baselineSaleYield", () => {
  it("is the time value net of one contract's commission on the capital, annualized", () => {
    // HOOD $72 Call · 13 Aug 2021 (7DTE) sold @ 2.875 with the stock at 57.81: (287.50 − 0.68) ÷ ((57.81 − 2.875) × 100) ÷ (7 ÷ 365) = 272.2%.
    const { premiumYield } = baselineSaleYield({ isCall: true, fillPrice: 2.875, strike: 72, stockPrice: 57.81, yearsToExpiry: 7 / 365, commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator } });
    expect(premiumYield).toBeCloseTo(2.7224, 4);
  });
});

describe("hedgePutCostYield", () => {
  it("is the time value plus one contract's commission on the stock price, annualized over the Put's days", () => {
    // HOOD $55 Put · 19 Nov 2021 (105DTE) bought @ 16.30 with the stock at 57.81 (out of the money: all time value):
    // (1,630 + 0.68) ÷ 5,781 ÷ (105 ÷ 365) = 98.1% a year.
    expect(hedgePutCostYield({ fillPrice: 16.3, strike: 55, stockPrice: 57.81, dte: 105, commissionDollarsPerContract })).toBeCloseTo(0.98055, 5);
  });

  it("leaves out the in-the-money part, which the Put does not lose", () => {
    // A $60 Put @ 5.00 with the stock at 57.81: 2.19 in the money, 2.81 time value; 30 days: (281 + 0.68) ÷ 5,781 ÷ (30 ÷ 365).
    expect(hedgePutCostYield({ fillPrice: 5, strike: 60, stockPrice: 57.81, dte: 30, commissionDollarsPerContract })).toBeCloseTo(0.592822, 6);
  });

  it("annualizes over at least a day", () => {
    expect(hedgePutCostYield({ fillPrice: 0.5, strike: 50, stockPrice: 50, dte: 0, commissionDollarsPerContract })).toBeCloseTo(((50 + 0.68) / 5_000) * 365, 10);
  });

  it("is null when the purchase cost nothing beyond its in-the-money part, or with no stock price", () => {
    expect(hedgePutCostYield({ fillPrice: 2, strike: 60, stockPrice: 57, dte: 30, commissionDollarsPerContract })).toBeNull();
    expect(hedgePutCostYield({ fillPrice: 1, strike: 50, stockPrice: 0, dte: 30, commissionDollarsPerContract })).toBeNull();
  });
});
