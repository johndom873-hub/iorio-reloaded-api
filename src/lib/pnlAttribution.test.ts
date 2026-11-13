import { describe, expect, it } from "vitest";
import { deriveCycles, type CycleInput, type CycleOptionLeg } from "./cycles.js";
import { attributeTickerCycles } from "./pnlAttribution.js";

function optionLeg(overrides: Partial<CycleOptionLeg>): CycleOptionLeg {
  return {
    id: "leg-1", positionId: "pos-1", side: "short", optionType: "put", strike: 50, quantity: 1, multiplier: 100, entryPrice: 2,
    entryAt: new Date("2026-11-02T15:00:00Z"), exitPrice: null, exitAt: null, closingCommission: 0, hasClosingTrade: false,
    expiryDate: "2026-11-13", expiryClose: null, ...overrides,
  };
}

function input(overrides: Partial<CycleInput>): CycleInput {
  return { optionLegs: [], stockLegs: [], stockTrades: [], dailyCloses: new Map(), lastPrice: null, openPositionPremiumPnl: new Map(), ...overrides };
}

function attribute(cycleInput: CycleInput) {
  return attributeTickerCycles(deriveCycles(cycleInput), cycleInput);
}

describe("attributeTickerCycles", () => {
  it("splits a put's premium into its fills and their commissions (the header's example)", () => {
    // Sold at $2.50 with $1.05 commission (IBKR's average cost $2.4895), bought back at $0.40 with $1.05.
    const buckets = attribute(input({ optionLegs: [optionLeg({ entryPrice: 2.4895, openingCommission: 1.05, exitPrice: 0.4, exitAt: new Date("2026-11-05T15:00:00Z"), closingCommission: 1.05, hasClosingTrade: true })] }));
    expect(buckets.csp.premiumGross).toBeCloseTo(210, 6);
    expect(buckets.csp.commissions).toBeCloseTo(-2.1, 6);
    expect(buckets.csp.total).toBeCloseTo(207.9, 6);
    expect(buckets.csp.unrealized).toBe(0);
    expect(buckets.csp.capital).toBe(0); // closed: nothing in use
  });

  it("counts an open put's collateral as capital and its mark as unrealized", () => {
    const buckets = attribute(input({ optionLegs: [optionLeg({ entryPrice: 2 })], openPositionPremiumPnl: new Map([["pos-1", 120]]) }));
    expect(buckets.csp.capital).toBe(5_000); // $50 strike × 100 shares
    expect(buckets.csp.total).toBeCloseTo(120, 6);
    expect(buckets.csp.unrealized).toBeCloseTo(-80, 6); // the mark row: 120 − the 200 credit
  });

  it("splits a covered call's shares and call into gross figures and commissions, capital at the shares' cost", () => {
    // 100 shares bought at $40 with $1 commission and a call sold at $1.00 with $1 (average cost $0.99) in the same minute;
    // tonight the shares close at $42 and the call's snapshot P&L is +$30.
    const at = new Date("2026-11-10T15:00:00Z");
    const buckets = attribute(
      input({
        optionLegs: [optionLeg({ id: "call", positionId: "cc", optionType: "call", strike: 45, entryPrice: 0.99, openingCommission: 1, entryAt: at })],
        stockLegs: [{ positionId: "cc", quantity: 100, entryAt: at, exitAt: null }],
        stockTrades: [{ at, side: "buy", quantity: 100, price: 40, commission: 1 }],
        dailyCloses: new Map([["2026-11-10", 42]]),
        lastPrice: { date: "2026-11-10", price: 42 },
        openPositionPremiumPnl: new Map([["cc", 30]]),
      }),
    );
    expect(buckets.cc.stockGross).toBeCloseTo(200, 6); // 100 × (42 − 40)
    expect(buckets.cc.premiumGross).toBeCloseTo(31, 6); // the +30 mark before the $1 opening commission
    expect(buckets.cc.commissions).toBeCloseTo(-2, 6);
    expect(buckets.cc.total).toBeCloseTo(229, 6); // 30 + 100 × (42 − 40.01)
    expect(buckets.cc.unrealized).toBeCloseTo(130, 6); // shares +199, call mark 30 − 99
    expect(buckets.cc.capital).toBeCloseTo(4_001, 6); // 100 shares at their $40.01 cost
    expect(buckets.unstructured.total).toBe(0);
  });

  it("keeps a cycle with data flags out of the buckets and its total apart", () => {
    const buckets = attribute(input({ optionLegs: [optionLeg({ exitAt: new Date("2026-11-13T21:00:00Z"), exitPrice: 0 })] }));
    expect(buckets.csp.total).toBe(0);
    expect(buckets.csp.flaggedTotal).toBeCloseTo(200, 6);
    expect(buckets.csp.flagReasons[0]).toMatch(/no expiry-date price bar/);
  });
});
