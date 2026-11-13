import { describe, expect, it } from "vitest";
import type { CycleInput, CycleOptionLeg } from "./cycles.js";
import { attributionMoveRowsForNight, nightCapturedAtOrAfter, nightLedgerCutoffMs, type BookMove } from "./pnlAttributionSnapshots.js";

// A ticker moved Manual → Pluto at 10:23 ET on 11 Nov (15:23 UTC). Every figure below is worked out by hand.
const movedAt = new Date("2026-11-11T15:23:00Z");

function optionLeg(overrides: Partial<CycleOptionLeg>): CycleOptionLeg {
  return {
    id: "call", positionId: "cc", side: "short", optionType: "call", strike: 50, quantity: 1, multiplier: 100, entryPrice: 1,
    entryAt: new Date("2026-11-03T15:00:00Z"), exitPrice: null, exitAt: null, closingCommission: 0, hasClosingTrade: false,
    expiryDate: "2026-11-21", expiryClose: null, ...overrides,
  };
}

// 100 shares bought on 3 Nov at $40 and a $50 Call sold at $1.00; on the move's day a $40 Put sold at 10:00 ET for $2.00,
// bought back at 11:00 ET (after the move), and 100 more shares bought at 12:00 ET onto the same leg.
const input: CycleInput = {
  optionLegs: [
    optionLeg({}),
    optionLeg({ id: "put", positionId: "csp", optionType: "put", strike: 40, entryPrice: 2, entryAt: new Date("2026-11-11T15:00:00Z"), exitPrice: 0.9, exitAt: new Date("2026-11-11T16:00:00Z"), hasClosingTrade: true }),
  ],
  stockLegs: [
    {
      positionId: "cc",
      quantity: 200,
      entryAt: new Date("2026-11-03T15:00:00Z"),
      exitAt: null,
      openingFills: [
        { at: new Date("2026-11-03T15:00:00Z"), quantity: 100, price: 40, commission: 0 },
        { at: new Date("2026-11-11T17:00:00Z"), quantity: 100, price: 46, commission: 0 },
      ],
    },
  ],
  stockTrades: [
    { at: new Date("2026-11-03T15:00:00Z"), side: "buy", quantity: 100, price: 40, commission: 0 },
    { at: new Date("2026-11-11T17:00:00Z"), side: "buy", quantity: 100, price: 46, commission: 0 },
  ],
  dailyCloses: new Map([["2026-11-10", 44]]),
  lastPrice: null,
  openPositionPremiumPnl: new Map(),
};

// The marks of the legs moved: the shares at $45, the Call at $2.50, the Put at $1.20.
const move: BookMove = {
  tickerId: "ticker",
  movedAt,
  fromBook: "manual",
  toBook: "pluto",
  legs: [
    { legId: "shares", legType: "stock", quantity: 100, markPrice: 45 },
    { legId: "call", legType: "option", quantity: 1, markPrice: 2.5 },
    { legId: "put", legType: "option", quantity: 1, markPrice: 1.2 },
  ],
};

describe("the attribution at a move between the books", () => {
  it("cuts the ledger at the move and marks its open legs at their move marks, each bucket stored", () => {
    const rows = attributionMoveRowsForNight("2026-11-11", [move], [{ symbol: "TST", tickerId: "ticker", input }], new Map([["cc", { premiumPnl: -100, unrealizedPnl: 300 }]]));
    const byBucket = Object.fromEntries(rows.map((row) => [row.bucket, row]));
    expect(rows.map((row) => row.bucket).sort()).toEqual(["cc", "csp", "leaps", "unstructured"]);
    expect(rows.every((row) => row.fromBook === "manual" && row.toBook === "pluto" && row.movedAt === movedAt)).toBe(true);
    // CC: the 100 shares held at the move, 100 × (45 − 40) = +$500; the Call (1.00 − 2.50) × 100 = −$150. The later 100 shares are not counted.
    expect(byBucket.cc!.stockGross).toBeCloseTo(500, 6);
    expect(byBucket.cc!.premiumGross).toBeCloseTo(-150, 6);
    expect(byBucket.cc!.total).toBeCloseTo(350, 6);
    // The Put sold that morning, open at the move: (2.00 − 1.20) × 100 = +$80, its buyback after the move not counted.
    expect(byBucket.csp!.total).toBeCloseTo(80, 6);
    expect(byBucket.unstructured!.total).toBe(0);
  });

  it("puts a move in the first night captured at or after it", () => {
    const nights = ["2026-11-10", "2026-11-11", "2026-11-12"];
    const capturedAt = new Map(nights.map((night) => [night, new Date(`${night}T22:30:00Z`)]));
    expect(nightCapturedAtOrAfter(nights, capturedAt, movedAt)).toBe("2026-11-11");
    expect(nightCapturedAtOrAfter(nights, capturedAt, new Date("2026-11-12T01:00:00Z"))).toBe("2026-11-12"); // 20:00 ET, after the 11 Nov snapshot
    expect(nightCapturedAtOrAfter(nights, capturedAt, new Date("2026-11-13T01:00:00Z"))).toBeNull();
  });
});

describe("nightLedgerCutoffMs", () => {
  it("cuts a night's ledger when its values were taken, never after its own midnight (New York)", () => {
    expect(new Date(nightLedgerCutoffMs("2026-11-09", new Date("2026-11-09T22:30:25Z"))).toISOString()).toBe("2026-11-09T22:30:25.000Z"); // 17:30 ET: DRAM's 21:46 ET call-away is the next night's
    expect(new Date(nightLedgerCutoffMs("2026-11-09", new Date("2026-11-10T06:00:00Z"))).toISOString()).toBe("2026-11-10T04:59:59.999Z"); // re-run the next morning
    expect(new Date(nightLedgerCutoffMs("2026-11-09", null)).toISOString()).toBe("2026-11-10T04:59:59.999Z");
  });
});
