import { describe, expect, it } from "vitest";
import { buildCommissionEstimator, commissionMinimumOrdersPerBucket, commissionTrailingOrderCount, contractCountBucket, flatCommissionEstimator, type FilledOptionOrderCommission } from "./commissionEstimate.js";

const sellOrders = (count: number, contracts: number, commissionDollars: number): FilledOptionOrderCommission[] => Array.from({ length: count }, () => ({ side: "sell", contracts, commissionDollars }));

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
