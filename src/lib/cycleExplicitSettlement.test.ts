import { describe, expect, it } from "vitest";
import { summarizeOpenCycle, type CycleOptionLeg as BreakEvenOptionLeg, type CycleStockTrade } from "./cycleBreakEven.js";
import { deriveCycles, type CycleInput, type CycleOptionLeg } from "./cycles.js";

// An explicit settlement on a leg (`settledAs`) replaces the inference from the expiry-date bar. Live never sets it; a
// simulated book does, because its own rule (in the money by $0.01 = assigned) lands inside the $0.00–0.05 band the
// inference leaves "unclear".

const settledAt = new Date("2026-03-13T20:00:00Z");
const openedAt = new Date("2026-03-02T15:00:00Z");

/** A $50 short put, 1 contract, sold for $1.00 net, settled without a trade on 13 March. */
function settledPut(overrides: Partial<BreakEvenOptionLeg> = {}): BreakEvenOptionLeg {
  return { id: "put", positionId: "position-put", side: "short", optionType: "put", strike: 50, quantity: 1, multiplier: 100, entryPrice: 1, entryAt: openedAt, exitPrice: 0, exitAt: settledAt, closingCommission: 0, hasClosingTrade: false, expiryDate: "2026-03-13", expiryClose: 49.98, positionCloseReason: "assigned", ...overrides };
}

function cycleInput(optionLegs: CycleOptionLeg[], overrides: Partial<CycleInput> = {}): CycleInput {
  return { optionLegs, stockLegs: [], stockTrades: [], dailyCloses: new Map([["2026-03-13", optionLegs[0]!.expiryClose ?? 0]]), lastPrice: { date: "2026-03-16", price: 51 }, openPositionPremiumPnl: new Map(), ...overrides };
}

const assignedShares = { positionId: "position-stock", quantity: 100, entryAt: settledAt, exitAt: null };
const assignmentFill: CycleStockTrade = { at: settledAt, side: "buy", quantity: 100, price: 50, commission: 0 };

describe("deriveCycles with an explicit settlement", () => {
  it("still calls a finish $0.02 in the money unclear when nothing says how it settled (live)", () => {
    const [cycle] = deriveCycles(cycleInput([settledPut()], { stockLegs: [assignedShares] }));
    expect(cycle!.dataFlags.some((flag) => flag.includes("assignment unclear"))).toBe(true);
  });

  it("books the assignment the leg states: shares in at the strike, the put charged the $0.02 it finished in the money", () => {
    const [cycle] = deriveCycles(cycleInput([settledPut({ settledAs: "assigned" })], { stockLegs: [assignedShares], stockTrades: [assignmentFill] }));
    expect(cycle!.dataFlags).toEqual([]);
    expect(cycle!.sharesHeld).toBe(100);
    // Put: $100 premium + 100 × (49.98 − 50) = $98. Shares: in at 49.98, marked at 51 = $102.
    expect(cycle!.buckets.csp.total).toBeCloseTo(98, 8);
    expect(cycle!.buckets.unstructured.total).toBeCloseTo(102, 8);
    // Break-even: ($5,000 at the strike − $100 premium) ÷ 100 shares; the assignment fill is not counted a second time.
    expect(cycle!.breakEvenPerShare).toBeCloseTo(49, 8);
  });

  it("books no shares for a leg that states it expired worthless, with or without a bar", () => {
    for (const expiryClose of [50.4, null]) {
      const cycles = deriveCycles(cycleInput([settledPut({ settledAs: "worthless", expiryClose })]));
      expect(cycles).toHaveLength(1);
      expect(cycles[0]!.status).toBe("closed");
      expect(cycles[0]!.dataFlags).toEqual([]);
      expect(cycles[0]!.total).toBeCloseTo(100, 8);
    }
  });

  it("takes the shares out at the strike for a call that states it was assigned $0.02 in the money", () => {
    const call: CycleOptionLeg = { id: "call", positionId: "position-call", side: "short", optionType: "call", strike: 52, quantity: 1, multiplier: 100, entryPrice: 0.5, entryAt: openedAt, exitPrice: 0, exitAt: settledAt, closingCommission: 0, hasClosingTrade: false, expiryDate: "2026-03-13", expiryClose: 52.02, settledAs: "assigned" };
    const [cycle] = deriveCycles(
      cycleInput([call], { stockLegs: [{ positionId: "position-call", quantity: 100, entryAt: openedAt, exitAt: settledAt }], stockTrades: [{ at: openedAt, side: "buy", quantity: 100, price: 50, commission: 0.5 }], dailyCloses: new Map([["2026-03-02", 50.2], ["2026-03-13", 52.02]]) }),
    );
    expect(cycle!.status).toBe("closed");
    expect(cycle!.dataFlags).toEqual([]);
    // $50 call premium + shares bought at 50.005 a share and called away at 52: 100 × 1.995 = $199.50.
    expect(cycle!.total).toBeCloseTo(50 + 199.5, 8);
  });
});

describe("summarizeOpenCycle with an explicit settlement", () => {
  it("refuses a break-even for a finish $0.02 in the money when nothing says how it settled (live)", () => {
    const summary = summarizeOpenCycle([settledPut()], [assignmentFill], 100);
    expect(summary!.breakEvenPerShare).toBeNull();
    expect(summary!.unavailableReason).toContain("assignment unclear");
  });

  it("uses the stated assignment, counting its fill once: break-even = strike − premium", () => {
    const withFill = summarizeOpenCycle([settledPut({ settledAs: "assigned" })], [assignmentFill], 100)!;
    expect(withFill).toMatchObject({ sharesHeld: 100, sharesAcquired: 100, acquisitionCost: 5000, unavailableReason: null });
    expect(withFill.breakEvenPerShare).toBeCloseTo(49, 8);
    // No fill recorded and no bar at all: the stated assignment alone brings the shares in at the strike.
    const withoutFill = summarizeOpenCycle([settledPut({ settledAs: "assigned", expiryClose: null })], [], 100)!;
    expect(withoutFill.breakEvenPerShare).toBeCloseTo(49, 8);
  });

  it("holds no shares after a leg that states it expired worthless, even with no bar", () => {
    expect(summarizeOpenCycle([settledPut({ settledAs: "worthless", expiryClose: null, positionCloseReason: "expired_worthless" })], [], 0)).toBeNull();
  });
});
