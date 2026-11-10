import { describe, expect, it } from "vitest";
import { compareFillsWithOwnLimits, compareFillsWithReference, describeActionOrder, impliedChosenLegPrice, limitsInForceAt, otherLegOrderPrices, referenceForAdoptedOrder } from "./executor.js";

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
  });

  it("Covered Call entry: the net is what counts, not IBKR's split between shares and call (COHR, 2026-09-21)", () => {
    // Reference call bid 7.90, shares at 328.52; IBKR filled the call at 6.86 and the shares at 327.48 — same net.
    const comparison = compareFillsWithReference({ price: 7.9, side: "sell", multiplier: 100, otherLegs: [{ side: "buy", price: 328.52, multiplier: 1 }] }, [option("sell", 1, 6.86), shares(100, 327.48)])!;
    expect(comparison.chosenLegFillPrice).toBeCloseTo(6.86);
    expect(comparison.fillNetDollars).toBeCloseTo(comparison.referenceNetDollars, 6);
    expect(comparison.slippagePct).toBeCloseTo(0, 6);
  });

  it("roll: a worse net shows as a share of the new option's reference value (SPCX-shaped)", () => {
    const reference = { price: 2.63, side: "sell" as const, multiplier: 100, otherLegs: [{ side: "buy" as const, price: 1.0, multiplier: 100 }] };
    expect(compareFillsWithReference(reference, [option("buy", 1, 1.06), option("sell", 1, 2.69)])!.slippagePct).toBeCloseTo(0, 6);
    const worse = compareFillsWithReference(reference, [option("buy", 2, 1.2), option("sell", 2, 2.6)])!;
    expect(worse.referenceNetDollars).toBeCloseTo(326);
    expect(worse.fillNetDollars).toBeCloseTo(280);
    expect(worse.slippagePct).toBeCloseTo((46 / 526) * 100, 6);
  });

  it("is null until the chosen leg has a fill", () => {
    expect(compareFillsWithReference({ price: 2.0, side: "sell", multiplier: 100 }, [])).toBeNull();
    expect(compareFillsWithReference({ price: 7.9, side: "sell", multiplier: 100, otherLegs: [{ side: "buy", price: 328.52, multiplier: 1 }] }, [shares(100, 327.48)])).toBeNull();
  });
});

describe("referenceForAdoptedOrder", () => {
  it("rebuilds side, multiplier, price and a description from the action row", () => {
    expect(referenceForAdoptedOrder({ kind: "open_cash_secured_put", symbol: "HOOD", reference_bid: "2.0500", reference_mid: "2.1", limit_price: "2.1", quantity: 2, contract: { strike: 100, expiry: "2026-10-16" } }, "2026-10-07")).toEqual({ price: 2.05, side: "sell", multiplier: 100, description: "HOOD Sell $100 Put · 16 Oct (9DTE) · 2× @ 2.10" });
    expect(referenceForAdoptedOrder({ kind: "close_leg", symbol: "COIN", reference_bid: null, reference_mid: null, limit_price: "0.40", quantity: 1, contract: null })).toMatchObject({ price: 0.4, side: "buy", multiplier: 100 });
    expect(referenceForAdoptedOrder({ kind: "close_shares", symbol: "AAOI", reference_bid: "101.4", reference_mid: null, limit_price: null, quantity: 40, contract: null })).toMatchObject({ price: 101.4, side: "sell", multiplier: 1 });
  });
});

