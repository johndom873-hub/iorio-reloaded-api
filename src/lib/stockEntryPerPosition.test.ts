import { describe, expect, it } from "vitest";
import { allocateStockEntryPerPosition, ownOpeningFillsCost, type PositionStockLeg } from "./stockEntryPerPosition.js";

// INTC 2026-10-15: 200 shares assigned at $100.00 (moved to the $98 covered call), then 100 bought at $92.43 + $1.0903
// commission with the $94 call. IBKR reports one average for all 300: (20,000 + 9,243 + 1.0903) / 300 = 97.4803.
const intcHeldShares = 300;
const intcHeldTotalCost = 300 * 97.4803;

function leg(overrides: Partial<PositionStockLeg> & Pick<PositionStockLeg, "id" | "quantity">): PositionStockLeg {
  return { storedEntryPrice: 97.4803, fromPositionSplit: false, openingFills: [], ...overrides };
}

const boughtWithThe94Call = [{ quantity: 100, price: 92.43, commission: 1.0903 }];

describe("ownOpeningFillsCost", () => {
  it("is the fills' cost per share with their commissions, when they cover the leg's shares", () => {
    expect(ownOpeningFillsCost(boughtWithThe94Call, 100)).toBe(92.4409);
    expect(ownOpeningFillsCost([{ quantity: 60, price: 10, commission: null }, { quantity: 40, price: 11, commission: 1 }], 100)).toBe(10.41);
  });

  it("is unknown when the fills cover fewer shares than the leg holds, or there are none", () => {
    expect(ownOpeningFillsCost(boughtWithThe94Call, 200)).toBeNull();
    expect(ownOpeningFillsCost([], 100)).toBeNull();
  });

  it("covers a leg that has sold part of what it bought: the cost per share of what was bought", () => {
    expect(ownOpeningFillsCost(boughtWithThe94Call, 50)).toBe(92.4409);
  });
});

describe("allocateStockEntryPerPosition", () => {
  it("INTC: the leg with its own fills takes them, the other leg what is left of IBKR's total", () => {
    const allocation = allocateStockEntryPerPosition(
      [leg({ id: "the98", quantity: 200 }), leg({ id: "the94", quantity: 100, openingFills: boughtWithThe94Call })],
      intcHeldShares,
      intcHeldTotalCost,
    );
    expect(allocation).toMatchObject({ kind: "allocated" });
    if (allocation.kind !== "allocated") return;
    expect(allocation.entryPriceByLegId.get("the94")).toBe(92.4409);
    expect(allocation.entryPriceByLegId.get("the98")).toBe(100);
    expect(Math.abs(allocation.driftPerShare)).toBeLessThan(0.0001);
  });

  it("a leg already split keeps its cost even when IBKR's average moved (a sibling sold IBKR's oldest lot)", () => {
    // After the $94 position sold its 100 shares, IBKR holds 200 at (100 x 100 + 100 x 92.4409) / 200 = 96.2205.
    const allocation = allocateStockEntryPerPosition([leg({ id: "the98", quantity: 200, storedEntryPrice: 100, fromPositionSplit: true })], 200, 200 * 96.2205);
    expect(allocation).toMatchObject({ kind: "allocated" });
    if (allocation.kind !== "allocated") return;
    expect(allocation.entryPriceByLegId.get("the98")).toBe(100);
    expect(allocation.driftPerShare).toBeCloseTo(3.7795, 4);
  });

  it("no leg with a cost of its own: skipped, the split would only repeat IBKR's average (INTC before its buy was moved)", () => {
    const allocation = allocateStockEntryPerPosition(
      [leg({ id: "the98", quantity: 200, openingFills: boughtWithThe94Call }), leg({ id: "the94", quantity: 100 })],
      intcHeldShares,
      intcHeldTotalCost,
    );
    expect(allocation).toEqual({ kind: "skipped", reason: "no_known_cost" });
  });

  it("legs that do not add up to what IBKR holds are left alone this pass", () => {
    expect(allocateStockEntryPerPosition([leg({ id: "a", quantity: 200 }), leg({ id: "b", quantity: 100, openingFills: boughtWithThe94Call })], 400, 400 * 97)).toEqual({
      kind: "skipped",
      reason: "share_count",
    });
  });

  it("a cost left over that is not positive is refused", () => {
    expect(allocateStockEntryPerPosition([leg({ id: "a", quantity: 100 }), leg({ id: "b", quantity: 100, openingFills: [{ quantity: 100, price: 300, commission: 0 }] })], 200, 200 * 100)).toEqual({
      kind: "skipped",
      reason: "residual_not_positive",
    });
  });

  it("a lone split leg with no fills of its own keeps its carried cost (re-created on a roll)", () => {
    const allocation = allocateStockEntryPerPosition([leg({ id: "rolled", quantity: 200, storedEntryPrice: 100, fromPositionSplit: true })], 200, 200 * 96.2205);
    expect(allocation).toMatchObject({ kind: "allocated" });
    if (allocation.kind === "allocated") expect(allocation.entryPriceByLegId.get("rolled")).toBe(100);
  });

  it("a lone split leg that gained shares beyond its own fills goes back to IBKR's average", () => {
    expect(allocateStockEntryPerPosition([leg({ id: "grown", quantity: 200, storedEntryPrice: 92.4409, fromPositionSplit: true, openingFills: boughtWithThe94Call })], 200, 200 * 95)).toEqual({
      kind: "ibkr_average",
      reason: "shares_added",
    });
  });
});
