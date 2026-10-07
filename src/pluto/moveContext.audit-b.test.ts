import { describe, expect, it } from "vitest";
import { computeMoveContext, expectedDailyMovePct } from "./moveContext.js";

// Audit B (2026-10-07): expectedDailyMovePct extracted from computeMoveContext and shared with the day-move limit.
describe("expectedDailyMovePct", () => {
  it("is forecast × 100 / √252", () => {
    expect(expectedDailyMovePct(0.5)).toBeCloseTo(3.1497, 4);
    expect(expectedDailyMovePct(0.666)).toBeCloseTo(4.1954, 3); // NOK-ish: 3× ≈ 12.6%
  });

  it("is null for null, zero, negative or NaN forecasts", () => {
    expect(expectedDailyMovePct(null)).toBeNull();
    expect(expectedDailyMovePct(0)).toBeNull();
    expect(expectedDailyMovePct(-0.2)).toBeNull();
    // NaN > 0 is false, so NaN is null too.
    expect(expectedDailyMovePct(Number.NaN)).toBeNull();
  });

  it("computeMoveContext reports the same figure and divides today's move by it", () => {
    const context = computeMoveContext({ bars: [], forecastVolatility: 0.5, dayChangePct: -6.3, ivRank: null });
    expect(context.expectedDailyMovePct).toBe(expectedDailyMovePct(0.5));
    expect(context.dayMoveSigmas).toBeCloseTo(-6.3 / expectedDailyMovePct(0.5)!, 10);
  });
});
