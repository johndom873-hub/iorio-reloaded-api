import { describe, expect, it } from "vitest";
import { blackScholesVega, commissionPerContractDollars, computeFrictionCost, computeNetEdge, sharesPerContract, spreadShareCharged, type FrictionInput } from "./optionFriction.js";
import type { VolatilityEdge } from "./volatilityEdge.js";

// Reference values computed independently in Python (vega also cross-checked by a central finite difference of the Black-Scholes price).
const base: FrictionInput = { bid: 3.85, ask: 3.97, forward: 100, strike: 105, yearsToExpiry: 0.25, riskFreeRate: 0.04, impliedVolatility: 0.3 };

describe("blackScholesVega", () => {
  it("matches the independent reference", () => {
    expect(blackScholesVega(100, 105, 0.25, 0.04, 0.3)).toBeCloseTo(19.139753288296685, 8);
  });
  it("is largest near the money and falls in the wings", () => {
    const atMoney = blackScholesVega(100, 100, 0.25, 0.04, 0.3);
    expect(atMoney).toBeGreaterThan(blackScholesVega(100, 130, 0.25, 0.04, 0.3));
    expect(atMoney).toBeGreaterThan(blackScholesVega(100, 75, 0.25, 0.04, 0.3));
  });
});

describe("approved parameters", () => {
  it("charges the whole half-spread and a $0.68 commission per 100-share contract", () => {
    expect(spreadShareCharged).toBe(1);
    expect(commissionPerContractDollars).toBe(0.68);
    expect(sharesPerContract).toBe(100);
  });
});

describe("computeFrictionCost", () => {
  it("is (half-spread + commission per share) / vega, split into its two parts", () => {
    const friction = computeFrictionCost(base)!;
    expect(friction.spreadVolatility).toBeCloseTo(0.003134836645814449, 10);
    expect(friction.commissionVolatility).toBeCloseTo(0.00035528148652563726, 10);
    expect(friction.frictionVolatility).toBeCloseTo(0.0034901181323400863, 10);
    expect(friction.frictionVolatility).toBeCloseTo(friction.spreadVolatility + friction.commissionVolatility, 15);
  });

  it("grows with the spread and shrinks as vega grows", () => {
    const wide = computeFrictionCost({ ...base, bid: 3.5, ask: 4.3 })!;
    expect(wide.spreadVolatility).toBeCloseTo(0.4 / blackScholesVega(100, 105, 0.25, 0.04, 0.3), 12);
    expect(wide.frictionVolatility).toBeGreaterThan(computeFrictionCost(base)!.frictionVolatility);
    const nearMoney = computeFrictionCost({ ...base, strike: 100, bid: 3.85, ask: 3.97 })!;
    expect(nearMoney.frictionVolatility).toBeLessThan(computeFrictionCost(base)!.frictionVolatility);
  });

  it("has no cost estimate (null) without a two-sided quote", () => {
    expect(computeFrictionCost({ ...base, bid: null })).toBeNull();
    expect(computeFrictionCost({ ...base, ask: null })).toBeNull();
    expect(computeFrictionCost({ ...base, bid: 0 })).toBeNull();
    expect(computeFrictionCost({ ...base, bid: 4, ask: 4 })).toBeNull();
    expect(computeFrictionCost({ ...base, bid: 4.1, ask: 4 })).toBeNull();
  });

  it("has no estimate for unusable inputs", () => {
    for (const bad of [{ forward: 0 }, { strike: 0 }, { yearsToExpiry: 0 }, { impliedVolatility: 0 }, { impliedVolatility: -0.1 }]) expect(computeFrictionCost({ ...base, ...bad })).toBeNull();
  });

  it("has no estimate when vega underflows to zero (a far-out-of-the-money strike)", () => {
    expect(computeFrictionCost({ ...base, strike: 5000, bid: 0.01, ask: 0.02, impliedVolatility: 0.05, yearsToExpiry: 0.01 })).toBeNull();
  });
});

describe("computeNetEdge", () => {
  const edge: VolatilityEdge = { impliedVolatility: 0.45, forecastVolatility: 0.4, forecastWindowDays: 63, edge: 0.05, insideFittedRange: true };
  it("subtracts friction from Edge", () => {
    expect(computeNetEdge(edge, computeFrictionCost(base)!)).toBeCloseTo(0.05 - 0.0034901181323400863, 12);
  });
  it("can turn a positive Edge negative when the spread is wide", () => {
    const wide = computeFrictionCost({ ...base, bid: 2.0, ask: 6.0 })!;
    expect(computeNetEdge(edge, wide)).toBeLessThan(0);
  });
});
