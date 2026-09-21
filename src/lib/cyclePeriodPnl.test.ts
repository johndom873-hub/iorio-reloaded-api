import { describe, expect, it } from "vitest";
import { deriveCycles, type CycleInput, type CycleOptionLeg } from "./cycles.js";
import { truncateCycleInputAsOf } from "./cyclePeriodPnl.js";

function putLeg(overrides: Partial<CycleOptionLeg> = {}): CycleOptionLeg {
  return {
    id: "leg-1", positionId: "pos-1", side: "short", optionType: "put", strike: 100, quantity: 1, multiplier: 100, entryPrice: 2,
    entryAt: new Date("2026-08-27T15:00:00Z"), exitPrice: 0.5, exitAt: new Date("2026-09-04T15:00:00Z"), closingCommission: 0,
    hasClosingTrade: true, expiryDate: "2026-09-04", expiryClose: 110, ...overrides,
  };
}

function inputWith(optionLegs: CycleOptionLeg[], overrides: Partial<CycleInput> = {}): CycleInput {
  return {
    optionLegs, stockLegs: [], stockTrades: [], dailyCloses: new Map([["2026-08-31", 105], ["2026-09-04", 110]]),
    lastPrice: { date: "2026-09-04", price: 110 }, openPositionPremiumPnl: new Map(), ...overrides,
  };
}

describe("truncateCycleInputAsOf", () => {
  it("reopens a leg closed after the baseline and drops its later close", () => {
    const truncated = truncateCycleInputAsOf(inputWith([putLeg()]), "2026-08-31", new Map([["pos-1", { premiumPnl: 120, unrealizedPnl: 120 }]]));
    expect(truncated.optionLegs[0]!.exitAt).toBeNull();
    expect(truncated.optionLegs[0]!.exitPrice).toBeNull();
    expect(truncated.lastPrice).toEqual({ date: "2026-08-31", price: 105 });
    expect(truncated.openPositionPremiumPnl.get("pos-1")).toBe(120);
  });

  it("drops legs and fills that happen after the baseline", () => {
    const later = putLeg({ id: "leg-2", positionId: "pos-2", entryAt: new Date("2026-09-02T15:00:00Z") });
    const truncated = truncateCycleInputAsOf(
      inputWith([putLeg(), later], { stockTrades: [{ at: new Date("2026-09-03T15:00:00Z"), side: "buy", quantity: 100, price: 100, commission: 0 }] }),
      "2026-08-31",
      new Map(),
    );
    expect(truncated.optionLegs.map((leg) => leg.id)).toEqual(["leg-1"]);
    expect(truncated.stockTrades).toEqual([]);
  });

  it("uses the total unrealized of a pure short-put position when the snapshot has no premium split", () => {
    const truncated = truncateCycleInputAsOf(inputWith([putLeg()]), "2026-08-31", new Map([["pos-1", { premiumPnl: null, unrealizedPnl: 80 }]]));
    expect(truncated.openPositionPremiumPnl.get("pos-1")).toBe(80);
  });

  it("marks a call position without a premium split as unavailable (its total may hold stock P&L)", () => {
    const truncated = truncateCycleInputAsOf(inputWith([putLeg({ optionType: "call" })]), "2026-08-31", new Map([["pos-1", { premiumPnl: null, unrealizedPnl: 80 }]]));
    expect(truncated.openPositionPremiumPnlUnavailable!.has("pos-1")).toBe(true);
  });

  it("marks an open position with no snapshot on the baseline day as unavailable, and its cycle is flagged", () => {
    const truncated = truncateCycleInputAsOf(inputWith([putLeg()]), "2026-08-31", new Map());
    expect(truncated.openPositionPremiumPnlUnavailable!.has("pos-1")).toBe(true);
    expect(deriveCycles(truncated)[0]!.dataFlags).toEqual(["no option mark for the open put $100"]);
  });

  it("gives period P&L = total now - total at the baseline for a put opened before and closed after it", () => {
    const input = inputWith([putLeg()]);
    const now = deriveCycles(input)[0]!;
    const atBaseline = deriveCycles(truncateCycleInputAsOf(input, "2026-08-31", new Map([["pos-1", { premiumPnl: 120, unrealizedPnl: 120 }]])))[0]!;
    // credit 200 at open, bought back at 0.5 (-50): 150 in total; marked at +120 on the baseline day, so 30 is earned after it.
    expect(now.buckets.csp.total).toBeCloseTo(150);
    expect(atBaseline.buckets.csp.total).toBeCloseTo(120);
    expect(now.buckets.csp.total - atBaseline.buckets.csp.total).toBeCloseTo(30);
  });
});
