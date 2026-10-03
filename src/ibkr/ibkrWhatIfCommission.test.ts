import { OrderAction, SecType } from "@stoqey/ib";
import { describe, expect, it } from "vitest";
import { buildWhatIfOrder } from "./ibkrWhatIfCommission.js";
import type { OrderLegPayload } from "./ibkrGatewayOrderPayload.js";

const soldCall: OrderLegPayload = { role: "option", action: OrderAction.SELL, symbol: "AAOI", quantity: 3, unitPrice: 1.2, strike: 40, expiry: "20261120", right: "C" };
const boughtShares: OrderLegPayload = { role: "stock", action: OrderAction.BUY, symbol: "AAOI", quantity: 300, unitPrice: 31 };

describe("buildWhatIfOrder", () => {
  it("is always a what-if, for a single leg", () => {
    const { order, contract } = buildWhatIfOrder([soldCall], [111], "DU1");
    expect(order).toMatchObject({ whatIf: true, account: "DU1", action: OrderAction.SELL, totalQuantity: 3, lmtPrice: 1.2 });
    expect(contract).toMatchObject({ conId: 111, secType: SecType.OPT });
  });

  it("is always a what-if for a combo too, and reduces the leg ratios", () => {
    const { order, contract } = buildWhatIfOrder([boughtShares, soldCall], [222, 111], "DU1");
    expect(order).toMatchObject({ whatIf: true, action: OrderAction.BUY, totalQuantity: 3 });
    expect(order.lmtPrice).toBeCloseTo(31 - 1.2, 10);
    expect(contract.secType).toBe(SecType.BAG);
    expect(contract.comboLegs?.map((leg) => leg.ratio)).toEqual([100, 1]);
  });
});
