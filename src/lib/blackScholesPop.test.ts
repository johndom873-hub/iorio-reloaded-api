import { describe, expect, it } from "vitest";
import { computeSuccessProbability, standardNormalCdf } from "./blackScholesPop.js";

// Reference values computed independently (Python: math.erf, exact to double precision):
//   S=100, threshold 87.5, IV 60%, 45 DTE, r=3.72%: d2 = (ln(100/87.5) + (0.0372 - 0.18)*(45/365)) / (0.6*sqrt(45/365)) -> N(d2) = 0.70893013
//   same with r=0 -> 0.70142114
// The platform's CDF is the Abramowitz-Stegun 7.1.26 approximation (max error 1.5e-7), hence 6 decimals.
describe("computeSuccessProbability", () => {
  it("is N(d2) above the threshold, using the risk-free rate (independent reference value)", () => {
    expect(computeSuccessProbability({ spotPrice: 100, thresholdPrice: 87.5, impliedVolatility: 0.6, daysToExpiry: 45, riskFreeRate: 0.0372 })).toBeCloseTo(0.70893013, 6);
    expect(computeSuccessProbability({ spotPrice: 100, thresholdPrice: 87.5, impliedVolatility: 0.6, daysToExpiry: 45, riskFreeRate: 0 })).toBeCloseTo(0.70142114, 6);
  });

  it("rejects non-physical inputs", () => {
    expect(computeSuccessProbability({ spotPrice: 100, thresholdPrice: 90, impliedVolatility: 0, daysToExpiry: 45, riskFreeRate: 0.04 })).toBeNull();
    expect(computeSuccessProbability({ spotPrice: 100, thresholdPrice: 90, impliedVolatility: 0.6, daysToExpiry: 0, riskFreeRate: 0.04 })).toBeNull();
  });
});

describe("standardNormalCdf", () => {
  it("matches tabulated values", () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 7);
    expect(standardNormalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(standardNormalCdf(-1)).toBeCloseTo(0.158655, 6);
  });
});
