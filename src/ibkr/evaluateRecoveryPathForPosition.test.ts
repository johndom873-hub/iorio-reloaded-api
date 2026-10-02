import { describe, expect, it } from "vitest";
import { chooseRecoveryCostBasis, computeRecoveryProjection } from "./evaluateRecoveryPathForPosition.js";

// Approved 2026-08-31, premium scaled to a 30-day month 2026-09-24:
//   monthly premium = premium x 100 x contracts x (30 / dte)
//   months to recover = ceil(unrealized loss / monthly premium)
describe("computeRecoveryProjection", () => {
  it("scales a 45-DTE candidate's premium down to 30 days", () => {
    // 300 shares bought at 120, now 100: loss 6,000. Candidate $3.00 premium, 45 DTE, 3 contracts.
    // monthly = 3 x 100 x 3 x (30/45) = 600 -> ceil(6000/600) = 10 months (the old formula said 900/month, 7 months)
    const projection = computeRecoveryProjection({ costBasisPerShare: 120, currentPrice: 100, shares: 300, contractsAvailable: 3, candidate: { premium: 3, dte: 45 } });
    expect(projection.unrealizedLoss).toBe(6000);
    expect(projection.monthlyPremium).toBeCloseTo(600, 10);
    expect(projection.monthsToRecover).toBe(10);
  });

  it("scales a 15-DTE candidate's premium up to 30 days", () => {
    const projection = computeRecoveryProjection({ costBasisPerShare: 50, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: { premium: 1, dte: 15 } });
    expect(projection.monthlyPremium).toBeCloseTo(200, 10);
    expect(projection.monthsToRecover).toBe(3); // ceil(500 / 200)
  });

  it("is unchanged for a 30-DTE candidate", () => {
    const projection = computeRecoveryProjection({ costBasisPerShare: 50, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: { premium: 1, dte: 30 } });
    expect(projection.monthlyPremium).toBeCloseTo(100, 10);
    expect(projection.monthsToRecover).toBe(5);
  });

  it("no candidate or a non-positive DTE gives no projection; no loss gives 0 months", () => {
    expect(computeRecoveryProjection({ costBasisPerShare: 50, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: null })).toEqual({ unrealizedLoss: 500, monthlyPremium: null, monthsToRecover: null });
    expect(computeRecoveryProjection({ costBasisPerShare: 50, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: { premium: 1, dte: 0 } }).monthlyPremium).toBeNull();
    expect(computeRecoveryProjection({ costBasisPerShare: 40, currentPrice: 45, shares: 100, contractsAvailable: 1, candidate: { premium: 1, dte: 30 } }).monthsToRecover).toBe(0);
  });
});

describe("chooseRecoveryCostBasis", () => {
  it("uses the cycle break-even, which already nets the premium collected on the shares (assigned put: strike 120 - premium 1.40 = 118.60, not the 120 entry)", () => {
    expect(chooseRecoveryCostBasis(120, 118.6)).toEqual({ costBasisPerShare: 118.6, costBasisSource: "cycle_break_even" });
  });

  it("falls back to the average entry price when the cycle break-even cannot be trusted", () => {
    expect(chooseRecoveryCostBasis(120, null)).toEqual({ costBasisPerShare: 120, costBasisSource: "entry_price" });
  });

  it("a stock price between the break-even and the entry is not a loss to recover", () => {
    const { costBasisPerShare } = chooseRecoveryCostBasis(120, 118.6);
    expect(computeRecoveryProjection({ costBasisPerShare, currentPrice: 119.5, shares: 200, contractsAvailable: 2, candidate: { premium: 1, dte: 30 } }).unrealizedLoss).toBe(0);
  });
});
