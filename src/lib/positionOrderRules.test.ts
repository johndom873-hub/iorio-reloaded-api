import { describe, expect, it } from "vitest";
import type { OrderLegPayload, OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import {
  computeUnderlyingStockPriceByPosition,
  computeUnrealizedPnlByPosition,
  normalizeExpiryDate,
  roundToCents,
  sumSharesCommittedByCoveredCallPayloads,
  underlyingStockPriceKey,
  validateCoveredCallCoverage,
  type OpenLegForUnrealizedPnl,
} from "./positionOrderRules.js";

describe("validateCoveredCallCoverage", () => {
  // Three short call contracts cover 3 x 100 = 300 shares.
  it("refuses a short call that covers more shares than the stock held: 299 shares cannot cover 3 contracts", () => {
    expect(validateCoveredCallCoverage(299, 300)).toBe("Short call coverage (300 shares) exceeds stock held (299 shares) — this would leave the position naked.");
  });

  it("allows exactly enough stock: 300 shares cover 3 contracts", () => {
    expect(validateCoveredCallCoverage(300, 300)).toBeNull();
  });

  it("allows over-coverage: 301 shares cover 3 contracts", () => {
    expect(validateCoveredCallCoverage(301, 300)).toBeNull();
  });

  it("refuses any short call against no stock at all", () => {
    expect(validateCoveredCallCoverage(0, 100)).toBe("Short call coverage (100 shares) exceeds stock held (0 shares) — this would leave the position naked.");
  });

  it("allows no short call against no stock", () => {
    expect(validateCoveredCallCoverage(0, 0)).toBeNull();
  });

  it("refuses a single share of naked exposure: 99 shares against 1 contract", () => {
    expect(validateCoveredCallCoverage(99, 100)).toContain("exceeds stock held (99 shares)");
  });
});

describe("roundToCents", () => {
  it("leaves a value already on the cent grid alone", () => {
    expect(roundToCents(1.5)).toBe(1.5);
    expect(roundToCents(0)).toBe(0);
    expect(roundToCents(12.34)).toBe(12.34);
  });

  it("rounds a third decimal to the nearest cent", () => {
    expect(roundToCents(3.333)).toBe(3.33);
    expect(roundToCents(3.337)).toBe(3.34);
    expect(roundToCents(0.004)).toBe(0);
    expect(roundToCents(0.006)).toBe(0.01);
  });

  it("rounds a half-cent that is exactly representable up (0.125 -> 0.13, 2.675 -> 2.68)", () => {
    expect(roundToCents(0.125)).toBe(0.13);
    expect(roundToCents(0.135)).toBe(0.14);
    expect(roundToCents(2.675)).toBe(2.68);
    expect(roundToCents(0.005)).toBe(0.01);
  });

  it("follows binary floating point for half-cents that are not exactly representable (1.005 -> 1, 1.255 -> 1.25, 1.235 -> 1.24)", () => {
    // 1.005 x 100 is 100.49999999999999 in floating point, so it rounds down; 1.235 x 100 is 123.50000000000001, so it rounds up.
    expect(roundToCents(1.005)).toBe(1);
    expect(roundToCents(1.015)).toBe(1.01);
    expect(roundToCents(1.255)).toBe(1.25);
    expect(roundToCents(1.235)).toBe(1.24);
  });

  it("removes floating point noise from a sum (0.1 + 0.2 -> 0.3)", () => {
    expect(roundToCents(0.1 + 0.2)).toBe(0.3);
  });

  it("rounds a large price at the cent (99.995 -> 100)", () => {
    expect(roundToCents(99.995)).toBe(100);
  });
});

describe("normalizeExpiryDate", () => {
  it("keeps a YYYYMMDD date as it is", () => {
    expect(normalizeExpiryDate("20260828")).toBe("20260828");
  });

  it("strips dashes and slashes", () => {
    expect(normalizeExpiryDate("2026-08-28")).toBe("20260828");
    expect(normalizeExpiryDate("2026/08/28")).toBe("20260828");
    expect(normalizeExpiryDate("2026.08.28")).toBe("20260828");
  });

  it("strips surrounding whitespace and any other non-digit", () => {
    expect(normalizeExpiryDate(" 2026-08-28 ")).toBe("20260828");
    expect(normalizeExpiryDate("2026 08 28")).toBe("20260828");
  });

  it("refuses anything that does not leave exactly eight digits", () => {
    expect(normalizeExpiryDate("")).toBeNull();
    expect(normalizeExpiryDate("garbage")).toBeNull();
    expect(normalizeExpiryDate("2026-08")).toBeNull();
    expect(normalizeExpiryDate("2026-13")).toBeNull();
    expect(normalizeExpiryDate("2026082")).toBeNull();
    expect(normalizeExpiryDate("202608281")).toBeNull();
    expect(normalizeExpiryDate("2026-08-28T00:00:00.000Z")).toBeNull();
  });

  it("checks only the digit count, not that the date exists", () => {
    // 20261399 has eight digits and passes; the IBKR contract lookup, not this rule, rejects an impossible date.
    expect(normalizeExpiryDate("20261399")).toBe("20261399");
  });
});

function payloadOf(legs: Array<Pick<OrderLegPayload, "role" | "quantity">>): OrderRequestPayload {
  return {
    symbol: "ZZ",
    strategyKey: "covered_call",
    legs: legs.map((leg) => ({ role: leg.role, action: leg.role === "stock" ? "BUY" : "SELL", symbol: "ZZ", quantity: leg.quantity, unitPrice: 1 })),
  } as OrderRequestPayload;
}

describe("sumSharesCommittedByCoveredCallPayloads", () => {
  it("is zero with nothing in flight", () => {
    expect(sumSharesCommittedByCoveredCallPayloads([])).toBe(0);
  });

  it("counts every share of a call written with no stock bought: 3 contracts = 300 shares", () => {
    expect(sumSharesCommittedByCoveredCallPayloads([payloadOf([{ role: "option", quantity: 3 }])])).toBe(300);
  });

  it("counts none of an order that buys all the shares it covers: 3 contracts with 300 shares bought", () => {
    expect(
      sumSharesCommittedByCoveredCallPayloads([
        payloadOf([
          { role: "stock", quantity: 300 },
          { role: "option", quantity: 3 },
        ]),
      ]),
    ).toBe(0);
  });

  it("counts only the part the stock leg does not buy: 1 contract with 40 shares bought = 60", () => {
    expect(
      sumSharesCommittedByCoveredCallPayloads([
        payloadOf([
          { role: "stock", quantity: 40 },
          { role: "option", quantity: 1 },
        ]),
      ]),
    ).toBe(60);
  });

  it("never goes negative for an order that buys more shares than it covers: 1 contract with 150 shares", () => {
    expect(
      sumSharesCommittedByCoveredCallPayloads([
        payloadOf([
          { role: "stock", quantity: 150 },
          { role: "option", quantity: 1 },
        ]),
      ]),
    ).toBe(0);
  });

  it("does not let one order's surplus stock offset another order's shortfall", () => {
    // Order A buys 200 shares for 1 contract (surplus 100, committed 0); order B writes 2 contracts with no stock (committed 200).
    expect(
      sumSharesCommittedByCoveredCallPayloads([
        payloadOf([
          { role: "stock", quantity: 200 },
          { role: "option", quantity: 1 },
        ]),
        payloadOf([{ role: "option", quantity: 2 }]),
      ]),
    ).toBe(200);
  });

  it("adds the orders up: 1 contract bare (100) + 2 contracts with 100 shares (100) = 200", () => {
    expect(
      sumSharesCommittedByCoveredCallPayloads([
        payloadOf([{ role: "option", quantity: 1 }]),
        payloadOf([
          { role: "stock", quantity: 100 },
          { role: "option", quantity: 2 },
        ]),
      ]),
    ).toBe(200);
  });

  it("sums the quantities of several option legs and several stock legs within one order", () => {
    // 1 + 2 = 3 contracts = 300 shares, minus 50 + 25 = 75 bought, = 225.
    expect(
      sumSharesCommittedByCoveredCallPayloads([
        payloadOf([
          { role: "option", quantity: 1 },
          { role: "option", quantity: 2 },
          { role: "stock", quantity: 50 },
          { role: "stock", quantity: 25 },
        ]),
      ]),
    ).toBe(225);
  });
});

describe("computeUnrealizedPnlByPosition", () => {
  function leg(overrides: Partial<OpenLegForUnrealizedPnl> & Pick<OpenLegForUnrealizedPnl, "id" | "positionId">): OpenLegForUnrealizedPnl {
    return { legType: "option", side: "short", quantity: 1, multiplier: 100, entryPrice: "1.0000", ...overrides };
  }

  it("a short option gains when the price falls: entry 2.00, now 0.50, 2 contracts x 100 = +300", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1", quantity: 2, entryPrice: "2.0000" })], { L1: 0.5 });
    expect(result.unrealizedByPositionId).toEqual({ P1: 300 });
    expect(result.premiumByPositionId).toEqual({ P1: 300 });
    expect(result.stockByPositionId).toEqual({ P1: 0 });
    expect(result.stockMarketValueByPositionId).toEqual({ P1: 0 });
  });

  it("a short option loses when the price rises: entry 2.00, now 3.50, 1 contract x 100 = -150", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1", entryPrice: "2.0000" })], { L1: 3.5 });
    expect(result.unrealizedByPositionId.P1).toBe(-150);
    expect(result.premiumByPositionId.P1).toBe(-150);
  });

  it("a long option gains when the price rises: entry 1.00, now 1.50, 3 contracts x 100 = +150", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1", side: "long", quantity: 3, entryPrice: "1.0000" })], { L1: 1.5 });
    expect(result.unrealizedByPositionId.P1).toBe(150);
    expect(result.premiumByPositionId.P1).toBe(150);
  });

  it("a long option loses when the price falls: entry 1.00, now 0.40, 1 contract x 100 = -60", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1", side: "long", entryPrice: "1.0000" })], { L1: 0.4 });
    expect(result.unrealizedByPositionId.P1).toBeCloseTo(-60, 10);
  });

  it("long stock gains when the price rises and reports its market value: 100 shares, entry 50, now 55 = +500, value 5500", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "S1", positionId: "P1", legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: "50.0000" })], { S1: 55 });
    expect(result.unrealizedByPositionId.P1).toBe(500);
    expect(result.stockByPositionId.P1).toBe(500);
    expect(result.stockMarketValueByPositionId.P1).toBe(5500);
    expect(result.premiumByPositionId.P1).toBe(0);
  });

  it("long stock loses when the price falls: 100 shares, entry 50, now 48 = -200, value 4800", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "S1", positionId: "P1", legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: "50.0000" })], { S1: 48 });
    expect(result.unrealizedByPositionId.P1).toBe(-200);
    expect(result.stockMarketValueByPositionId.P1).toBe(4800);
  });

  it("short stock gains when the price falls, and its market value is still price x shares (not negated)", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "S1", positionId: "P1", legType: "stock", side: "short", quantity: 10, multiplier: 1, entryPrice: "50.0000" })], { S1: 45 });
    expect(result.unrealizedByPositionId.P1).toBe(50);
    expect(result.stockByPositionId.P1).toBe(50);
    expect(result.stockMarketValueByPositionId.P1).toBe(450);
  });

  it("splits a covered call into its premium and stock parts: stock +500, short call (entry 2, now 3, x100) -100, total +400", () => {
    const result = computeUnrealizedPnlByPosition(
      ["P1"],
      [
        leg({ id: "S1", positionId: "P1", legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: "50.0000" }),
        leg({ id: "C1", positionId: "P1", entryPrice: "2.0000" }),
      ],
      { S1: 55, C1: 3 },
    );
    expect(result.unrealizedByPositionId.P1).toBe(400);
    expect(result.premiumByPositionId.P1).toBe(-100);
    expect(result.stockByPositionId.P1).toBe(500);
    expect(result.stockMarketValueByPositionId.P1).toBe(5500);
  });

  it("applies the leg's own multiplier (a 10x mini contract: entry 2.00, now 1.00, 4 short = +40)", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1", quantity: 4, multiplier: 10, entryPrice: "2.0000" })], { L1: 1 });
    expect(result.unrealizedByPositionId.P1).toBe(40);
  });

  it("reads the entry price from the string Postgres returns for a numeric column", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1", entryPrice: "2.5000" })], { L1: 2.25 });
    expect(result.unrealizedByPositionId.P1).toBe(25);
    const fromNumber = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1", entryPrice: 2.5 })], { L1: 2.25 });
    expect(fromNumber.unrealizedByPositionId.P1).toBe(25);
  });

  it("treats a price of exactly zero as a real price (a short put gone worthless: entry 2.00, now 0, 2 contracts = +400)", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1", quantity: 2, entryPrice: "2.0000" })], { L1: 0 });
    expect(result.unrealizedByPositionId.P1).toBe(400);
  });

  it("sums several legs of one option kind", () => {
    const result = computeUnrealizedPnlByPosition(
      ["P1"],
      [leg({ id: "L1", positionId: "P1", quantity: 2, entryPrice: "2.0000" }), leg({ id: "L2", positionId: "P1", quantity: 3, entryPrice: "1.0000" })],
      { L1: 1.5, L2: 0.5 },
    );
    // (1.5-2)*2*100*-1 = +100; (0.5-1)*3*100*-1 = +150.
    expect(result.unrealizedByPositionId.P1).toBe(250);
    expect(result.premiumByPositionId.P1).toBe(250);
  });

  it("makes a position null on every figure when one of its legs has no price, even though another leg is priced", () => {
    const result = computeUnrealizedPnlByPosition(
      ["P1"],
      [
        leg({ id: "S1", positionId: "P1", legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: "50.0000" }),
        leg({ id: "C1", positionId: "P1", entryPrice: "2.0000" }),
      ],
      { S1: 55, C1: null },
    );
    expect(result.unrealizedByPositionId.P1).toBeNull();
    expect(result.premiumByPositionId.P1).toBeNull();
    expect(result.stockByPositionId.P1).toBeNull();
    expect(result.stockMarketValueByPositionId.P1).toBeNull();
  });

  it("treats a leg missing from the price map the same as a null price", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1" })], {});
    expect(result.unrealizedByPositionId.P1).toBeNull();
  });

  it("stays null when the unpriced leg comes first and a priced leg follows", () => {
    const result = computeUnrealizedPnlByPosition(["P1"], [leg({ id: "L1", positionId: "P1" }), leg({ id: "L2", positionId: "P1", entryPrice: "2.0000" })], { L1: null, L2: 1 });
    expect(result.unrealizedByPositionId.P1).toBeNull();
    expect(result.premiumByPositionId.P1).toBeNull();
  });

  it("keeps one position's missing price from nulling another position", () => {
    const result = computeUnrealizedPnlByPosition(
      ["P1", "P2"],
      [leg({ id: "L1", positionId: "P1" }), leg({ id: "L2", positionId: "P2", entryPrice: "2.0000" })],
      { L1: null, L2: 1 },
    );
    expect(result.unrealizedByPositionId).toEqual({ P1: null, P2: 100 });
    expect(result.premiumByPositionId).toEqual({ P1: null, P2: 100 });
  });

  it("reads 0, not missing, for a position with no open legs, and returns an entry for every requested id", () => {
    const result = computeUnrealizedPnlByPosition(["P1", "P2"], [], {});
    expect(result.unrealizedByPositionId).toEqual({ P1: 0, P2: 0 });
    expect(result.premiumByPositionId).toEqual({ P1: 0, P2: 0 });
    expect(result.stockByPositionId).toEqual({ P1: 0, P2: 0 });
    expect(result.stockMarketValueByPositionId).toEqual({ P1: 0, P2: 0 });
  });

  it("returns nothing for no positions", () => {
    expect(computeUnrealizedPnlByPosition([], [], {})).toEqual({ unrealizedByPositionId: {}, premiumByPositionId: {}, stockByPositionId: {}, stockMarketValueByPositionId: {} });
  });

  it("is a pure function: the inputs are not modified", () => {
    const legs = [leg({ id: "L1", positionId: "P1" })];
    const prices = { L1: 0.5 };
    const legsBefore = JSON.stringify(legs);
    computeUnrealizedPnlByPosition(["P1"], legs, prices);
    expect(JSON.stringify(legs)).toBe(legsBefore);
    expect(prices).toEqual({ L1: 0.5 });
  });
});

describe("computeUnderlyingStockPriceByPosition", () => {
  it("prices every position from its symbol's underlying quote, whatever legs it holds", () => {
    const prices = { [underlyingStockPriceKey("BMNR")]: 26.82, [underlyingStockPriceKey("TLT")]: 90.1, L1: 0.5 };
    expect(computeUnderlyingStockPriceByPosition(["P1", "P2", "P3"], { P1: "BMNR", P2: "TLT", P3: "BMNR" }, prices)).toEqual({ P1: 26.82, P2: 90.1, P3: 26.82 });
  });

  it("is null for a symbol with no quote yet, a null quote, or a position with no symbol", () => {
    const prices = { [underlyingStockPriceKey("NOQUOTE")]: null };
    expect(computeUnderlyingStockPriceByPosition(["P1", "P2", "P3"], { P1: "NOQUOTE", P2: "ABSENT" }, prices)).toEqual({ P1: null, P2: null, P3: null });
  });
});
