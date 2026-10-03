import { OrderAction } from "@stoqey/ib";
import { describe, expect, it } from "vitest";
import type { OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { buildOrderCommissionPreview, computeNetOptionPremiumDollars, estimateOptionLegsCommissionDollars, readWhatIfCommissionRange } from "./orderCommissionPreview.js";
import { flatCommissionEstimator } from "./commissionEstimate.js";

const soldPut: OrderLegPayload = { role: "option", action: OrderAction.SELL, symbol: "AAOI", quantity: 2, unitPrice: 2.5, strike: 30, expiry: "20261120", right: "P" };
const boughtShares: OrderLegPayload = { role: "stock", action: OrderAction.BUY, symbol: "AAOI", quantity: 200, unitPrice: 31 };

describe("readWhatIfCommissionRange", () => {
  it("reads IBKR's second order state: a min/max range with commission itself unset", () => {
    expect(readWhatIfCommissionRange({ minCommission: 0.61756915, maxCommission: 1.68794915 })).toEqual({ minDollars: 0.61756915, maxDollars: 1.68794915 });
  });
  it("ignores the first order state's placeholder commission of 0", () => {
    expect(readWhatIfCommissionRange({ commission: 0 })).toBeNull();
  });
  it("treats a single usable commission as a range of one value", () => {
    expect(readWhatIfCommissionRange({ commission: 1.42 })).toEqual({ minDollars: 1.42, maxDollars: 1.42 });
  });
  it("rejects missing, negative and the IBKR unset sentinel", () => {
    for (const bad of [{}, { commission: -1 }, { minCommission: NaN, maxCommission: 1 }, { minCommission: 1.7976931348623157e308, maxCommission: 1.7976931348623157e308 }]) expect(readWhatIfCommissionRange(bad)).toBeNull();
  });
});

describe("premium and estimate", () => {
  it("nets sold minus bought premium over option legs only", () => {
    expect(computeNetOptionPremiumDollars([soldPut, boughtShares])).toBe(500);
    expect(computeNetOptionPremiumDollars([soldPut, { ...soldPut, action: OrderAction.BUY, unitPrice: 1 }])).toBe(300);
  });
  it("estimates option legs per contract, leaving the stock leg out", () => {
    expect(estimateOptionLegsCommissionDollars([soldPut, boughtShares], flatCommissionEstimator)).toBeCloseTo(1.36, 10);
  });
});

describe("buildOrderCommissionPreview", () => {
  const common = { estimator: flatCommissionEstimator, warnThresholdPct: 5 };

  it("uses the what-if maximum, keeps the minimum, and does not warn when commission is a small share", () => {
    const preview = buildOrderCommissionPreview({ ...common, legs: [soldPut], whatIfCommission: { minDollars: 0.9, maxDollars: 1.5 }, whatIfFailureReason: null });
    expect(preview).toMatchObject({ source: "ibkr_what_if", commissionDollars: 1.5, commissionMinDollars: 0.9, netPremiumDollars: 500, netCreditAfterCommissionDollars: 498.5, warn: false, estimateReason: null });
    expect(preview.commissionSharePctOfPremium).toBeCloseTo(0.3, 10);
  });

  it("warns above the threshold", () => {
    const preview = buildOrderCommissionPreview({ ...common, legs: [{ ...soldPut, unitPrice: 0.2 }], whatIfCommission: { minDollars: 1, maxDollars: 2 }, whatIfFailureReason: null });
    expect(preview.commissionSharePctOfPremium).toBeCloseTo(5, 10);
    expect(preview.warn).toBe(false);
    expect(buildOrderCommissionPreview({ ...common, legs: [{ ...soldPut, unitPrice: 0.2 }], whatIfCommission: { minDollars: 1, maxDollars: 2.1 }, whatIfFailureReason: null }).warn).toBe(true);
  });

  it("falls back to the labelled estimate and says why, noting an excluded stock leg", () => {
    const preview = buildOrderCommissionPreview({ ...common, legs: [soldPut, boughtShares], whatIfCommission: null, whatIfFailureReason: "IBKR what-if timed out." });
    expect(preview).toMatchObject({ source: "estimate", estimateReason: "IBKR what-if timed out.", estimateExcludesStockLeg: true });
    expect(preview.commissionDollars).toBeCloseTo(1.36, 10);
  });

  it("always warns on a net debit", () => {
    const debit: OrderLegPayload = { ...soldPut, action: OrderAction.BUY };
    expect(buildOrderCommissionPreview({ ...common, legs: [debit], whatIfCommission: { minDollars: 0.5, maxDollars: 1 }, whatIfFailureReason: null }).warn).toBe(true);
  });
});
