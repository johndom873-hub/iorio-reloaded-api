import { describe, expect, it } from "vitest";
import { computeUncompensatedShare, simulationPathCount } from "./uncompensatedShare.js";

// Reference values from an independent pure-Python simulation (plain Gaussian draws, 20,000 paths, no antithetics).
// Monte-Carlo noise is ~0.01, so each check uses a ±0.03 band.
const cases = [
  { name: "ATM monthly, 16% vol (the paper's own case: ~25% timing)", spot: 100, strike: 100, days: 21, vol: 0.16, delta: 0.5092, equity: 0.7342, timing: 0.2482 },
  { name: "10% OTM, 30 days, 60% vol", spot: 100, strike: 110, days: 30, vol: 0.6, delta: 0.3606, equity: 0.8556, timing: 0.1377 },
  { name: "20% OTM, 10 days, 60% vol", spot: 100, strike: 120, days: 10, vol: 0.6, delta: 0.0714, equity: 0.9853, timing: 0.0123 },
  { name: "5% OTM, 60 days, 30% vol", spot: 100, strike: 105, days: 60, vol: 0.3, delta: 0.3974, equity: 0.8234, timing: 0.1721 },
];

describe("computeUncompensatedShare", () => {
  for (const testCase of cases) {
    it(`matches the independent simulation: ${testCase.name}`, () => {
      const shares = computeUncompensatedShare({ spotPrice: testCase.spot, strike: testCase.strike, yearsToExpiry: testCase.days / 252, volatility: testCase.vol })!;
      expect(shares.entryDelta).toBeCloseTo(testCase.delta, 3);
      expect(Math.abs(shares.timingShare - testCase.timing)).toBeLessThan(0.03);
      expect(Math.abs(shares.equityShare - testCase.equity)).toBeLessThan(0.03);
    });
  }

  it("the three shares add up to exactly 1", () => {
    for (const testCase of cases) {
      const shares = computeUncompensatedShare({ spotPrice: testCase.spot, strike: testCase.strike, yearsToExpiry: testCase.days / 252, volatility: testCase.vol })!;
      expect(shares.equityShare + shares.timingShare + shares.volatilityShare).toBeCloseTo(1, 12);
    }
  });

  it("is deterministic: the same inputs always give the same answer", () => {
    const input = { spotPrice: 100, strike: 105, yearsToExpiry: 30 / 365, volatility: 0.5 };
    expect(computeUncompensatedShare(input)).toEqual(computeUncompensatedShare(input));
  });

  it("shrinks as the strike moves further out of the money", () => {
    const share = (strike: number) => computeUncompensatedShare({ spotPrice: 100, strike, yearsToExpiry: 30 / 252, volatility: 0.6 })!.timingShare;
    expect(share(100)).toBeGreaterThan(share(110));
    expect(share(110)).toBeGreaterThan(share(120));
    expect(share(120)).toBeGreaterThan(0);
  });

  it("is larger for a longer-dated option at the same out-of-the-money strike", () => {
    const share = (days: number) => computeUncompensatedShare({ spotPrice: 100, strike: 110, yearsToExpiry: days / 252, volatility: 0.6 })!.timingShare;
    expect(share(60)).toBeGreaterThan(share(10) + 0.05);
  });

  it("depends only on the strike relative to spot: scaling both leaves the shares unchanged", () => {
    const small = computeUncompensatedShare({ spotPrice: 100, strike: 108, yearsToExpiry: 25 / 252, volatility: 0.5 })!;
    const large = computeUncompensatedShare({ spotPrice: 1000, strike: 1080, yearsToExpiry: 25 / 252, volatility: 0.5 })!;
    expect(large.timingShare).toBeCloseTo(small.timingShare, 9);
    expect(large.entryDelta).toBeCloseTo(small.entryDelta, 9);
  });

  it("uses an even path count (antithetic pairs)", () => {
    expect(simulationPathCount % 2).toBe(0);
  });

  it("returns null for unusable inputs", () => {
    const good = { spotPrice: 100, strike: 105, yearsToExpiry: 0.1, volatility: 0.4 };
    for (const bad of [{ spotPrice: 0 }, { strike: 0 }, { yearsToExpiry: 0 }, { volatility: 0 }, { volatility: -0.2 }, { strike: Number.NaN }, { yearsToExpiry: Number.POSITIVE_INFINITY }]) {
      expect(computeUncompensatedShare({ ...good, ...bad })).toBeNull();
    }
  });

  it("returns null for a deep in-the-money call, which has almost no variance to apportion", () => {
    expect(computeUncompensatedShare({ spotPrice: 100, strike: 20, yearsToExpiry: 30 / 252, volatility: 0.3 })).toBeNull();
  });

  it("still takes one step for an option with less than a trading day left", () => {
    const shares = computeUncompensatedShare({ spotPrice: 100, strike: 100, yearsToExpiry: 0.0005, volatility: 0.5 });
    expect(shares).not.toBeNull();
    expect(shares!.timingShare).toBeGreaterThanOrEqual(-1e-9); // one step: delta cannot have drifted before the only move
  });

  it("handles a one-day option (a single step)", () => {
    const shares = computeUncompensatedShare({ spotPrice: 100, strike: 101, yearsToExpiry: 1 / 252, volatility: 0.5 })!;
    expect(Number.isFinite(shares.timingShare)).toBe(true);
    expect(shares.equityShare + shares.timingShare + shares.volatilityShare).toBeCloseTo(1, 12);
  });
});
