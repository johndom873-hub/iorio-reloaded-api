import { describe, expect, it } from "vitest";
import { chooseFillsForPartialClose, weightedAverageFillPrice, type ClosingFill } from "./partialCloseSlice.js";

function fill(id: string, quantity: number, price: number, minute: number): ClosingFill {
  return { id, quantity, price, executedAt: new Date(Date.UTC(2026, 8, 28, 14, minute)) };
}

describe("weightedAverageFillPrice", () => {
  it("weights each fill's price by its quantity (the COHR 80 / 80 / 40 sells)", () => {
    expect(weightedAverageFillPrice([fill("a", 80, 279.8, 0), fill("b", 80, 279.95, 1), fill("c", 40, 279.82, 2)])).toBe(279.864);
  });

  it("is the fill's own price for a single fill", () => {
    expect(weightedAverageFillPrice([fill("a", 100, 118.75, 0)])).toBe(118.75);
  });

  it("rounds to the 4 decimals trades.price carries", () => {
    expect(weightedAverageFillPrice([fill("a", 1, 1.06, 0), fill("b", 2, 1.07, 1)])).toBe(1.0667);
  });
});

describe("chooseFillsForPartialClose", () => {
  const fills = [fill("a", 80, 279.8, 0), fill("b", 80, 279.95, 1), fill("c", 40, 279.82, 2)];

  it("takes whole fills, oldest first, up to the quantity the holding dropped by", () => {
    expect(chooseFillsForPartialClose(fills, 160).map((chosen) => chosen.id)).toEqual(["a", "b"]);
  });

  it("leaves a fill the held report does not yet confirm for a later pass", () => {
    expect(chooseFillsForPartialClose(fills, 100).map((chosen) => chosen.id)).toEqual(["a"]);
  });

  it("takes nothing when even the oldest fill is larger than the drop", () => {
    expect(chooseFillsForPartialClose(fills, 79)).toEqual([]);
  });

  it("stops at the first fill that does not fit rather than skipping to a later, smaller one", () => {
    expect(chooseFillsForPartialClose([fill("a", 80, 1, 0), fill("b", 20, 1, 1)], 50)).toEqual([]);
  });
});
