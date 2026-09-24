import { describe, expect, it } from "vitest";
import { computeRecoveryProjection } from "./evaluateRecoveryPathForPosition.js";

// Approved 2026-08-31, premium scaled to a 30-day month 2026-09-24:
//   monthly premium = premium x 100 x contracts x (30 / dte)
//   months to recover = ceil(unrealized loss / monthly premium)
describe("computeRecoveryProjection", () => {
  it("scales a 45-DTE candidate's premium down to 30 days", () => {
    // 300 shares bought at 120, now 100: loss 6,000. Candidate $3.00 premium, 45 DTE, 3 contracts.
    // monthly = 3 x 100 x 3 x (30/45) = 600 -> ceil(6000/600) = 10 months (the old formula said 900/month, 7 months)
    const projection = computeRecoveryProjection({ entryPrice: 120, currentPrice: 100, shares: 300, contractsAvailable: 3, candidate: { premium: 3, dte: 45 } });
    expect(projection.unrealizedLoss).toBe(6000);
    expect(projection.monthlyPremium).toBeCloseTo(600, 10);
    expect(projection.monthsToRecover).toBe(10);
  });

  it("scales a 15-DTE candidate's premium up to 30 days", () => {
    const projection = computeRecoveryProjection({ entryPrice: 50, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: { premium: 1, dte: 15 } });
    expect(projection.monthlyPremium).toBeCloseTo(200, 10);
    expect(projection.monthsToRecover).toBe(3); // ceil(500 / 200)
  });

  it("is unchanged for a 30-DTE candidate", () => {
    const projection = computeRecoveryProjection({ entryPrice: 50, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: { premium: 1, dte: 30 } });
    expect(projection.monthlyPremium).toBeCloseTo(100, 10);
    expect(projection.monthsToRecover).toBe(5);
  });

  it("no candidate or a non-positive DTE gives no projection; no loss gives 0 months", () => {
    expect(computeRecoveryProjection({ entryPrice: 50, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: null })).toEqual({ unrealizedLoss: 500, monthlyPremium: null, monthsToRecover: null });
    expect(computeRecoveryProjection({ entryPrice: 50, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: { premium: 1, dte: 0 } }).monthlyPremium).toBeNull();
    expect(computeRecoveryProjection({ entryPrice: 40, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: { premium: 1, dte: 30 } }).monthsToRecover).toBe(0);
  });
});
