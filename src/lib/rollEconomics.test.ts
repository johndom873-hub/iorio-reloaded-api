import { describe, expect, it } from "vitest";
import { halfSpread, rollCommissionPerShare, sharesPerOptionContract } from "./rollEconomics.js";

// The roll credit floor is per share (premiums and half-spreads are per share), so the
// round-trip commission has to be too. Fixed 2026-09-24: the per-contract figure had been
// added to per-share prices directly.
describe("rollCommissionPerShare", () => {
  it("is twice the per-contract commission, spread over the contract's 100 shares", () => {
    expect(sharesPerOptionContract).toBe(100);
    expect(rollCommissionPerShare(0.68)).toBeCloseTo(0.0136, 12);
    expect(rollCommissionPerShare(1.25)).toBeCloseTo(0.025, 12);
  });
  it("is zero without a trustworthy average (no data, no penalty)", () => {
    expect(rollCommissionPerShare(null)).toBe(0);
  });
  it("sits in the same units as the half-spreads it is added to", () => {
    const floor = rollCommissionPerShare(0.68) + halfSpread(1.0, 1.1) + halfSpread(2.0, 2.2);
    expect(floor).toBeCloseTo(0.0136 + 0.05 + 0.1, 12);
  });
});
