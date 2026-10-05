import { describe, expect, it } from "vitest";
import { deriveCycles, type CycleInput, type CycleOptionLeg, type CycleStockTrade } from "./cycles.js";

// 3 short $104 puts sold 09-22 at 2.59, expired ITM on 09-25 (close 101.40) and were assigned: 300 shares at 104.
const assignedAt = new Date("2026-09-26T01:45:00Z");
function assignedPutLeg(overrides: Partial<CycleOptionLeg> = {}): CycleOptionLeg {
  return {
    id: "put-leg", positionId: "pos-csp", side: "short", optionType: "put", strike: 104, quantity: 3, multiplier: 100, entryPrice: 2.59,
    entryAt: new Date("2026-09-22T14:00:00Z"), exitPrice: null, exitAt: assignedAt, closingCommission: 0, hasClosingTrade: false,
    expiryDate: "2026-09-25", expiryClose: 101.4, ...overrides,
  };
}
function assignmentFill(overrides: Partial<CycleStockTrade> = {}): CycleStockTrade {
  return { at: new Date("2026-09-26T01:44:46Z"), side: "buy", quantity: 300, price: 104, commission: 0, ...overrides };
}
function inputWith(stockTrades: CycleStockTrade[], optionLegs: CycleOptionLeg[] = [assignedPutLeg()]): CycleInput {
  return {
    optionLegs,
    stockLegs: [{ positionId: "pos-stock", quantity: 300, entryAt: assignedAt, exitAt: null }],
    stockTrades,
    dailyCloses: new Map([["2026-09-25", 101.4]]),
    lastPrice: { date: "2026-09-25", price: 101.4 },
    openPositionPremiumPnl: new Map(),
  };
}
function openCycle(input: CycleInput) {
  return deriveCycles(input).find((cycle) => cycle.status === "open")!;
}

describe("put assignment fills", () => {
  it("counts an assigned put's shares once when the worker also recorded IBKR's assignment fill", () => {
    const cycle = openCycle(inputWith([assignmentFill()]));
    expect(cycle.dataFlags).toEqual([]);
    expect(cycle.sharesHeld).toBe(300);
    // Premium 3 x 100 x 2.59 = 777 collected; assignment charges (101.40 - 104) x 300 = -780 to the CSP bucket.
    expect(cycle.buckets.csp.total).toBeCloseTo(-3);
    expect(cycle.total).toBeCloseTo(-3);
  });

  it("gives the same result when no assignment fill was recorded (older assignments)", () => {
    const withFill = openCycle(inputWith([assignmentFill()]));
    const withoutFill = openCycle(inputWith([]));
    expect(withoutFill.dataFlags).toEqual([]);
    expect(withoutFill.sharesHeld).toBe(300);
    expect(withoutFill.total).toBeCloseTo(withFill.total);
  });

  it("keeps a buy that only looks similar: a different price is a genuine purchase", () => {
    const cycle = openCycle(inputWith([assignmentFill({ price: 103 })]));
    expect(cycle.sharesHeld).toBe(600);
    expect(cycle.dataFlags[0]).toContain("ledger says 600 sh held but the open stock legs total 300 sh");
  });

  it("keeps a buy with a different share count, so a partial mismatch still flags instead of hiding", () => {
    const cycle = openCycle(inputWith([assignmentFill({ quantity: 200 })]));
    expect(cycle.dataFlags.length).toBeGreaterThan(0);
  });

  it("keeps a buy executed long after the assignment", () => {
    const cycle = openCycle(inputWith([assignmentFill({ at: new Date("2026-09-30T14:00:00Z") })]));
    expect(cycle.dataFlags.length).toBeGreaterThan(0);
  });

  it("lets each put absorb at most one fill: a second identical buy stays a real purchase", () => {
    const cycle = openCycle(inputWith([assignmentFill(), assignmentFill({ at: new Date("2026-09-26T01:44:47Z") })]));
    expect(cycle.sharesHeld).toBe(600);
  });

  it("does not touch a put that was bought back (a closing trade exists), so its later buy at the strike is real", () => {
    const boughtBack = assignedPutLeg({ hasClosingTrade: true, exitPrice: 0.5 });
    const cycle = openCycle(inputWith([assignmentFill()], [boughtBack]));
    expect(cycle.sharesHeld).toBe(300);
    expect(cycle.dataFlags).toEqual([]);
  });
});

