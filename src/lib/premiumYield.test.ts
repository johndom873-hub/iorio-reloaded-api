import { describe, expect, it } from "vitest";
import { coveredCallYieldAfterCosts } from "./premiumYield.js";

describe("coveredCallYieldAfterCosts", () => {
  it("matches the approved worked example", () => {
    const yieldAYear = coveredCallYieldAfterCosts({ bid: 4.1, ask: 4.3, spotPrice: 142.1, daysToExpiry: 10, spreadShareCharged: 0.5 });
    expect(yieldAYear).toBeCloseTo(((4.2 - 0.0568) / (142.1 - 4.2)) * 36.5, 10);
    expect(Math.round(yieldAYear! * 100)).toBe(110);
  });

  it("counts a same-day expiry as one day", () => {
    const sameDay = coveredCallYieldAfterCosts({ bid: 1, ask: 1.2, spotPrice: 100, daysToExpiry: 0, spreadShareCharged: 0 });
    const oneDay = coveredCallYieldAfterCosts({ bid: 1, ask: 1.2, spotPrice: 100, daysToExpiry: 1, spreadShareCharged: 0 });
    expect(sameDay).toBe(oneDay);
  });

  it("returns null without a bid or when the premium reaches the share price", () => {
    expect(coveredCallYieldAfterCosts({ bid: 0, ask: 0.05, spotPrice: 10, daysToExpiry: 5, spreadShareCharged: 0 })).toBeNull();
    expect(coveredCallYieldAfterCosts({ bid: 10, ask: 10.2, spotPrice: 10, daysToExpiry: 5, spreadShareCharged: 0 })).toBeNull();
  });
});
