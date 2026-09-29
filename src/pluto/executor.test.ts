import { describe, expect, it } from "vitest";
import { compareFillsWithReference, impliedChosenLegPrice, otherLegOrderPrices, referenceForAdoptedOrder } from "./executor.js";

describe("compareFillsWithReference", () => {
  const option = (side: "sell" | "buy", quantity: number, price: number) => ({ side, quantity, price, multiplier: 100 });
  const shares = (quantity: number, price: number) => ({ side: "buy" as const, quantity, price, multiplier: 1 });

  it("single leg: positive when the fill is worse than the reference, for either side", () => {
    expect(compareFillsWithReference({ price: 2.0, side: "sell", multiplier: 100 }, [option("sell", 1, 1.5)])?.slippagePct).toBeCloseTo(25);
    expect(compareFillsWithReference({ price: 2.0, side: "sell", multiplier: 100 }, [option("sell", 1, 2.2)])?.slippagePct).toBeCloseTo(-10);
    expect(compareFillsWithReference({ price: 1.0, side: "buy", multiplier: 100 }, [option("buy", 1, 1.4)])?.slippagePct).toBeCloseTo(40);
    expect(compareFillsWithReference({ price: 0, side: "buy", multiplier: 100 }, [option("buy", 1, 1.4)])?.slippagePct).toBe(0);
    const sold = compareFillsWithReference({ price: 2.0, side: "sell", multiplier: 100 }, [option("sell", 2, 2.1), option("sell", 1, 1.9)])!;
    expect(sold.chosenLegFillPrice).toBeCloseTo(2.0333, 4);
    expect(sold.pessimisticPnl).toBe(-10); // filled $10 better than three contracts at the bid
  });

  it("buy-write: the net is what counts, not IBKR's split between shares and call (COHR, 2026-09-21)", () => {
    // Reference call bid 7.90, shares at 328.52; IBKR filled the call at 6.86 and the shares at 327.48 — same net.
    const comparison = compareFillsWithReference({ price: 7.9, side: "sell", multiplier: 100, otherLegs: [{ side: "buy", price: 328.52, multiplier: 1 }] }, [option("sell", 1, 6.86), shares(100, 327.48)])!;
    expect(comparison.chosenLegFillPrice).toBeCloseTo(6.86);
    expect(comparison.fillNetDollars).toBeCloseTo(comparison.referenceNetDollars, 6);
    expect(comparison.slippagePct).toBeCloseTo(0, 6);
    expect(comparison.pessimisticPnl).toBe(0);
  });

  it("roll: a worse net shows as a share of the new option's reference value (SPCX-shaped)", () => {
    const reference = { price: 2.63, side: "sell" as const, multiplier: 100, otherLegs: [{ side: "buy" as const, price: 1.0, multiplier: 100 }] };
    expect(compareFillsWithReference(reference, [option("buy", 1, 1.06), option("sell", 1, 2.69)])!.slippagePct).toBeCloseTo(0, 6);
    const worse = compareFillsWithReference(reference, [option("buy", 2, 1.2), option("sell", 2, 2.6)])!;
    expect(worse.referenceNetDollars).toBeCloseTo(326);
    expect(worse.fillNetDollars).toBeCloseTo(280);
    expect(worse.slippagePct).toBeCloseTo((46 / 526) * 100, 6);
    expect(worse.pessimisticPnl).toBe(46);
  });

  it("is null until the chosen leg has a fill", () => {
    expect(compareFillsWithReference({ price: 2.0, side: "sell", multiplier: 100 }, [])).toBeNull();
    expect(compareFillsWithReference({ price: 7.9, side: "sell", multiplier: 100, otherLegs: [{ side: "buy", price: 328.52, multiplier: 1 }] }, [shares(100, 327.48)])).toBeNull();
  });
});

describe("referenceForAdoptedOrder", () => {
  it("rebuilds side, multiplier, price and a description from the action row", () => {
    expect(referenceForAdoptedOrder({ kind: "open_cash_secured_put", symbol: "HOOD", reference_bid: "2.0500", reference_mid: "2.1", limit_price: "2.1", quantity: 2, contract: { strike: 100, expiry: "2026-10-16" } })).toEqual({ price: 2.05, side: "sell", multiplier: 100, description: "HOOD 2× open_cash_secured_put $100 2026-10-16" });
    expect(referenceForAdoptedOrder({ kind: "close_leg", symbol: "COIN", reference_bid: null, reference_mid: null, limit_price: "0.40", quantity: 1, contract: null })).toMatchObject({ price: 0.4, side: "buy", multiplier: 100 });
    expect(referenceForAdoptedOrder({ kind: "close_shares", symbol: "AAOI", reference_bid: "101.4", reference_mid: null, limit_price: null, quantity: 40, contract: null })).toMatchObject({ price: 101.4, side: "sell", multiplier: 1 });
  });
});

describe("impliedChosenLegPrice", () => {
  const option = (side: "sell" | "buy", quantity: number, price: number) => ({ side, quantity, price, multiplier: 100 });
  const call = { side: "sell" as const, multiplier: 100 };

  it("buy-write: the call's share of the net with the shares at our price (COHR, 2026-09-21)", () => {
    const others = otherLegOrderPrices(call, [{ role: "stock", action: "BUY", unitPrice: 328.52 }, { role: "option", action: "SELL", unitPrice: 7.9 }]);
    expect(others).toEqual([{ side: "buy", price: 328.52, multiplier: 1 }]);
    expect(impliedChosenLegPrice(call, others, [option("sell", 1, 6.86), { side: "buy", quantity: 100, price: 327.48, multiplier: 1 }])).toBeCloseTo(7.9, 6);
  });
  it("roll: the new option's share of the net credit with the buyback at our price (AMAT, 2026-09-10)", () => {
    const others = otherLegOrderPrices(call, [{ role: "option", action: "BUY", unitPrice: 1.61 }, { role: "option", action: "SELL", unitPrice: 4.6 }]);
    expect(impliedChosenLegPrice(call, others, [option("buy", 1, 2.05), option("sell", 1, 5.04)])).toBeCloseTo(4.6, 6);
  });
  it("is null for a single-leg order or before the chosen leg fills", () => {
    expect(otherLegOrderPrices(call, [{ role: "option", action: "SELL", unitPrice: 2 }])).toEqual([]);
    expect(impliedChosenLegPrice(call, [], [option("sell", 1, 2)])).toBeNull();
    expect(impliedChosenLegPrice(call, [{ side: "buy", price: 1, multiplier: 100 }], [option("buy", 1, 1)])).toBeNull();
  });
});
