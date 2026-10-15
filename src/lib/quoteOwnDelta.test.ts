import { describe, expect, it } from "vitest";
import { deltaFromQuoteMid, yearsToSessionClose } from "./quoteOwnDelta.js";
import { blackScholesPriceOnForward } from "./impliedVolatilitySurface.js";

describe("yearsToSessionClose", () => {
  it("counts the hours left to today's close, none after it", () => {
    // 15:00 UTC on 21 Oct 2026 is 11:00 EDT: five hours to a 16:00 close, two to a 13:00 half-day close.
    expect(yearsToSessionClose(new Date("2026-10-21T15:00:00Z"), 16 * 60)).toBeCloseTo(5 / 8760, 12);
    expect(yearsToSessionClose(new Date("2026-10-21T15:00:00Z"), 13 * 60)).toBeCloseTo(2 / 8760, 12);
    expect(yearsToSessionClose(new Date("2026-10-21T21:00:00Z"), 16 * 60)).toBe(0);
  });
});

describe("deltaFromQuoteMid", () => {
  const rate = 0.04;
  it("recovers the delta of a quote priced at a known IV", () => {
    const years = 20 / 365;
    const forward = 100 * Math.exp(rate * years);
    const mid = blackScholesPriceOnForward(forward, 95, years, rate, 0.5, false);
    const delta = deltaFromQuoteMid({ bid: mid - 0.02, ask: mid + 0.02, spotPrice: 100, strike: 95, isCall: false, yearsToExpiry: years, riskFreeRate: rate })!;
    expect(delta).toBeLessThan(-0.2);
    expect(delta).toBeGreaterThan(-0.4);
  });

  it("an in-the-money quote at or below its intrinsic value counts as fully in the money; out of the money it is unknown", () => {
    expect(deltaFromQuoteMid({ bid: 4.9, ask: 5.0, spotPrice: 100, strike: 105, isCall: false, yearsToExpiry: 2 / 8760, riskFreeRate: rate })).toBe(-1);
    expect(deltaFromQuoteMid({ bid: 4.9, ask: 5.0, spotPrice: 110, strike: 105, isCall: true, yearsToExpiry: 0, riskFreeRate: rate })).toBe(1);
    expect(deltaFromQuoteMid({ bid: 0.05, ask: 0.1, spotPrice: 100, strike: 105, isCall: true, yearsToExpiry: 0, riskFreeRate: rate })).toBeNull();
  });

  it("needs a two-sided quote", () => {
    expect(deltaFromQuoteMid({ bid: null, ask: 1, spotPrice: 100, strike: 100, isCall: true, yearsToExpiry: 0.01, riskFreeRate: rate })).toBeNull();
    expect(deltaFromQuoteMid({ bid: 1, ask: 1, spotPrice: 100, strike: 100, isCall: true, yearsToExpiry: 0.01, riskFreeRate: rate })).toBeNull();
  });
});
