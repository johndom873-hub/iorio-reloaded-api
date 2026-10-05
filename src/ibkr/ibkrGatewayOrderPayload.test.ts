import { describe, expect, it } from "vitest";
import { OrderAction, SecType } from "@stoqey/ib";
import { buildContractFromConId, buildLegContract, computeNetLimitPrice, findMalformedOptionExpiry, type OrderLegPayload } from "./ibkrGatewayOrderPayload.js";

function optionLeg(overrides: Partial<OrderLegPayload> = {}): OrderLegPayload {
  return { role: "option", action: OrderAction.BUY, symbol: "NBIS", quantity: 1, unitPrice: 3.92, strike: 230, expiry: "20261002", right: "P", ...overrides };
}

describe("findMalformedOptionExpiry", () => {
  it("accepts YYYYMMDD and ignores stock legs", () => {
    expect(findMalformedOptionExpiry([optionLeg(), { role: "stock", action: OrderAction.SELL, symbol: "NBIS", quantity: 100, unitPrice: 50 }])).toBeNull();
  });

  it.each(["2026-10-02T00:00:00.000Z", "2026-10-02", "202610", ""])("rejects %j", (expiry) => {
    expect(findMalformedOptionExpiry([optionLeg({ expiry })])).toContain("expected YYYYMMDD");
  });

  it("rejects an option leg with no expiry", () => {
    expect(findMalformedOptionExpiry([optionLeg({ expiry: undefined })])).toContain("expected YYYYMMDD");
  });
});

describe("buildLegContract", () => {
  it("describes the full option for a conId lookup", () => {
    expect(buildLegContract(optionLeg())).toMatchObject({ symbol: "NBIS", secType: SecType.OPT, lastTradeDateOrContractMonth: "20261002", strike: 230 });
  });

  it("refuses an ISO timestamp instead of sending it to IBKR", () => {
    expect(() => buildLegContract(optionLeg({ expiry: "2026-10-02T00:00:00.000Z" }))).toThrow("expected YYYYMMDD");
  });
});

describe("buildContractFromConId", () => {
  it("sends the conId without any expiry, strike, right or multiplier", () => {
    const contract = buildContractFromConId(optionLeg({ expiry: "2026-10-02T00:00:00.000Z", ibkrContractId: 910602043 }), 910602043);
    expect(contract).toEqual({ conId: 910602043, symbol: "NBIS", secType: SecType.OPT, exchange: "SMART", currency: "USD" });
  });

  it("uses STK for a stock leg", () => {
    expect(buildContractFromConId({ role: "stock", action: OrderAction.SELL, symbol: "NBIS", quantity: 100, unitPrice: 50 }, 88819736).secType).toBe(SecType.STK);
  });
});

describe("computeNetLimitPrice", () => {
  const stockLeg = (action: OrderAction.BUY | OrderAction.SELL, unitPrice: number): OrderLegPayload => ({ role: "stock", action, symbol: "AAA", quantity: 100, unitPrice });

  it("is the buy legs minus the sell legs, per share", () => {
    expect(computeNetLimitPrice([stockLeg(OrderAction.BUY, 48.2), optionLeg({ action: OrderAction.SELL, unitPrice: 1.35 })])).toBe(46.85);
  });

  it("is negative for a roll that takes a credit, positive for one that pays a debit", () => {
    expect(computeNetLimitPrice([optionLeg({ action: OrderAction.BUY, unitPrice: 1 }), optionLeg({ action: OrderAction.SELL, unitPrice: 2 })])).toBe(-1);
    expect(computeNetLimitPrice([optionLeg({ action: OrderAction.BUY, unitPrice: 2.5 }), optionLeg({ action: OrderAction.SELL, unitPrice: 1.1 })])).toBe(1.4);
  });

  it("returns a clean cent price instead of float noise", () => {
    expect(computeNetLimitPrice([optionLeg({ action: OrderAction.BUY, unitPrice: 0.1 }), optionLeg({ action: OrderAction.BUY, unitPrice: 0.2 })])).toBe(0.3);
    expect(computeNetLimitPrice([stockLeg(OrderAction.BUY, 52.88), optionLeg({ action: OrderAction.BUY, unitPrice: 0.01 })])).toBe(52.89);
  });

  it("is zero for no legs and for legs that cancel", () => {
    expect(computeNetLimitPrice([])).toBe(0);
    expect(computeNetLimitPrice([optionLeg({ action: OrderAction.BUY, unitPrice: 1.23 }), optionLeg({ action: OrderAction.SELL, unitPrice: 1.23 })])).toBe(0);
  });
});
