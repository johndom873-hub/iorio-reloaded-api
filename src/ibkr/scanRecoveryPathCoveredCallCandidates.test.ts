import { describe, expect, it } from "vitest";
import { estimatedCallDeltaKey, filterStrikesByEstimatedCallDelta } from "./scanRecoveryPathCoveredCallCandidates.js";

describe("filterStrikesByEstimatedCallDelta (quote only what can land in the delta band)", () => {
  const targetWindow = { deltaTargetMin: 0.2, deltaTargetMax: 0.3 };
  const expiryStrikes = [{ expiry: "20261016", strikes: [100, 105, 110, 115, 120] }];

  it("keeps strikes whose archived |delta| is within the band ± margin, drops the rest, keeps unarchived strikes", () => {
    const archived = new Map([
      [estimatedCallDeltaKey("20261016", 100), 0.55],
      [estimatedCallDeltaKey("20261016", 105), 0.38],
      [estimatedCallDeltaKey("20261016", 110), 0.25],
      [estimatedCallDeltaKey("20261016", 115), 0.11],
      // 120 has no archived delta → kept
    ]);
    expect(filterStrikesByEstimatedCallDelta(expiryStrikes, targetWindow, archived)).toEqual([{ expiry: "20261016", strikes: [105, 110, 115, 120] }]);
  });

  it("drops an expiry left with no strikes", () => {
    const archived = new Map([100, 105, 110, 115, 120].map((strike) => [estimatedCallDeltaKey("20261016", strike), 0.7]));
    expect(filterStrikesByEstimatedCallDelta(expiryStrikes, targetWindow, archived)).toEqual([]);
  });

  it("is the identity when there is no archive for today", () => {
    expect(filterStrikesByEstimatedCallDelta(expiryStrikes, targetWindow, new Map())).toEqual(expiryStrikes);
  });
});

describe("estimateCallDeltas", () => {
  it("estimates falling call deltas up the strikes from the 30-day IV, and nothing without an IV", async () => {
    const { estimateCallDeltas } = await import("./scanRecoveryPathCoveredCallCandidates.js");
    const expiryStrikes = [{ expiry: "20261106", strikes: [100, 110, 120] }];
    const today = new Date("2026-10-27T15:00:00Z");
    const estimates = estimateCallDeltas(expiryStrikes, { spotPrice: 100, impliedVolatility: 0.5, riskFreeRate: 0.04, today });
    const deltas = [100, 110, 120].map((strike) => estimates.get(estimatedCallDeltaKey("20261106", strike))!);
    expect(deltas[0]).toBeGreaterThan(0.5);
    expect(deltas[1]).toBeLessThan(deltas[0]!);
    expect(deltas[2]).toBeLessThan(deltas[1]!);
    expect(estimateCallDeltas(expiryStrikes, { spotPrice: 100, impliedVolatility: null, riskFreeRate: 0.04, today }).size).toBe(0);
  });
});
