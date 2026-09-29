import { describe, expect, it } from "vitest";
import { archivedCallDeltaKey, filterStrikesByArchivedCallDelta } from "./scanRecoveryPathCoveredCallCandidates.js";

describe("filterStrikesByArchivedCallDelta (quote only what can land in the delta band)", () => {
  const targetWindow = { deltaTargetMin: 0.2, deltaTargetMax: 0.3 };
  const expiryStrikes = [{ expiry: "20261016", strikes: [100, 105, 110, 115, 120] }];

  it("keeps strikes whose archived |delta| is within the band ± margin, drops the rest, keeps unarchived strikes", () => {
    const archived = new Map([
      [archivedCallDeltaKey("20261016", 100), 0.55],
      [archivedCallDeltaKey("20261016", 105), 0.38],
      [archivedCallDeltaKey("20261016", 110), 0.25],
      [archivedCallDeltaKey("20261016", 115), 0.11],
      // 120 has no archived delta → kept
    ]);
    expect(filterStrikesByArchivedCallDelta(expiryStrikes, targetWindow, archived)).toEqual([{ expiry: "20261016", strikes: [105, 110, 115, 120] }]);
  });

  it("drops an expiry left with no strikes", () => {
    const archived = new Map([100, 105, 110, 115, 120].map((strike) => [archivedCallDeltaKey("20261016", strike), 0.7]));
    expect(filterStrikesByArchivedCallDelta(expiryStrikes, targetWindow, archived)).toEqual([]);
  });

  it("is the identity when there is no archive for today", () => {
    expect(filterStrikesByArchivedCallDelta(expiryStrikes, targetWindow, new Map())).toEqual(expiryStrikes);
  });
});
