import { describe, expect, it } from "vitest";
import { fillSlippagePct, referenceForAdoptedOrder } from "./executor.js";

describe("fillSlippagePct", () => {
  it("is positive when the fill is worse than the reference, for either side", () => {
    expect(fillSlippagePct({ price: 2.0, side: "sell" }, 1.5)).toBeCloseTo(25);
    expect(fillSlippagePct({ price: 2.0, side: "sell" }, 2.2)).toBeCloseTo(-10);
    expect(fillSlippagePct({ price: 1.0, side: "buy" }, 1.4)).toBeCloseTo(40);
    expect(fillSlippagePct({ price: 0, side: "buy" }, 1.4)).toBe(0);
  });
});

describe("referenceForAdoptedOrder", () => {
  it("rebuilds side, multiplier, price and a description from the action row", () => {
    expect(referenceForAdoptedOrder({ kind: "open_cash_secured_put", symbol: "HOOD", reference_bid: "2.0500", reference_mid: "2.1", limit_price: "2.1", quantity: 2, contract: { strike: 100, expiry: "2026-10-16" } })).toEqual({ price: 2.05, side: "sell", multiplier: 100, description: "HOOD 2× open_cash_secured_put $100 2026-10-16" });
    expect(referenceForAdoptedOrder({ kind: "close_leg", symbol: "COIN", reference_bid: null, reference_mid: null, limit_price: "0.40", quantity: 1, contract: null })).toMatchObject({ price: 0.4, side: "buy", multiplier: 100 });
    expect(referenceForAdoptedOrder({ kind: "close_shares", symbol: "AAOI", reference_bid: "101.4", reference_mid: null, limit_price: null, quantity: 40, contract: null })).toMatchObject({ price: 101.4, side: "sell", multiplier: 1 });
  });
});
