import { describe, expect, it } from "vitest";
import { blackScholesVega, commissionPerContractDollars, sharesPerContract } from "./optionFriction.js";

// Reference values computed independently in Python (vega also cross-checked by a central finite difference of the Black-Scholes price).

describe("blackScholesVega", () => {
  it("matches the independent reference", () => {
    expect(blackScholesVega(100, 105, 0.25, 0.04, 0.3)).toBeCloseTo(19.139753288296685, 8);
  });
  it("is largest near the money and falls in the wings", () => {
    const atMoney = blackScholesVega(100, 100, 0.25, 0.04, 0.3);
    expect(atMoney).toBeGreaterThan(blackScholesVega(100, 130, 0.25, 0.04, 0.3));
    expect(atMoney).toBeGreaterThan(blackScholesVega(100, 75, 0.25, 0.04, 0.3));
  });
  it("underflows to zero far out of the money (Signals then excludes the contract as no_vega)", () => {
    expect(blackScholesVega(100, 5000, 0.01, 0.04, 0.05)).toBe(0);
  });
});

describe("approved parameters", () => {
  it("charges a $0.68 commission per 100-share contract", () => {
    expect(commissionPerContractDollars).toBe(0.68);
    expect(sharesPerContract).toBe(100);
  });
});
