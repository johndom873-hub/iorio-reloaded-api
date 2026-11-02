import { describe, expect, it } from "vitest";
import { bandAt, largestPotOfDay, oneTickerPotShareOfAccount, potFittingDayShare, smallestPotFor, targetReachedAt, targetReachedOverDays } from "./analysisPotSizing.js";

// The examples are the v4 formula sheet's (approved by Marcelo 2026-11-01).
describe("Vol Farmer v4 pot sizing (F2–F4)", () => {
  it("the pot is 1.2× the account with one ticker at a 20% excess allowance", () => {
    expect(oneTickerPotShareOfAccount({ excessAllowancePct: 20 })).toBeCloseTo(1.2, 12);
    expect(oneTickerPotShareOfAccount({ excessAllowancePct: 0 })).toBeCloseTo(1, 12);
  });

  it("F2: a $240 high gives a $30,000.63 pot, so a $25,000.52 account", () => {
    const smallest = smallestPotFor(240, 0.8, 1.2);
    expect(smallest.potDollars).toBeCloseTo(30_000.625, 9);
    expect(smallest.accountDollars).toBeCloseTo(25_000.52, 2);
  });

  it("F3: a $120,000 pot at $180 holds 5 lots, 93.8% of the $96,000 target", () => {
    expect(targetReachedAt(120_000, 180, 0.8)).toMatchObject({ lots: 5, lotDollars: 18_000.5, sharesDollars: 90_002.5, targetDollars: 96_000 });
    expect(targetReachedAt(120_000, 180, 0.8).shareOfTarget).toBeCloseTo(90_002.5 / 96_000, 12);
    // A lot dearer than the target: no lot, 0%.
    expect(targetReachedAt(120_000, 1_000, 0.8)).toMatchObject({ lots: 0, shareOfTarget: 0 });
    // The median over the days, and the range of what the whole lots cost: at $240 only 3 lots fit ($72,001.50).
    expect(targetReachedOverDays(120_000, [180, 240, 300], 0.8)).toEqual({ medianShareOfTarget: targetReachedAt(120_000, 300, 0.8).shareOfTarget, sharesDollarsLow: 72_001.5, sharesDollarsHigh: 90_002.5 });
  });

  it("F4: 150 contracts the previous session gives L = 30; at $50 that's $187,519", () => {
    expect(largestPotOfDay(30, 50, 0.8)).toBeCloseTo(187_518.75, 9);
  });

  it("F4's figure: the largest pot that fits on at least 80% of the days", () => {
    // Ten days: the 8th largest fits on 8 of 10.
    expect(potFittingDayShare([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBe(30);
    // 83 days: the 67th largest (⌈66.4⌉).
    const days = Array.from({ length: 83 }, (_, index) => index + 1);
    expect(potFittingDayShare(days)).toBe(17);
    expect(potFittingDayShare([])).toBeNull();
  });

  it("F24: AAPL's $405,251 pot has a $324,201 target and a $303,938–$344,464 band", () => {
    const band = bandAt(405_251, 246.85, 0.8, 5);
    expect(band.floorDollars).toBeCloseTo(303_938.25, 6);
    expect(band.topDollars).toBeCloseTo(344_463.35, 6);
    // 13 lots at $246.85 fit the target; one more would be 14 lots.
    expect(band.lots).toBe(13);
    expect(band.oneMoreLotDollars).toBeCloseTo(14 * 24_685.5, 6);
  });
});
