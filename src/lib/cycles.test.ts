import { describe, expect, it } from "vitest";
import { deriveCycles, deriveOpenCycle, type CycleInput, type CycleOptionLeg, type CycleStockTrade } from "./cycles.js";

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

describe("timeline expiry", () => {
  it("carries the contract's expiry on option rows and none on stock rows", () => {
    const cycle = openCycle(inputWith([assignmentFill()]));
    expect(cycle.timeline.map((row) => [row.label, row.expiryDate])).toEqual([
      ["Sold put @ 2.59", "2026-09-25"],
      ["Put assigned: shares bought at the strike", "2026-09-25"],
      ["Marked to the 2026-09-25 close", null],
    ]);
  });

  it("gives an open position's mark row the expiry its legs share, and none when they differ", () => {
    const openPut = (id: string, expiryDate: string) => assignedPutLeg({ id, positionId: "pos-open", exitAt: null, expiryDate });
    const markRow = (legs: CycleOptionLeg[]) => {
      const input = { ...inputWith([], legs), stockLegs: [], openPositionPremiumPnl: new Map([["pos-open", 100]]) };
      return openCycle(input).timeline.find((row) => row.at === null)!;
    };
    expect(markRow([openPut("a", "2026-10-16"), openPut("b", "2026-10-16")]).expiryDate).toBe("2026-10-16");
    expect(markRow([openPut("a", "2026-10-16"), openPut("b", "2026-10-23")]).expiryDate).toBeNull();
  });
});