describe("hedge (long option) legs", () => {
  const hedgeLeg = (overrides: Partial<CycleOptionLeg> = {}): CycleOptionLeg => ({
    id: "hedge-leg", positionId: "pos-hedge", side: "long", optionType: "call", strike: 82, quantity: 110, multiplier: 100, entryPrice: 3.918,
    entryAt: new Date("2026-09-20T14:00:00Z"), exitPrice: null, exitAt: null, closingCommission: 0, hasClosingTrade: false,
    expiryDate: "2028-06-16", expiryClose: null, ...overrides,
  });
  const hedgeCost = 3.918 * 110 * 100;
  const baseInput = (optionLegs: CycleOptionLeg[], openPositionPremiumPnl = new Map<string, number>()): CycleInput => ({
    optionLegs, stockLegs: [], stockTrades: [], dailyCloses: new Map([["2026-09-25", 110]]), lastPrice: { date: "2026-09-25", price: 110 }, openPositionPremiumPnl,
  });

  it("a symbol with only a hedge has one cycle, open from the purchase, whose P&L is the mark minus the cost, all in the hedge bucket", () => {
    const cycles = deriveCycles(baseInput([hedgeLeg()], new Map([["pos-hedge", 1465.28]])));
    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    expect(cycle.status).toBe("open");
    expect(cycle.buckets.hedge.capital).toBeCloseTo(hedgeCost, 2);
    expect(cycle.buckets.hedge.total).toBeCloseTo(1465.28, 2);
    expect(cycle.buckets.cc.total).toBe(0);
    expect(cycle.buckets.csp.total).toBe(0);
    expect(cycle.total).toBeCloseTo(1465.28, 2);
  });

  it("a hedge with no nightly mark yet is carried at its cost, not booked as a total loss", () => {
    const cycle = deriveCycles(baseInput([hedgeLeg()]))[0]!;
    expect(cycle.buckets.hedge.total).toBeCloseTo(0, 6);
  });

  it("flags the purchase of a held hedge as unrealized, so its cost and its mark are reported together", () => {
    const cycle = deriveCycles(baseInput([hedgeLeg()], new Map([["pos-hedge", 1465.28]])))[0]!;
    const unrealizedRows = cycle.timeline.filter((row) => row.at === null || row.unrealized === true);
    expect(unrealizedRows).toHaveLength(2);
    expect(unrealizedRows.reduce((sum, row) => sum + row.premium, 0)).toBeCloseTo(1465.28, 2);
    const closed = deriveCycles(baseInput([hedgeLeg({ exitAt: new Date("2026-09-25T20:00:00Z"), exitPrice: 5 })]))[0]!;
    expect(closed.timeline.some((row) => row.unrealized === true)).toBe(false);
  });

  it("sold at 5.00: the cycle closes with (5.00 - 3.918) x 11,000 realized", () => {
    const cycle = deriveCycles(baseInput([hedgeLeg({ exitAt: new Date("2026-09-25T20:00:00Z"), exitPrice: 5, hasClosingTrade: true })]))[0]!;
    expect(cycle.status).toBe("closed");
    expect(cycle.buckets.hedge.total).toBeCloseTo((5 - 3.918) * 11000, 2);
  });

  it("an expired-worthless hedge realises the full premium as a loss", () => {
    const cycle = deriveCycles(baseInput([hedgeLeg({ exitAt: new Date("2026-09-25T20:00:00Z"), exitPrice: 0 })]))[0]!;
    expect(cycle.status).toBe("closed");
    expect(cycle.buckets.hedge.total).toBeCloseTo(-hedgeCost, 2);
  });

  it("never enters the break-even of shares held in the same cycle", () => {
    const withShares = (legs: CycleOptionLeg[]): CycleInput => ({
      ...baseInput(legs),
      stockLegs: [{ positionId: "pos-stock", quantity: 100, entryAt: new Date("2026-09-20T14:00:00Z"), exitAt: null }],
      stockTrades: [{ at: new Date("2026-09-20T14:00:00Z"), side: "buy", quantity: 100, price: 100, commission: 0 }],
    });
    const without = deriveCycles(withShares([]))[0]!;
    const withHedge = deriveCycles(withShares([hedgeLeg()]))[0]!;
    expect(withHedge.breakEvenPerShare).toBeCloseTo(without.breakEvenPerShare!, 6);
  });
});
