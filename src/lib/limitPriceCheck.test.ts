import { describe, expect, it } from "vitest";
import { describeOrderLegForPriceCheck, evaluateLimitPrices, usableQuote, type PriceCheckLeg } from "./limitPriceCheck.js";

const tolerance = { maxDeviationPct: 10, minToleranceDollars: 0.05 };
const sell = (limitPrice: number, quote: PriceCheckLeg["quote"]): PriceCheckLeg => ({ description: "SELL 1 AAOI 2026-11-20 $100 put", action: "SELL", limitPrice, quote });
const buy = (limitPrice: number, quote: PriceCheckLeg["quote"]): PriceCheckLeg => ({ description: "BUY 1 AAOI 2026-11-20 $100 put", action: "BUY", limitPrice, quote });

describe("evaluateLimitPrices: the allowance is max(deviation % of the mid, the dollar floor)", () => {
  it("passes a sell at the mid, above the mid, or at the bid of a tight market", () => {
    expect(evaluateLimitPrices([sell(1.0, { bid: 0.95, ask: 1.05 })], tolerance).blocked).toBe(false);
    expect(evaluateLimitPrices([sell(1.5, { bid: 0.95, ask: 1.05 })], tolerance).blocked).toBe(false);
    expect(evaluateLimitPrices([sell(0.95, { bid: 0.95, ask: 1.05 })], tolerance).blocked).toBe(false);
  });

  it("refuses a sell priced too cheap: percentage allowance on a larger mid", () => {
    // mid 2.00, allowance max(0.20, 0.05) = 0.20 -> 1.80 is exactly allowed, 1.79 is not
    const quote = { bid: 1.95, ask: 2.05 };
    expect(evaluateLimitPrices([sell(1.8, quote)], tolerance).blocked).toBe(false);
    const refused = evaluateLimitPrices([sell(1.79, quote)], tolerance);
    expect(refused.blocked).toBe(true);
    expect(refused.reasons).toEqual([
      "Limit price 1.79 for SELL 1 AAOI 2026-11-20 $100 put is 0.21 below the live mid 2.00 (bid 1.95, ask 2.05); at most 0.20 is allowed (10% of the mid, minimum $0.05).",
    ]);
  });

  it("the dollar floor protects a cheap option: mid 0.20 allows 0.05, not 0.02", () => {
    const quote = { bid: 0.18, ask: 0.22 };
    expect(evaluateLimitPrices([sell(0.15, quote)], tolerance).blocked).toBe(false); // 0.05 below the mid, at the floor
    expect(evaluateLimitPrices([sell(0.14, quote)], tolerance).blocked).toBe(true);
  });

  it("refuses a buy paying too much, passes a buy below the mid", () => {
    const quote = { bid: 0.9, ask: 1.1 };
    expect(evaluateLimitPrices([buy(1.1, quote)], tolerance).blocked).toBe(false); // mid 1.00, allowance 0.10, exactly at the ask
    const refused = evaluateLimitPrices([buy(1.11, quote)], tolerance);
    expect(refused.blocked).toBe(true);
    expect(refused.reasons[0]).toContain("0.11 above the live mid 1.00");
    expect(evaluateLimitPrices([buy(0.5, quote)], tolerance).blocked).toBe(false);
  });

  it("only the adverse direction is refused: a sell far above the mid and a buy far below pass", () => {
    const quote = { bid: 0.9, ask: 1.1 };
    expect(evaluateLimitPrices([sell(9.99, quote)], tolerance).blocked).toBe(false);
    expect(evaluateLimitPrices([buy(0.01, quote)], tolerance).blocked).toBe(false);
  });

  it("a typo'd price is caught: 0.12 instead of 1.20 on a sell, 12 instead of 1.2 on a buy", () => {
    const quote = { bid: 1.15, ask: 1.25 };
    expect(evaluateLimitPrices([sell(0.12, quote)], tolerance).blocked).toBe(true);
    expect(evaluateLimitPrices([buy(12, quote)], tolerance).blocked).toBe(true);
  });

  it("every leg is judged on its own: one bad leg of a combo blocks and names only that leg", () => {
    const result = evaluateLimitPrices(
      [
        { description: "BUY 200 AAOI shares", action: "BUY", limitPrice: 48.2, quote: { bid: 48.15, ask: 48.25 } },
        { description: "SELL 2 AAOI 2026-10-16 $55 call", action: "SELL", limitPrice: 0.11, quote: { bid: 1.05, ask: 1.15 } },
      ],
      tolerance,
    );
    expect(result.blocked).toBe(true);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("SELL 2 AAOI 2026-10-16 $55 call");
    expect(result.legs.map((leg) => leg.ok)).toEqual([true, false]);
  });

  it("zero tolerance means the limit must not be worse than the mid at all", () => {
    const strict = { maxDeviationPct: 0, minToleranceDollars: 0 };
    expect(evaluateLimitPrices([sell(1.0, { bid: 0.95, ask: 1.05 })], strict).blocked).toBe(false);
    expect(evaluateLimitPrices([sell(0.99, { bid: 0.95, ask: 1.05 })], strict).blocked).toBe(true);
  });

  it("a limit exactly at the allowance is not refused despite floating-point noise", () => {
    // 1.1 * 0.1 etc. produce 0.10000000000000009-style values; the comparison must not trip on them
    expect(evaluateLimitPrices([sell(0.99, { bid: 1.09, ask: 1.11 })], tolerance).blocked).toBe(false);
  });

  it("records the figures of every leg for the audit trail", () => {
    const result = evaluateLimitPrices([sell(1.8, { bid: 1.95, ask: 2.05 })], tolerance);
    expect(result.legs[0]).toMatchObject({ bid: 1.95, ask: 2.05, mid: 2, ok: true });
    expect(result.legs[0]!.allowance).toBeCloseTo(0.2, 9);
    expect(result.legs[0]!.adverseDistance).toBeCloseTo(0.2, 9);
  });
});

