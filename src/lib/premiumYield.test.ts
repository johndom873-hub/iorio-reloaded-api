import { describe, expect, it } from "vitest";
import { coveredCallYieldAfterCosts } from "./premiumYield.js";

describe("coveredCallYieldAfterCosts", () => {
  it("matches the worked example", () => {
    // Sold on a Monday for the Friday after next: 10 sessions, × 252 ÷ 10.
    const yieldAYear = coveredCallYieldAfterCosts({ bid: 4.1, ask: 4.3, spotPrice: 142.1, sessionsHeld: 10, spreadShareCharged: 0.5 });
    expect(yieldAYear).toBeCloseTo(((4.2 - 0.0568) / (142.1 - 4.2)) * 25.2, 10);
    expect(Math.round(yieldAYear! * 1000)).toBe(757);
  });

  it("counts a same-day expiry as one session, and never less", () => {
    // $0.68 commission and no spread cost: (1.10 − 0.0068) ÷ (100 − 1.10) × 252.
    const sameDay = coveredCallYieldAfterCosts({ bid: 1, ask: 1.2, spotPrice: 100, sessionsHeld: 1, spreadShareCharged: 0 });
    expect(sameDay).toBeCloseTo(((1.1 - 0.0068) / (100 - 1.1)) * 252, 10);
    expect(coveredCallYieldAfterCosts({ bid: 1, ask: 1.2, spotPrice: 100, sessionsHeld: 0, spreadShareCharged: 0 })).toBe(sameDay);
  });

  it("returns null without a bid or when the premium reaches the share price", () => {
    expect(coveredCallYieldAfterCosts({ bid: 0, ask: 0.05, spotPrice: 10, sessionsHeld: 5, spreadShareCharged: 0 })).toBeNull();
    expect(coveredCallYieldAfterCosts({ bid: 10, ask: 10.2, spotPrice: 10, sessionsHeld: 5, spreadShareCharged: 0 })).toBeNull();
  });
});
