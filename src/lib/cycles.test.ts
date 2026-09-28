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
