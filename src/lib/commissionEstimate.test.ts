import { describe, expect, it } from "vitest";
import {
  buildCommissionEstimator,
  buildStockCommissionEstimator,
  closeCommissionRates,
  commissionMinimumOrdersPerBucket,
  commissionTrailingOrderCount,
  contractCountBucket,
  flatCommissionEstimator,
  flatStockCommissionEstimator,
  flatStockCommissionPerShareDollars,
  type FilledOptionOrderCommission,
  type FilledStockOrderCommission,
} from "./commissionEstimate.js";

const sellOrders = (count: number, contracts: number, commissionDollars: number): FilledOptionOrderCommission[] => Array.from({ length: count }, () => ({ side: "sell", contracts, commissionDollars }));

const stockSellOrders = (count: number, shares: number, commissionDollars: number): FilledStockOrderCommission[] => Array.from({ length: count }, () => ({ side: "sell", shares, commissionDollars }));

describe("contractCountBucket", () => {
  it("buckets 1 / 2-4 / 5+", () => {
    expect([1, 2, 4, 5, 51].map(contractCountBucket)).toEqual(["1", "2-4", "2-4", "5+", "5+"]);
  });
});

describe("approved parameters", () => {
  it("looks at the last 50 orders and needs 10 per bucket", () => {
    expect(commissionTrailingOrderCount).toBe(50);
    expect(commissionMinimumOrdersPerBucket).toBe(10);
  });

  it("falls back to $0.005 per share for stock", () => {
    expect(flatStockCommissionPerShareDollars).toBe(0.005);
  });
});

describe("buildCommissionEstimator", () => {
  it("falls back to the flat rate below the minimum orders in the bucket", () => {
    const estimator = buildCommissionEstimator(sellOrders(commissionMinimumOrdersPerBucket - 1, 1, 1.0));
    expect(estimator.perContractDollars("sell", 1)).toBe(flatCommissionEstimator.perContractDollars("sell", 1));
  });

  it("averages commission per contract once the bucket has enough orders", () => {
    const estimator = buildCommissionEstimator([...sellOrders(5, 1, 1.0), ...sellOrders(5, 1, 0.8)]);
    expect(estimator.perContractDollars("sell", 1)).toBeCloseTo(0.9, 10);
  });

  it("keeps sides and size buckets apart", () => {
    const estimator = buildCommissionEstimator([...sellOrders(10, 1, 1.0), ...sellOrders(10, 10, 6.0)]);
    expect(estimator.perContractDollars("sell", 1)).toBeCloseTo(1.0, 10);
    expect(estimator.perContractDollars("sell", 12)).toBeCloseTo(0.6, 10);
    expect(estimator.perContractDollars("sell", 3)).toBe(0.68);
    expect(estimator.perContractDollars("buy", 1)).toBe(0.68);
  });

  it("uses only the newest 50 orders of a bucket (input is newest first)", () => {
    const estimator = buildCommissionEstimator([...sellOrders(50, 1, 1.0), ...sellOrders(50, 1, 9.0)]);
    expect(estimator.perContractDollars("sell", 1)).toBeCloseTo(1.0, 10);
  });

  it("ignores orders with no commission or no contracts", () => {
    const estimator = buildCommissionEstimator([...sellOrders(10, 1, 0), ...sellOrders(10, 0, 5)]);
    expect(estimator.perContractDollars("sell", 1)).toBe(0.68);
  });
});

describe("buildStockCommissionEstimator", () => {
  it("falls back to the flat rate below the minimum orders on the side", () => {
    const estimator = buildStockCommissionEstimator(stockSellOrders(commissionMinimumOrdersPerBucket - 1, 100, 1.0));
    expect(estimator.perShareDollars("sell")).toBe(0.005);
  });

  it("averages commission per share once the side has enough orders, keeping sides apart", () => {
    const estimator = buildStockCommissionEstimator([...stockSellOrders(5, 100, 1.0), ...stockSellOrders(5, 1000, 8.0)]);
    expect(estimator.perShareDollars("sell")).toBeCloseTo(0.009, 10);
    expect(estimator.perShareDollars("buy")).toBe(0.005);
  });

  it("uses only the newest 50 orders of a side and ignores empty ones", () => {
    const estimator = buildStockCommissionEstimator([...stockSellOrders(10, 0, 5), ...stockSellOrders(10, 100, 0), ...stockSellOrders(50, 100, 1.0), ...stockSellOrders(50, 100, 9.0)]);
    expect(estimator.perShareDollars("sell")).toBeCloseTo(0.01, 10);
  });
});

describe("closeCommissionRates", () => {
  it("reads every option side and size bucket plus both stock sides", () => {
    const optionEstimator = buildCommissionEstimator([...sellOrders(10, 1, 1.0), ...sellOrders(10, 10, 6.0)]);
    const stockEstimator = buildStockCommissionEstimator(stockSellOrders(10, 100, 1.2));
    const rates = closeCommissionRates(optionEstimator, stockEstimator);
    expect(rates.optionPerContractDollars.sell["1"]).toBeCloseTo(1.0, 10);
    expect(rates.optionPerContractDollars.sell["2-4"]).toBe(0.68);
    expect(rates.optionPerContractDollars.sell["5+"]).toBeCloseTo(0.6, 10);
    expect(rates.optionPerContractDollars.buy).toEqual({ "1": 0.68, "2-4": 0.68, "5+": 0.68 });
    expect(rates.stockPerShareDollars.sell).toBeCloseTo(0.012, 10);
    expect(rates.stockPerShareDollars.buy).toBe(0.005);
  });

  it("is all flat rates with the flat estimators", () => {
    expect(closeCommissionRates(flatCommissionEstimator, flatStockCommissionEstimator)).toEqual({
      optionPerContractDollars: { buy: { "1": 0.68, "2-4": 0.68, "5+": 0.68 }, sell: { "1": 0.68, "2-4": 0.68, "5+": 0.68 } },
      stockPerShareDollars: { buy: 0.005, sell: 0.005 },
    });
  });
});