describe("describeActionOrder", () => {
  const today = "2026-10-07";
  it("words every kind in the platform's order standard", () => {
    expect(describeActionOrder({ kind: "open_covered_call", symbol: "SMCI", limit_price: "0.39", quantity: 11, contract: { strategyKey: "covered_call", strike: 46, expiry: "2026-10-09" } }, today)).toBe("SMCI Sell $46 Call · 9 Oct (2DTE) · 11× @ 0.39");
    expect(describeActionOrder({ kind: "close_leg", symbol: "COIN", limit_price: 0.65, quantity: 2, contract: { strike: 300, expiry: "2026-10-10", right: "P" } }, today)).toBe("COIN Buy back $300 Put · 10 Oct (3DTE) · 2× @ 0.65");
    expect(describeActionOrder({ kind: "roll", symbol: "MU", limit_price: 0.4, quantity: 2, contract: { strategyKey: "cash_secured_put", strike: 100, expiry: "2026-10-16", right: "P", fromStrike: 105, fromExpiry: "2026-10-09" } }, today)).toBe("MU Roll $105 Put · 9 Oct → $100 Put · 16 Oct (9DTE) · 2× @ 0.40");
    expect(describeActionOrder({ kind: "close_position", symbol: "SMCI", limit_price: 45.1, quantity: 100, contract: { strategyKey: "covered_call", strike: 46, expiry: "2026-10-09", right: "C" } }, today)).toBe("SMCI Close $46 Call · 9 Oct (2DTE) + sell 100 shares · 1×");
    expect(describeActionOrder({ kind: "close_shares", symbol: "AAOI", limit_price: 101.4, quantity: 40, contract: null }, today)).toBe("AAOI Sell 40 shares @ 101.40");
    expect(describeActionOrder({ kind: "open_cash_secured_put", symbol: "HOOD", limit_price: 42.5, quantity: null, contract: { strike: 42.5, expiry: "2026-10-09" } }, today)).toBe("HOOD Sell $42.5 Put · 9 Oct (2DTE)");
  });
});

describe("impliedChosenLegPrice", () => {
  const option = (side: "sell" | "buy", quantity: number, price: number) => ({ side, quantity, price, multiplier: 100 });
  const call = { side: "sell" as const, multiplier: 100 };

  it("Covered Call entry: the call's share of the net with the shares at our price (COHR, 2026-09-21)", () => {
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

describe("limitsInForceAt / compareFillsWithOwnLimits (Marcelo 2026-11-09)", () => {
  const changes = [
    { at: "2026-11-09T15:02:00.000Z", from: 1.05, to: 1.12 },
    { at: "2026-11-09T15:02:30.000Z", from: 1.12, to: 1.23, refused: "IBKR error 2102: still being processed" },
    { at: "2026-11-09T15:03:00.000Z", from: 1.12, to: 1.29 },
  ];
  const at = (iso: string) => Date.parse(iso);

  it("the first limit before any change, each accepted change from its time, both limits inside a change's 15 s, a refused change never", () => {
    expect(limitsInForceAt(1.05, changes, at("2026-11-09T15:01:00.000Z"))).toEqual([1.05]);
    expect(limitsInForceAt(1.05, changes, at("2026-11-09T15:02:10.000Z"))).toEqual([1.05, 1.12]);
    expect(limitsInForceAt(1.05, changes, at("2026-11-09T15:02:40.000Z"))).toEqual([1.12]);
    expect(limitsInForceAt(1.05, changes, at("2026-11-09T15:04:00.000Z"))).toEqual([1.29]);
  });

  it("a sale: Σ (limit − fill) / Σ limit, each fill on its own limit; a buyback the mirror", () => {
    const sale = compareFillsWithOwnLimits({ side: "sell", multiplier: 100 }, [
      { side: "sell", quantity: 2, price: 1.05, multiplier: 100, executedAtMs: at("2026-11-09T15:01:00.000Z") },
      { side: "sell", quantity: 2, price: 1.2, multiplier: 100, executedAtMs: at("2026-11-09T15:04:00.000Z") },
    ], 1.05, changes)!;
    // (0 × 2 + 0.09 × 2) / (1.05 × 2 + 1.29 × 2) = 0.18 / 4.68
    expect(sale.slippagePct).toBeCloseTo((0.18 / 4.68) * 100, 9);
    expect(sale.averageLimitPrice).toBeCloseTo(1.17, 9);
    expect(sale.chosenLegFillPrice).toBeCloseTo(1.125, 9);
    const buyback = compareFillsWithOwnLimits({ side: "buy", multiplier: 100 }, [{ side: "buy", quantity: 1, price: 0.6, multiplier: 100, executedAtMs: at("2026-11-09T15:01:00.000Z") }], 0.5, [])!;
    expect(buyback.slippagePct).toBeCloseTo(20, 9);
    expect(compareFillsWithOwnLimits({ side: "buy", multiplier: 100 }, [], 0.5, [])).toBeNull();
  });
});
