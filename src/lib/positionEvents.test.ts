import { describe, expect, it } from "vitest";
import { mergeSlicedLegsForOpenedEvent, type PositionEventLeg } from "./positionEvents.js";

const stockLeg = (quantity: number, entryPrice: number, exitPrice: number | null): PositionEventLeg => ({
  legType: "stock",
  side: "long",
  quantity,
  optionType: null,
  strikePrice: null,
  expiryDate: null,
  entryPrice,
  exitPrice,
});

const putLeg = (quantity: number, strikePrice: number, entryPrice: number): PositionEventLeg => ({
  legType: "option",
  side: "short",
  quantity,
  optionType: "put",
  strikePrice,
  expiryDate: "2026-10-16",
  entryPrice,
  exitPrice: null,
});

describe("mergeSlicedLegsForOpenedEvent", () => {
  it("adds the slices of one leg back together (SMCI 80 + 80 + 40 sh at the same entry)", () => {
    const merged = mergeSlicedLegsForOpenedEvent([stockLeg(80, 40, 42), stockLeg(80, 40, 42.5), stockLeg(40, 40, null)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.quantity).toBe(200);
    expect(merged[0]!.entryPrice).toBe(40);
  });

  it("merges the short put's closed and open contracts into the 5 that were opened", () => {
    expect(mergeSlicedLegsForOpenedEvent([putLeg(2, 300, 2), putLeg(3, 300, 2)]).map((leg) => leg.quantity)).toEqual([5]);
  });

  it("keeps an exit price only when every merged slice shares it", () => {
    expect(mergeSlicedLegsForOpenedEvent([stockLeg(100, 40, 42), stockLeg(100, 40, 42)])[0]!.exitPrice).toBe(42);
    expect(mergeSlicedLegsForOpenedEvent([stockLeg(100, 40, 42), stockLeg(100, 40, 43)])[0]!.exitPrice).toBeNull();
  });

  it("leaves different contracts, different entry prices and different legs apart, in their original order", () => {
    const legs = [putLeg(1, 300, 2), stockLeg(100, 40, null), putLeg(1, 310, 2), stockLeg(100, 41, null)];
    expect(mergeSlicedLegsForOpenedEvent(legs)).toEqual(legs);
  });

  it("does not modify the legs it is given", () => {
    const legs = [stockLeg(80, 40, 42), stockLeg(40, 40, null)];
    mergeSlicedLegsForOpenedEvent(legs);
    expect(legs.map((leg) => leg.quantity)).toEqual([80, 40]);
  });
});