describe("mark rows", () => {
  // 2 short $100 puts sold 10-12 at 1.34 (credit 268), snapshot 10-13, while the latest daily bar is 10-14.
  const openPut = assignedPutLeg({ positionId: "pos-open", strike: 100, quantity: 2, entryPrice: 1.34, entryAt: new Date("2026-10-12T14:00:00Z"), exitAt: null, expiryDate: "2026-10-16", expiryClose: null });
  const putInput = (overrides: Partial<CycleInput> = {}): CycleInput => ({
    optionLegs: [openPut],
    stockLegs: [],
    stockTrades: [],
    dailyCloses: new Map([["2026-10-12", 101.35], ["2026-10-13", 102.81], ["2026-10-14", 103.4]]),
    lastPrice: { date: "2026-10-14", price: 103.4 },
    openPositionPremiumPnl: new Map([["pos-open", 203.43]]),
    openPositionMarkDate: new Map([["pos-open", "2026-10-13"]]),
    ...overrides,
  });

  it("dates an open option's mark row by its snapshot and prices the stock at that day's close", () => {
    const markRow = openCycle(putInput()).timeline.find((row) => row.at === null)!;
    expect(markRow.markDate).toBe("2026-10-13");
    expect(markRow.stockPrice).toBe(102.81);
    expect(markRow.premium).toBeCloseTo(203.43 - 268, 6);
  });

  it("shows no stock price rather than another day's when the snapshot's day has no close", () => {
    const markRow = openCycle(putInput({ dailyCloses: new Map([["2026-10-12", 101.35], ["2026-10-14", 103.4]]) })).timeline.find((row) => row.at === null)!;
    expect(markRow.stockPrice).toBeNull();
  });

  it("lists the mark rows in date order: an older snapshot before a newer close", () => {
    const sharesAndPut = putInput({ stockLegs: [{ positionId: "pos-open", quantity: 100, entryAt: new Date("2026-10-12T14:00:00Z"), exitAt: null }], stockTrades: [{ at: new Date("2026-10-12T14:00:00Z"), side: "buy", quantity: 100, price: 101.35, commission: 0 }] });
    const markRows = openCycle(sharesAndPut).timeline.filter((row) => row.at === null);
    expect(markRows.map((row) => [row.instrument, row.markDate])).toEqual([["option", "2026-10-13"], ["stock", "2026-10-14"]]);
  });

  it("dates a share mark row by the close it uses", () => {
    const shareMark = openCycle(inputWith([assignmentFill()])).timeline.find((row) => row.at === null)!;
    expect(shareMark.markDate).toBe("2026-09-25");
  });

  it("reports what each open option position is counted at: its snapshot, else its credit, and nothing once closed", () => {
    expect(openCycle(putInput()).openOptionPositions).toEqual([{ positionId: "pos-open", premiumPnl: 203.43, bucket: "csp", optionType: "put", quantity: 200, strike: 100, expiryDate: "2026-10-16" }]);
    expect(openCycle(putInput({ openPositionPremiumPnl: new Map() })).openOptionPositions[0]!.premiumPnl).toBeCloseTo(268, 6);
    const boughtBack = deriveCycles(putInput({ optionLegs: [{ ...openPut, exitAt: new Date("2026-10-13T15:00:00Z"), exitPrice: 0.5, hasClosingTrade: true }] }));
    expect(boughtBack.map((cycle) => [cycle.status, cycle.openOptionPositions])).toEqual([["closed", []]]);
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

describe("shares bought and sold within the same moment", () => {
  // 500 shares held since 10 September at 20.00; on the 15th a buy-write's 2,400 shares are bought at 23.32 and, in
  // the same look of a simulated book, sold at 23.30: both fills carry the same instant.
  const heldSince = new Date("2026-09-10T15:00:00Z");
  const sameMoment = new Date("2026-09-15T15:00:00Z");
  const input: CycleInput = {
    optionLegs: [],
    stockLegs: [
      { positionId: "pos-held", quantity: 500, entryAt: heldSince, exitAt: null },
      { positionId: "pos-buy-write", quantity: 2400, entryAt: sameMoment, exitAt: sameMoment },
    ],
    stockTrades: [
      { at: heldSince, side: "buy", quantity: 500, price: 20, commission: 0 },
      { at: sameMoment, side: "buy", quantity: 2400, price: 23.32, commission: 0 },
      { at: sameMoment, side: "sell", quantity: 2400, price: 23.3, commission: 0 },
    ],
    dailyCloses: new Map([["2026-09-16", 21]]),
    lastPrice: { date: "2026-09-16", price: 21 },
    openPositionPremiumPnl: new Map(),
  };

  it("takes the shares in before selling them: nothing is sold that was never acquired, and the 500 stay held", () => {
    const cycle = openCycle(input);
    expect(cycle.dataFlags).toEqual([]);
    expect(cycle.sharesHeld).toBe(500);
    // 500 × (21 − 20) on the shares still held + 2,400 × (23.30 − 23.32) on the round trip.
    expect(cycle.total).toBeCloseTo(500 - 48, 6);
  });

  it("still flags a sale larger than every share the group and the cycle acquired", () => {
    const cycle = openCycle({ ...input, stockTrades: input.stockTrades.map((trade) => (trade.side === "sell" ? { ...trade, quantity: 3000 } : trade)) });
    expect(cycle.dataFlags).toContain("100 sh sold/called away that the ledger never acquired");
  });
});

describe("deriveOpenCycle", () => {
  // The open cycle alone, as deriveCycles(input).find(open) gives it, without the closed ones.
  const optionLeg = (id: string, positionId: string, entryIso: string, exitIso: string | null, overrides: Partial<CycleOptionLeg> = {}): CycleOptionLeg => ({
    id, positionId, side: "short", optionType: "put", strike: 100, quantity: 1, multiplier: 100, entryPrice: 1.5, entryAt: new Date(entryIso), exitPrice: exitIso === null ? null : 0, exitAt: exitIso === null ? null : new Date(exitIso), closingCommission: 0, hasClosingTrade: false, expiryDate: (exitIso ?? entryIso).slice(0, 10), expiryClose: 104, ...overrides,
  });
  const dailyCloses = new Map([["2026-09-01", 102], ["2026-09-04", 104], ["2026-09-11", 103], ["2026-09-18", 101]]);
  const inputOf = (optionLegs: CycleOptionLeg[]): CycleInput => ({ optionLegs, stockLegs: [], stockTrades: [], dailyCloses, lastPrice: { date: "2026-09-18", price: 101 }, openPositionPremiumPnl: new Map([["p3", -40]]) });

  it("is the open one of all cycles, closed ones before it", () => {
    const input = inputOf([optionLeg("l1", "p1", "2026-09-01T14:00:00Z", "2026-09-04T20:00:00Z"), optionLeg("l2", "p2", "2026-09-08T14:00:00Z", "2026-09-11T20:00:00Z"), optionLeg("l3", "p3", "2026-09-15T14:00:00Z", null, { expiryDate: "2026-09-26" })]);
    const open = deriveOpenCycle(input);
    expect(open).not.toBeNull();
    expect(open).toStrictEqual(deriveCycles(input).find((cycle) => cycle.status === "open"));
  });

  it("is null when every cycle is closed, or there is none", () => {
    expect(deriveOpenCycle(inputOf([optionLeg("l1", "p1", "2026-09-01T14:00:00Z", "2026-09-04T20:00:00Z")]))).toBeNull();
    expect(deriveOpenCycle(inputOf([]))).toBeNull();
  });
});
