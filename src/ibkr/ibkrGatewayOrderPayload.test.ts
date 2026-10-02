import { describe, expect, it } from "vitest";
import { OrderAction, SecType } from "@stoqey/ib";
import { buildContractFromConId, buildLegContract, findMalformedOptionExpiry, type OrderLegPayload } from "./ibkrGatewayOrderPayload.js";

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
