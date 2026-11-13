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

describe("truncateCycleInputAsOf: a leg that grew after the night", () => {
  it("counts only the contracts it had by then, at IBKR's average cost less the later fills'", () => {
    // INTC LEAPS on prod: 10 contracts at $5.3712 today, 1 from 4 Nov without a recorded fill, 2 bought on 5 Nov, 7 on 9 Nov at $5.53 ($3.78).
    const leg = putLeg({
      side: "long", optionType: "call", strike: 70, quantity: 10, entryPrice: 5.3712, entryAt: new Date("2026-11-04T15:36:00Z"), exitPrice: null, exitAt: null, hasClosingTrade: false, expiryDate: "2027-04-16", leaps: true,
      openingFills: [
        { at: new Date("2026-11-05T14:36:00Z"), quantity: 1, price: 4.86, commission: 0.92 },
        { at: new Date("2026-11-05T16:01:00Z"), quantity: 1, price: 4.38, commission: 0.92 },
        { at: new Date("2026-11-09T15:06:00Z"), quantity: 7, price: 5.53, commission: 3.78 },
      ],
    });
    const marks = new Map([["pos-1", { premiumPnl: 0, unrealizedPnl: 0 }]]);
    const asOfSixth = truncateCycleInputAsOf(inputWith([leg]), "2026-11-06", marks).optionLegs[0]!;
    expect(asOfSixth.quantity).toBe(3);
    expect(asOfSixth.entryPrice).toBeCloseTo((5.3712 * 1_000 - (5.53 * 700 + 3.78)) / 300, 10); // $4.988
    expect(asOfSixth.openingFills).toHaveLength(2);
    expect(truncateCycleInputAsOf(inputWith([leg]), "2026-11-04", marks).optionLegs[0]!.quantity).toBe(1);
    expect(truncateCycleInputAsOf(inputWith([leg]), "2026-11-10", marks).optionLegs[0]).toBe(leg);
  });

  it("drops a leg that held nothing yet and shrinks a stock leg to its shares by then", () => {
    const leg = putLeg({ exitPrice: null, exitAt: null, hasClosingTrade: false, openingFills: [{ at: new Date("2026-08-28T15:00:00Z"), quantity: 1, price: 2, commission: 1 }] });
    const stockLeg = { positionId: "pos-2", quantity: 300, entryAt: new Date("2026-08-27T15:00:00Z"), exitAt: null, openingFills: [{ at: new Date("2026-08-27T15:00:00Z"), quantity: 100, price: 50, commission: 1 }, { at: new Date("2026-09-02T15:00:00Z"), quantity: 200, price: 51, commission: 1 }] };
    const truncated = truncateCycleInputAsOf(inputWith([leg], { stockLegs: [stockLeg] }), "2026-08-27", new Map());
    expect(truncated.optionLegs).toHaveLength(0);
    expect(truncated.stockLegs[0]!.quantity).toBe(100);
  });
});
