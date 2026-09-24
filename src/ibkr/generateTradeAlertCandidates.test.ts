import { describe, expect, it } from "vitest";
import { archivedDeltaKey, buildTechnicalNote, filterStrikesByArchivedDelta } from "./generateTradeAlertCandidates.js";
import type { SupportResistanceResult } from "../lib/technicalIndicators.js";

function zone(price: number, qualityPct: number, atr: number, touches = 2): SupportResistanceResult["support"] {
  return { price, qualityPct, touches, atr };
}

describe("buildTechnicalNote (Slice 2A rationale annotation)", () => {
  it("returns null when support/resistance couldn't be computed", () => {
    expect(buildTechnicalNote(100, "put", null)).toBeNull();
  });

  it("returns null when the relevant zone is missing", () => {
    const sr: SupportResistanceResult = { support: null, resistance: zone(110, 60, 1) };
    expect(buildTechnicalNote(100, "put", sr)).toBeNull(); // puts check support, which is null here
  });

  it("returns null when the zone quality is below the 40% gate", () => {
    const sr: SupportResistanceResult = { support: zone(99.5, 39.9, 1), resistance: null };
    expect(buildTechnicalNote(100, "put", sr)).toBeNull();
  });

  it("returns null when the strike is farther than 1.0x ATR from the zone", () => {
    const sr: SupportResistanceResult = { support: zone(90, 60, 2), resistance: null }; // 10 away, ATR=2 -> 5x ATR
    expect(buildTechnicalNote(100, "put", sr)).toBeNull();
  });

  it("annotates a cash-secured put strike within 1.0x ATR of a qualifying support zone", () => {
    const sr: SupportResistanceResult = { support: zone(99, 62.3, 1.5, 3), resistance: null };
    const note = buildTechnicalNote(100, "put", sr); // 1 away, ATR=1.5 -> within 1.0x ATR
    expect(note).not.toBeNull();
    expect(note).toContain("support");
    expect(note).toContain("3 touches");
    expect(note).toContain("62.3% quality");
    expect(note).toContain("above"); // strike (100) is above the zone (99)
  });

  it("annotates a covered call strike within 1.0x ATR of a qualifying resistance zone", () => {
    const sr: SupportResistanceResult = { support: null, resistance: zone(101, 58.4, 2, 2) };
    const note = buildTechnicalNote(100, "call", sr); // 1 away, ATR=2 -> within 1.0x ATR
    expect(note).not.toBeNull();
    expect(note).toContain("resistance");
    expect(note).toContain("2 touches");
    expect(note).toContain("below"); // strike (100) is below the zone (101)
  });

  it("checks resistance for calls and support for puts, never the other side", () => {
    const sr: SupportResistanceResult = { support: zone(100, 90, 0.5, 4), resistance: null };
    expect(buildTechnicalNote(100, "call", sr)).toBeNull(); // calls don't consult support
  });

  it("is exactly at the 1.0x ATR boundary (inclusive)", () => {
    const sr: SupportResistanceResult = { support: zone(98, 50, 2, 2), resistance: null };
    expect(buildTechnicalNote(100, "put", sr)).not.toBeNull(); // distance 2 === 1.0 * atr(2)
  });
});

describe("filterStrikesByArchivedDelta (quote only what can land in the delta band)", () => {
  const settings = { deltaTargetMin: 0.2, deltaTargetMax: 0.3 };
  const expiryStrikes = [{ expiry: "20261016", strikes: [100, 105, 110, 115, 120] }];

  it("keeps strikes whose archived |delta| is within the band ± margin, drops the rest, keeps unarchived strikes", () => {
    const archived = new Map([
      [archivedDeltaKey("20261016", 100, "call"), 0.55],
      [archivedDeltaKey("20261016", 105, "call"), 0.38],
      [archivedDeltaKey("20261016", 110, "call"), 0.25],
      [archivedDeltaKey("20261016", 115, "call"), 0.11],
      // 120 has no archived delta → kept
    ]);
    expect(filterStrikesByArchivedDelta(expiryStrikes, "call", settings, archived)).toEqual([{ expiry: "20261016", strikes: [105, 110, 115, 120] }]);
  });

  it("uses the delta's magnitude for puts and drops an expiry left with no strikes", () => {
    const archived = new Map([
      [archivedDeltaKey("20261016", 100, "put"), -0.02],
      [archivedDeltaKey("20261016", 105, "put"), -0.05],
      [archivedDeltaKey("20261016", 110, "put"), -0.6],
      [archivedDeltaKey("20261016", 115, "put"), -0.7],
      [archivedDeltaKey("20261016", 120, "put"), -0.8],
    ]);
    expect(filterStrikesByArchivedDelta(expiryStrikes, "put", settings, archived)).toEqual([]);
  });

  it("is the identity when there is no archive for today", () => {
    expect(filterStrikesByArchivedDelta(expiryStrikes, "call", settings, new Map())).toEqual(expiryStrikes);
  });
});
