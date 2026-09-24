import { describe, expect, it } from "vitest";
import { computeProbabilityOfProfit, computeSuccessProbability, standardNormalCdf } from "./blackScholesPop.js";

// Reference values computed independently (Python: math.erf, exact to double precision):
//   short put, S=100, K=90, premium 2.5, IV 60%, 45 DTE, r=3.72%
//   breakeven 87.5, d2 = (ln(100/87.5) + (0.0372 - 0.18)*(45/365)) / (0.6*sqrt(45/365)) -> N(d2) = 0.70893013
//   same with r=0 -> 0.70142114
// The platform's CDF is the Abramowitz-Stegun 7.1.26 approximation (max error 1.5e-7), hence 6 decimals.
describe("computeProbabilityOfProfit", () => {
  const base = { spotPrice: 100, strike: 90, premium: 2.5, impliedVolatility: 0.6, daysToExpiry: 45, right: "put" as const };

  it("uses the risk-free rate in d2 (independent reference value)", () => {
    expect(computeProbabilityOfProfit({ ...base, riskFreeRate: 0.0372 })).toBeCloseTo(0.70893013, 6);
  });

  it("reduces to the old zero-rate figure when the rate is 0", () => {
    expect(computeProbabilityOfProfit({ ...base, riskFreeRate: 0 })).toBeCloseTo(0.70142114, 6);
  });

  it("is null without a rate, never a silent 0% assumption", () => {
    expect(computeProbabilityOfProfit({ ...base, riskFreeRate: null })).toBeNull();
    expect(computeProbabilityOfProfit({ ...base, riskFreeRate: Number.NaN })).toBeNull();
  });

  it("short call is the complement side: N(-d2) against strike + premium", () => {
    // S=100, K=110, premium 2, IV 60%, 45 DTE, r=3.72%: breakeven 112
    // -> N(-d2) = 0.73286502 (Python reference)
    expect(computeProbabilityOfProfit({ ...base, strike: 110, premium: 2, right: "call", riskFreeRate: 0.0372 })).toBeCloseTo(0.73286502, 6);
  });

  it("rejects non-physical inputs", () => {
    expect(computeProbabilityOfProfit({ ...base, impliedVolatility: 0, riskFreeRate: 0.04 })).toBeNull();
    expect(computeProbabilityOfProfit({ ...base, daysToExpiry: 0, riskFreeRate: 0.04 })).toBeNull();
    expect(computeProbabilityOfProfit({ ...base, strike: 2, premium: 3, riskFreeRate: 0.04 })).toBeNull(); // negative breakeven
  });

  it("shares the P(d2) convention: with the premium set to 0 the put POP equals computeSuccessProbability at the strike", () => {
    const pop = computeProbabilityOfProfit({ ...base, premium: 0, riskFreeRate: 0.0372 });
    const success = computeSuccessProbability({ spotPrice: 100, thresholdPrice: 90, impliedVolatility: 0.6, daysToExpiry: 45, riskFreeRate: 0.0372 });
    expect(pop).toBeCloseTo(success!, 12);
  });
});

describe("standardNormalCdf", () => {
  it("matches tabulated values", () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 7);
    expect(standardNormalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(standardNormalCdf(-1)).toBeCloseTo(0.158655, 6);
  });
});
