import { describe, expect, it, vi } from "vitest";
import type { OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import type { OrderLegFillRow } from "./orderFills.js";

vi.mock("../db/connection.js", () => ({ db: {} }));

const { matchOrderLegFills, normalizeOrderLegExpiryToYyyymmdd } = await import("./orderFills.js");

const optionLeg = (action: "BUY" | "SELL", expiry: string, overrides: Partial<OrderLegPayload> = {}): OrderLegPayload =>
  ({ role: "option", action, symbol: "SMCI", quantity: 2, unitPrice: 1.2, strike: 47, expiry, right: "C", ...overrides }) as OrderLegPayload;

const fillRow = (overrides: Partial<OrderLegFillRow>): OrderLegFillRow => ({
  orderRequestId: "order",
  legType: "option",
  side: "sell",
  strike: "47.0000",
  expiry: "20261023",
  quantity: "2",
  notional: "2.41",
  commission: "1.3",
  ...overrides,
});

describe("matchOrderLegFills", () => {
  it("gives each payload leg, in order, its filled quantity and quantity-weighted average fill price", () => {
    const legs = [optionLeg("BUY", "20261016"), optionLeg("SELL", "20261023")];
    const fills = [fillRow({ side: "sell", expiry: "20261023", quantity: "2", notional: String(1 * 1.2 + 1 * 1.21) }), fillRow({ side: "buy", expiry: "20261016", quantity: 1, notional: 0.55 })];
    const [buyBack, newCall] = matchOrderLegFills(legs, fills);
    expect(buyBack).toEqual({ filledQuantity: 1, averageFillPrice: 0.55 });
    expect(newCall!.filledQuantity).toBe(2);
    expect(newCall!.averageFillPrice).toBeCloseTo(1.205, 10);
  });

  it("matches a payload expiry stored as an ISO timestamp, and a stock leg with no strike or expiry", () => {
    const legs = [optionLeg("BUY", "2026-10-16T00:00:00.000Z", { quantity: 1 }), { role: "stock", action: "BUY", symbol: "SMCI", quantity: 100, unitPrice: 92.43 } as OrderLegPayload];
    const fills = [fillRow({ side: "buy", expiry: "20261016", quantity: 1, notional: 0.5 }), fillRow({ legType: "stock", side: "buy", strike: null, expiry: null, quantity: "100", notional: "9243.25" })];
    expect(matchOrderLegFills(legs, fills)).toEqual([
      { filledQuantity: 1, averageFillPrice: 0.5 },
      { filledQuantity: 100, averageFillPrice: 92.4325 },
    ]);
  });

  it("leaves a leg with no fill at zero filled and no average price", () => {
    expect(matchOrderLegFills([optionLeg("SELL", "20261023")], [])).toEqual([{ filledQuantity: 0, averageFillPrice: null }]);
  });
});

describe("normalizeOrderLegExpiryToYyyymmdd", () => {
  it("reads YYYYMMDD, an ISO date or timestamp, and gives null for anything else", () => {
    expect(normalizeOrderLegExpiryToYyyymmdd("20261016")).toBe("20261016");
    expect(normalizeOrderLegExpiryToYyyymmdd("2026-10-16")).toBe("20261016");
    expect(normalizeOrderLegExpiryToYyyymmdd("2026-10-16T00:00:00.000Z")).toBe("20261016");
    expect(normalizeOrderLegExpiryToYyyymmdd("garbage")).toBeNull();
    expect(normalizeOrderLegExpiryToYyyymmdd(undefined)).toBeNull();
  });
});
