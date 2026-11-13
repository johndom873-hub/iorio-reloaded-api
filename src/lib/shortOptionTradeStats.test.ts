import { describe, expect, it } from "vitest";
import type { CycleInput, CycleOptionLeg } from "./cycles.js";
import { closedShortOptionResults, summarizeTradeStats } from "./shortOptionTradeStats.js";

function shortLeg(overrides: Partial<CycleOptionLeg>): CycleOptionLeg {
  return {
    id: "leg", positionId: "pos", side: "short", optionType: "put", strike: 50, quantity: 1, multiplier: 100, entryPrice: 2,
    entryAt: new Date("2026-11-02T15:00:00Z"), exitPrice: 0, exitAt: new Date("2026-11-07T01:00:00Z"), closingCommission: 0,
    hasClosingTrade: false, expiryDate: "2026-11-06", expiryClose: 55, ...overrides,
  };
}

const input = (optionLegs: CycleOptionLeg[]): CycleInput => ({ optionLegs, stockLegs: [], stockTrades: [], dailyCloses: new Map(), lastPrice: null, openPositionPremiumPnl: new Map() });

describe("closedShortOptionResults", () => {
  it("charges an assigned put for its assignment: $2.00 premium on a $50 put, stock at $46 → −$200 (the approved example)", () => {
    const [result] = closedShortOptionResults(input([shortLeg({ expiryClose: 46 })]));
    expect(result).toMatchObject({ bucket: "csp", assigned: true, heldToExpiry: true, grossCredit: 200, grossBuyback: 0 });
    expect(result!.result).toBeCloseTo(-200, 10);
  });

  it("counts a called-away call at its premium only, and a bought-back leg net of the buyback and its commission", () => {
    const [called, boughtBack] = closedShortOptionResults(
      input([
        shortLeg({ id: "call", optionType: "call", strike: 50, entryPrice: 1.5, expiryClose: 58 }),
        shortLeg({ id: "put", entryPrice: 2.4895, openingFillPrice: 2.5, exitPrice: 0.4, closingFillPrice: 0.4, closingCommission: 1.05, hasClosingTrade: true, exitAt: new Date("2026-11-04T15:00:00Z") }),
      ]),
    );
    expect(called).toMatchObject({ bucket: "cc", assigned: true, result: 150 });
    expect(boughtBack!.result).toBeCloseTo(248.95 - 41.05, 10);
    expect(boughtBack).toMatchObject({ assigned: false, heldToExpiry: false, grossCredit: 250, grossBuyback: 40 });
    expect(boughtBack!.daysHeld).toBe(2);
  });

  it("leaves out a leg whose settlement cannot be read, and long options", () => {
    const results = closedShortOptionResults(input([shortLeg({ id: "a", expiryClose: null }), shortLeg({ id: "b", expiryClose: 49.97 }), shortLeg({ id: "c", side: "long" }), shortLeg({ id: "d", exitAt: null })]));
    expect(results).toEqual([]);
  });
});

describe("summarizeTradeStats", () => {
  const leg = (result: number, assigned = false, heldToExpiry = true) => ({ result, grossCredit: 100, grossBuyback: result > 0 ? 0 : 50, assigned, heldToExpiry, daysHeld: 4 });

  it("holds every figure back below 10 closed legs", () => {
    const stats = summarizeTradeStats([leg(50), leg(-20)], "csp");
    expect(stats.closedCount).toBe(2);
    expect(stats.winRatePercent).toEqual({ value: null, have: 2, need: 10 });
    expect(stats.calledAwayRatePercent).toBeNull();
  });

  it("gives win rate, profit factor, premium capture, assignment rate and days held from 10", () => {
    const legs = [...Array.from({ length: 7 }, () => leg(60)), leg(-30, true), leg(-50, true), leg(-40, false, false)];
    const stats = summarizeTradeStats(legs, "csp");
    expect(stats.winRatePercent.value).toBeCloseTo(70, 10);
    expect(stats.profitFactor.value).toBeCloseTo(420 / 120, 10);
    expect(stats.premiumCapturePercent.value).toBeCloseTo(((1_000 - 150) / 1_000) * 100, 10);
    expect(stats.assignmentRatePercent!.value).toBeCloseTo((2 / 9) * 100, 10); // 9 held to expiry, 2 assigned
    expect(stats.averageDaysHeld.value).toBe(4);
  });
});
