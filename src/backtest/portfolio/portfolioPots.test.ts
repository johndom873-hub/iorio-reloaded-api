import { describe, expect, it } from "vitest";
import { floorAllocationPctOf, potDollarsOf, potFiguresOf, suggestAllocations } from "./portfolioPots.js";

describe("the pot table", () => {
  it("works XLE at 10% of $1,000,000 with a 20% allowance in whole lots", () => {
    const potDollars = potDollarsOf(10, 20, 1_000_000);
    expect(potDollars).toBeCloseTo(120_000, 6);
    const figures = potFiguresOf({ potDollars, price: 70.02, stockCommissionDollars: 0.5, firstPositionPct: 80, rebalanceBandPct: 20 });
    expect(figures.lotDollars).toBeCloseTo(7_002.5, 6);
    expect(figures.lotsAtTarget).toBe(13);
    expect(figures.targetReached).toBeCloseTo(91_032.5 / 96_000, 9);
    expect(figures.bandLots).toBeCloseTo(24_000 / 7_002.5, 9);
    expect(figures.bandActs).toBe(true);
    expect(figures.topUpBelowPrice).toBeCloseTo(72_000 / 1_300, 9);
    expect(figures.trimAbovePrice).toBeCloseTo(120_000 / 1_300, 9);
    expect(figures.smallestBandActingPot).toBeCloseTo(35_012.5, 6);
  });

  it("finds a $50,000 pot on a $390 stock holding one lot, its band unable to act until the pot is $195,002.50", () => {
    const figures = potFiguresOf({ potDollars: 50_000, price: 390, stockCommissionDollars: 0.5, firstPositionPct: 80, rebalanceBandPct: 20 });
    expect(figures.lotsAtTarget).toBe(1);
    expect(figures.bandLots).toBeCloseTo(10_000 / 39_000.5, 9);
    expect(figures.bandActs).toBe(false);
    expect(figures.smallestBandActingPot).toBeCloseTo(195_002.5, 6);
  });

  it("finds a $50,000 pot on a $400 stock holding no lot: its $40,000 target is 50 cents short of one", () => {
    const figures = potFiguresOf({ potDollars: 50_000, price: 400, stockCommissionDollars: 0.5, firstPositionPct: 80, rebalanceBandPct: 20 });
    expect(figures.lotsAtTarget).toBe(0);
    expect(figures.topUpBelowPrice).toBeNull();
    expect(figures.smallestOneLotPot).toBeCloseTo(50_000.625, 6);
  });

  it("gives AMD at $504.80 a floor of 21.03% of a $1,000,000 account with a 20% allowance", () => {
    const { smallestBandActingPot } = potFiguresOf({ potDollars: 0, price: 504.8, stockCommissionDollars: 0.5, firstPositionPct: 80, rebalanceBandPct: 20 });
    expect(smallestBandActingPot).toBeCloseTo(252_402.5, 6);
    expect(floorAllocationPctOf(smallestBandActingPot, 20, 1_000_000)).toBeCloseTo(21.0335, 3);
  });
});

describe("the suggested allocations", () => {
  it("gives AMD its floor and the nine others an equal share of the rest", () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({ symbol: `T${index}`, floorPct: 3 }));
    const suggested = suggestAllocations([{ symbol: "AMD", floorPct: 21.03 }, ...nine]);
    expect(suggested.allocationPctBySymbol.get("AMD")).toBeCloseTo(21.03, 9);
    expect(suggested.equalSharePct).toBeCloseTo((100 - 21.03) / 9, 9);
    expect(suggested.allocationPctBySymbol.get("T0")).toBeCloseTo(8.7744, 3);
    expect(suggested.unallocatedPct).toBeCloseTo(0, 9);
  });

  it("is an equal share where every floor fits under it", () => {
    const suggested = suggestAllocations(["A", "B", "C", "D", "E"].map((symbol) => ({ symbol, floorPct: 4 })));
    expect([...suggested.allocationPctBySymbol.values()]).toEqual([20, 20, 20, 20, 20]);
  });

  it("leaves out a ticker whose floor is above 25% as too large, and caps the share, leaving the rest unallocated", () => {
    const suggested = suggestAllocations([{ symbol: "SPY", floorPct: 31.5 }, { symbol: "A", floorPct: 2 }, { symbol: "B", floorPct: 2 }]);
    expect(suggested.tooLarge).toEqual([{ symbol: "SPY", floorPct: 31.5 }]);
    expect([...suggested.allocationPctBySymbol]).toEqual([
      ["A", 25],
      ["B", 25],
    ]);
    expect(suggested.unallocatedPct).toBeCloseTo(50, 9);
  });

  it("says when the floors kept add up to more than 100%", () => {
    const suggested = suggestAllocations(Array.from({ length: 5 }, (_, index) => ({ symbol: `T${index}`, floorPct: 24 })));
    expect(suggested.floorsOverFull).toBe(true);
  });
});