describe("evaluateLimitPrices fails closed without a usable two-sided quote", () => {
  it.each([
    ["no quote at all", null],
    ["no bid", { bid: null, ask: 1.1 }],
    ["no ask", { bid: 0.9, ask: null }],
    ["a negative bid (IBKR's no-quote marker)", { bid: -1, ask: 1.1 }],
    ["a zero ask", { bid: 0, ask: 0 }],
    ["a crossed market", { bid: 1.2, ask: 1.1 }],
    ["a non-finite price", { bid: Number.NaN, ask: 1.1 }],
  ])("%s refuses the order and says the price cannot be checked", (_label, quote) => {
    const result = evaluateLimitPrices([sell(1.0, quote)], tolerance);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toEqual(["No live two-sided quote for SELL 1 AAOI 2026-11-20 $100 put, so its limit price 1.00 cannot be checked."]);
    expect(result.legs[0]).toMatchObject({ ok: false, mid: null, allowance: null });
  });

  it("a zero bid with a real ask is a usable quote (a far out-of-the-money option)", () => {
    expect(usableQuote({ bid: 0, ask: 0.05 })).toEqual({ bid: 0, ask: 0.05 });
    expect(evaluateLimitPrices([sell(0.03, { bid: 0, ask: 0.05 })], tolerance).blocked).toBe(false);
  });

  it("an order with no legs is never blocked by this check", () => {
    expect(evaluateLimitPrices([], tolerance)).toEqual({ blocked: false, reasons: [], legs: [] });
  });
});

describe("describeOrderLegForPriceCheck", () => {
  it("reads an option leg with its date and a stock leg with its share count", () => {
    expect(describeOrderLegForPriceCheck({ role: "option", action: "SELL", symbol: "AAOI", quantity: 2, strike: 100, expiry: "20261120", right: "P" })).toBe("SELL 2 AAOI 2026-11-20 $100 put");
    expect(describeOrderLegForPriceCheck({ role: "option", action: "BUY", symbol: "AAOI", quantity: 1, strike: 55.5, expiry: "20261016", right: "C" })).toBe("BUY 1 AAOI 2026-10-16 $55.5 call");
    expect(describeOrderLegForPriceCheck({ role: "stock", action: "BUY", symbol: "AAOI", quantity: 200 })).toBe("BUY 200 AAOI shares");
  });
});
