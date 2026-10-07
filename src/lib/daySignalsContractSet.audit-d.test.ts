import { describe, expect, it } from "vitest";
import { daySignalsRerankMinimumGapMs, daySignalsRerankTriggerFraction, daySignalsUnpooledRecheckIntervalMs, decideRerank, type RerankDecisionInput } from "./daySignalsContractSet.js";

// Audit D (2026-10-07): decideRerank corner cases beyond daySignalsContractSet.test.ts.
const nowMs = Date.UTC(2026, 9, 7, 16, 0);
const minutes = (count: number) => count * 60_000;
const base: RerankDecisionInput = { spotPrice: 100, referenceSpotPrice: 100, atmImpliedVolatility: 0.25, lastLookAtMs: null, firstSeenAtMs: nowMs - minutes(5), pooled: true, nowMs };

describe("decideRerank — audit D", () => {
  it("uses the constants the owner approved: 15-minute gap, 60-minute unpooled re-check", () => {
    expect(daySignalsRerankMinimumGapMs).toBe(15 * 60_000);
    expect(daySignalsUnpooledRecheckIntervalMs).toBe(60 * 60_000);
  });

  it("switches from the 1% floor to half the one-day move at ATM IV = 0.02 x sqrt(252) (~31.7%)", () => {
    const crossoverIv = (0.01 * Math.sqrt(252)) / 0.5;
    expect(daySignalsRerankTriggerFraction(crossoverIv - 0.001)).toBe(0.01);
    expect(daySignalsRerankTriggerFraction(crossoverIv + 0.001)).toBeGreaterThan(0.01);
  });

  it("fires on a move of exactly 1% on the floor (100 -> 101 and 100 -> 99)", () => {
    expect(decideRerank({ ...base, spotPrice: 101 })).toBe("price");
    expect(decideRerank({ ...base, spotPrice: 99 })).toBe("price");
  });

  // Floating point: (10.1 - 10) / 10 = 0.009999999999999964 < 0.01, so a move of exactly 1% is missed for many
  // reference prices. "At least 1%" should fire here.
  it("fires on a move of exactly 1% whatever the reference price (10.00 -> 10.10)", () => {
    expect(decideRerank({ ...base, referenceSpotPrice: 10, spotPrice: 10.1 })).toBe("price");
    expect(decideRerank({ ...base, referenceSpotPrice: 11.11, spotPrice: 11.11 * 1.01 })).toBe("price");
  });

  it("allows a look exactly 15 minutes after the last one and not a millisecond earlier", () => {
    const moved = { ...base, spotPrice: 120 };
    expect(decideRerank({ ...moved, lastLookAtMs: nowMs - daySignalsRerankMinimumGapMs + 1 })).toBeNull();
    expect(decideRerank({ ...moved, lastLookAtMs: nowMs - daySignalsRerankMinimumGapMs })).toBe("price");
  });

  it("treats a last look stamped in the future (clock skew between processes) as inside the gap", () => {
    expect(decideRerank({ ...base, spotPrice: 120, lastLookAtMs: nowMs + minutes(1) })).toBeNull();
  });

  it("gives no timed look when neither a last look nor a first sight is known", () => {
    expect(decideRerank({ ...base, pooled: false, lastLookAtMs: null, firstSeenAtMs: null })).toBeNull();
  });

  it("times an unpooled ticker from its last look, not its first sight, once it has one", () => {
    expect(decideRerank({ ...base, pooled: false, firstSeenAtMs: nowMs - minutes(300), lastLookAtMs: nowMs - minutes(59) })).toBeNull();
    expect(decideRerank({ ...base, pooled: false, firstSeenAtMs: nowMs - minutes(300), lastLookAtMs: nowMs - minutes(60) })).toBe("timed");
  });

  it("never fires for a non-positive or missing reference, spot or IV, even when a timed look is long overdue", () => {
    const overdue = { ...base, pooled: false, lastLookAtMs: nowMs - minutes(600) };
    expect(decideRerank({ ...overdue, referenceSpotPrice: 0 })).toBeNull();
    expect(decideRerank({ ...overdue, referenceSpotPrice: -5 })).toBeNull();
    expect(decideRerank({ ...overdue, spotPrice: 0 })).toBeNull();
    expect(decideRerank({ ...overdue, atmImpliedVolatility: Number.NaN })).toBeNull();
    expect(decideRerank({ ...overdue, atmImpliedVolatility: -0.3 })).toBeNull();
  });

  it("a pooled ticker never gets a timed look however long since it was seen", () => {
    expect(decideRerank({ ...base, pooled: true, firstSeenAtMs: nowMs - minutes(600), lastLookAtMs: null })).toBeNull();
  });
});
