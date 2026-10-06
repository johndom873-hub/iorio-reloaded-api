import { OrderAction, OrderType, SecType, TimeInForce } from "@stoqey/ib";
import type { Contract, IBApi } from "@stoqey/ib";
import knexLibrary, { type Knex } from "knex";
import { config } from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAdaptiveAlgoFields,
  buildIbkrOrder,
  cancelSubmittedOrder,
  gcd,
  placeConfirmedOrder,
  resolveLegContractIds,
  type OrderPlacementDependencies,
} from "./ibkrGatewayOrderPlacement.js";
import type { OrderLegPayload, OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";

config();
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the order placement tests.");
const testDb: Knex = knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } });

const BUY = OrderAction.BUY;
const SELL = OrderAction.SELL;

const stockLeg = (overrides: Partial<OrderLegPayload> = {}): OrderLegPayload => ({ role: "stock", action: BUY, symbol: "AAA", quantity: 100, unitPrice: 50, ...overrides });
const optionLeg = (overrides: Partial<OrderLegPayload> = {}): OrderLegPayload => ({ role: "option", action: SELL, symbol: "AAA", quantity: 1, unitPrice: 2, strike: 55, expiry: "20261120", right: "C", ...overrides });
const payloadOf = (legs: OrderLegPayload[], overrides: Partial<OrderRequestPayload> = {}): OrderRequestPayload => ({ symbol: "AAA", strategyKey: "covered_call", legs, ...overrides });

interface FakeIb {
  placeOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
}

function createResolverDependencies(conIdBySymbolAndStrike: (contract: Contract) => number | null = () => 1000) {
  const resolvedContracts: Contract[] = [];
  const requestIds: number[] = [];
  let nextRequestId = 500;
  return {
    resolvedContracts,
    requestIds,
    resolveContractId: vi.fn(async (_ib: IBApi, contract: Contract, requestId: number) => {
      resolvedContracts.push(contract);
      requestIds.push(requestId);
      return conIdBySymbolAndStrike(contract);
    }),
    allocateContractResolutionRequestId: vi.fn(() => nextRequestId++),
  };
}

const fakeIb = (): FakeIb & IBApi => ({ placeOrder: vi.fn(), cancelOrder: vi.fn() }) as unknown as FakeIb & IBApi;

describe("gcd", () => {
  it.each([
    [300, 3, 3],
    [100, 1, 1],
    [200, 2, 2],
    [150, 1, 1],
    [300, 200, 100],
    [7, 13, 1],
  ])("gcd(%i, %i) = %i", (first, second, expected) => {
    expect(gcd(first, second)).toBe(expected);
  });
});

describe("buildAdaptiveAlgoFields", () => {
  it("defaults to the Normal priority", () => {
    expect(buildAdaptiveAlgoFields()).toEqual({ algoStrategy: "Adaptive", algoParams: [{ tag: "adaptivePriority", value: "Normal" }] });
  });

  it.each(["Urgent", "Patient"] as const)("passes the %s priority through", (priority) => {
    expect(buildAdaptiveAlgoFields(priority).algoParams).toEqual([{ tag: "adaptivePriority", value: priority }]);
  });
});

describe("resolveLegContractIds", () => {
  it("returns null for every leg when there is no connection, without resolving anything", async () => {
    const dependencies = createResolverDependencies();
    expect(await resolveLegContractIds(null, [stockLeg(), optionLeg()], dependencies)).toEqual([null, null]);
    expect(dependencies.resolveContractId).not.toHaveBeenCalled();
  });

  it("reuses a pre-resolved conId and resolves only the other legs, in order, each with its own request id", async () => {
    const dependencies = createResolverDependencies((contract) => (contract.secType === SecType.OPT ? 222 : 111));
    const conIds = await resolveLegContractIds(fakeIb(), [stockLeg({ ibkrContractId: 999 }), optionLeg(), stockLeg()], dependencies);
    expect(conIds).toEqual([999, 222, 111]);
    expect(dependencies.resolvedContracts.map((contract) => contract.secType)).toEqual([SecType.OPT, SecType.STK]);
    expect(dependencies.requestIds).toEqual([500, 501]);
  });

  it("keeps an unresolved leg as null", async () => {
    const dependencies = createResolverDependencies(() => null);
    expect(await resolveLegContractIds(fakeIb(), [stockLeg()], dependencies)).toEqual([null]);
  });
});

describe("buildIbkrOrder: single leg", () => {
  it("is a plain DAY limit order at the leg's price with the Adaptive algo (Normal by default), sent by conId only", async () => {
    const dependencies = createResolverDependencies(() => 4242);
    const built = await buildIbkrOrder(payloadOf([stockLeg({ action: BUY, quantity: 100, unitPrice: 51.25 })]), fakeIb(), dependencies);
    expect(built!.contract).toEqual({ conId: 4242, symbol: "AAA", secType: SecType.STK, exchange: "SMART", currency: "USD" });
    expect(built!.order).toEqual({
      action: BUY,
      orderType: OrderType.LMT,
      lmtPrice: 51.25,
      totalQuantity: 100,
      tif: TimeInForce.DAY,
      transmit: true,
      algoStrategy: "Adaptive",
      algoParams: [{ tag: "adaptivePriority", value: "Normal" }],
    });
  });

  it("sells an option leg with the priority chosen on the order", async () => {
    const built = await buildIbkrOrder(payloadOf([optionLeg({ action: SELL, quantity: 3, unitPrice: 1.8 })], { adaptivePriority: "Urgent" }), fakeIb(), createResolverDependencies(() => 77));
    expect(built!.contract).toEqual({ conId: 77, symbol: "AAA", secType: SecType.OPT, exchange: "SMART", currency: "USD" });
    expect(built!.order).toMatchObject({ action: SELL, lmtPrice: 1.8, totalQuantity: 3, algoParams: [{ tag: "adaptivePriority", value: "Urgent" }] });
  });

  it("uses a pre-resolved conId without asking IBKR", async () => {
    const dependencies = createResolverDependencies();
    const built = await buildIbkrOrder(payloadOf([optionLeg({ ibkrContractId: 31337 })]), fakeIb(), dependencies);
    expect(built!.contract.conId).toBe(31337);
    expect(dependencies.resolveContractId).not.toHaveBeenCalled();
  });
});

describe("buildIbkrOrder: combo (BAG)", () => {
  it("one covered call (100 shares + 1 contract): ratios 100:1 in a single unit, priced at the net of the legs", async () => {
    const dependencies = createResolverDependencies((contract) => (contract.secType === SecType.OPT ? 222 : 111));
    const built = await buildIbkrOrder(payloadOf([stockLeg({ action: BUY, quantity: 100, unitPrice: 50 }), optionLeg({ action: SELL, quantity: 1, unitPrice: 2 })]), fakeIb(), dependencies);
    expect(built!.contract).toEqual({
      symbol: "AAA",
      secType: SecType.BAG,
      currency: "USD",
      exchange: "SMART",
      comboLegs: [
        { conId: 111, ratio: 100, action: BUY, exchange: "SMART" },
        { conId: 222, ratio: 1, action: SELL, exchange: "SMART" },
      ],
    });
    // pay 50 for the stock, receive 2 for the call: 50 - 2
    expect(built!.order).toEqual({ action: BUY, orderType: OrderType.LMT, lmtPrice: 48, totalQuantity: 1, tif: TimeInForce.DAY, transmit: true });
  });

  it("three covered calls (300 shares + 3 contracts) are reduced to ratios 100:1 with three combo units, never the raw 300:3", async () => {
    const dependencies = createResolverDependencies((contract) => (contract.secType === SecType.OPT ? 222 : 111));
    const built = await buildIbkrOrder(payloadOf([stockLeg({ action: SELL, quantity: 300, unitPrice: 50 }), optionLeg({ action: BUY, quantity: 3, unitPrice: 2 })]), fakeIb(), dependencies);
    expect(built!.contract.comboLegs).toEqual([
      { conId: 111, ratio: 100, action: SELL, exchange: "SMART" },
      { conId: 222, ratio: 1, action: BUY, exchange: "SMART" },
    ]);
    expect(built!.order.totalQuantity).toBe(3);
    expect(built!.order.action).toBe(BUY);
    // closing: receive 50 for the stock, pay 2 to buy the call back: -50 + 2, a net credit
    expect(built!.order.lmtPrice).toBe(-48);
  });

  it("a combo carries no Adaptive algo (IBKR documents it as single-leg only)", async () => {
    const built = await buildIbkrOrder(payloadOf([stockLeg(), optionLeg()], { adaptivePriority: "Patient" }), fakeIb(), createResolverDependencies());
    expect(built!.order).not.toHaveProperty("algoStrategy");
    expect(built!.order).not.toHaveProperty("algoParams");
  });

  it("two contracts (200 shares): ratios stay 100:1 and the units carry the factor 2", async () => {
    const built = await buildIbkrOrder(payloadOf([stockLeg({ quantity: 200 }), optionLeg({ quantity: 2 })]), fakeIb(), createResolverDependencies());
    expect(built!.contract.comboLegs!.map((leg) => leg.ratio)).toEqual([100, 1]);
    expect(built!.order.totalQuantity).toBe(2);
  });

  it("a roll (buy back one call, sell another) has equal ratios of 1 per leg", async () => {
    const dependencies = createResolverDependencies((contract) => (contract.strike === 55 ? 301 : 302));
    const built = await buildIbkrOrder(payloadOf([optionLeg({ action: BUY, quantity: 4, unitPrice: 1.1, strike: 55 }), optionLeg({ action: SELL, quantity: 4, unitPrice: 1.7, strike: 60 })]), fakeIb(), dependencies);
    expect(built!.contract.comboLegs).toEqual([
      { conId: 301, ratio: 1, action: BUY, exchange: "SMART" },
      { conId: 302, ratio: 1, action: SELL, exchange: "SMART" },
    ]);
    expect(built!.order.totalQuantity).toBe(4);
    expect(built!.order.lmtPrice).toBe(-0.6);
  });

  it("rounds the net price to whole cents", async () => {
    const built = await buildIbkrOrder(payloadOf([optionLeg({ action: BUY, unitPrice: 1.105 }), optionLeg({ action: SELL, unitPrice: 0.5, strike: 60 })]), fakeIb(), createResolverDependencies());
    expect(built!.order.lmtPrice).toBeCloseTo(0.61, 10);
  });
});

describe("buildIbkrOrder: when it cannot build", () => {
  it("returns null without a connection", async () => {
    const dependencies = createResolverDependencies();
    expect(await buildIbkrOrder(payloadOf([stockLeg()]), null, dependencies)).toBeNull();
    expect(dependencies.resolveContractId).not.toHaveBeenCalled();
  });

  it("returns null when any leg's contract cannot be resolved, for a single leg and for a combo", async () => {
    expect(await buildIbkrOrder(payloadOf([stockLeg()]), fakeIb(), createResolverDependencies(() => null))).toBeNull();
    expect(await buildIbkrOrder(payloadOf([stockLeg(), optionLeg()]), fakeIb(), createResolverDependencies((contract) => (contract.secType === SecType.OPT ? null : 5)))).toBeNull();
  });

  it("rejects an option leg whose expiry is not YYYYMMDD instead of sending it to IBKR", async () => {
    await expect(buildIbkrOrder(payloadOf([optionLeg({ expiry: "2026-11-20" })]), fakeIb(), createResolverDependencies())).rejects.toThrow('option leg has expiry "2026-11-20", expected YYYYMMDD');
  });
});

describe("order placement against order_requests", () => {
  let userId: string;
  const createdOrderIds: string[] = [];
  const callOrder: string[] = [];
  let ib: FakeIb & IBApi;
  let state: {
    ib: (FakeIb & IBApi) | null;
    binding: { status: "bound" | "pending" | "mismatch"; reason: string };
    placementBlock: { reason: string; ended: boolean } | null;
    priceBlock: { reason: string; ended: boolean } | null;
    nextOrderId: number | "throw";
    resolver: ReturnType<typeof createResolverDependencies>;
    notifications: string[];
  };
  let dependencies: OrderPlacementDependencies;
  let publishedPulses: string[];

  beforeAll(async () => {
    const [user] = await testDb("users").insert({ username: `placement_user_${Date.now()}`, display_name: "Placement Test User", password_hash: "x" }).returning(["id"]);
    userId = user.id;
  });

  afterAll(async () => {
    await testDb("order_requests").whereIn("id", createdOrderIds).del();
    await testDb("users").where({ id: userId }).del();
    await testDb.destroy();
  });

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    callOrder.length = 0;
    publishedPulses = [];
    ib = fakeIb();
    state = { ib, binding: { status: "bound", reason: "ok" }, placementBlock: null, priceBlock: null, nextOrderId: 8001, resolver: createResolverDependencies(() => 4242), notifications: [] };
    dependencies = {
      db: testDb,
      getIb: () => {
        callOrder.push("getIb");
        return state.ib;
      },
      getNextOrderId: () => {
        callOrder.push("getNextOrderId");
        if (state.nextOrderId === "throw") throw new Error("No IBKR order id available yet — not connected.");
        return state.nextOrderId;
      },
      getCurrentAccountBinding: () => {
        callOrder.push("getCurrentAccountBinding");
        return state.binding as ReturnType<OrderPlacementDependencies["getCurrentAccountBinding"]>;
      },
      getExpectedAccountId: () => "DU1234567",
      endOrderIfPlacementBlocked: async () => {
        callOrder.push("endOrderIfPlacementBlocked");
        return state.placementBlock;
      },
      endOrderIfLimitPriceUnsafe: async () => {
        callOrder.push("endOrderIfLimitPriceUnsafe");
        return state.priceBlock;
      },
      notify: async (message) => void state.notifications.push(message),
      publishPulse: async (edgeId) => void publishedPulses.push(edgeId),
      resolveContractId: state.resolver.resolveContractId,
      allocateContractResolutionRequestId: state.resolver.allocateContractResolutionRequestId,
    };
  });

  async function insertOrder(status: string, payload: OrderRequestPayload, extra: Record<string, unknown> = {}): Promise<string> {
    const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "open_covered_call", payload, status, ...extra }).returning(["id"]);
    createdOrderIds.push(order.id);
    return order.id;
  }

  const rowOf = (orderId: string) => testDb("order_requests").where({ id: orderId }).first();
  const singleLegPayload = () => payloadOf([optionLeg({ action: SELL, quantity: 2, unitPrice: 1.3 })]);

  describe("placeConfirmedOrder", () => {
    it("places a confirmed single-leg order: claims the row as submitted with its IBKR id, names the account, sends it, pulses", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      await placeConfirmedOrder(orderId, dependencies);

      const row = await rowOf(orderId);
      expect(row).toMatchObject({ status: "submitted", ibkr_order_id: 8001, error_message: null });
      expect(row.placed_at).not.toBeNull();
      expect(ib.placeOrder).toHaveBeenCalledTimes(1);
      const [ibkrOrderId, contract, order] = ib.placeOrder.mock.calls[0]!;
      expect(ibkrOrderId).toBe(8001);
      expect(contract).toMatchObject({ conId: 4242, secType: SecType.OPT });
      expect(order).toMatchObject({ action: SELL, orderType: OrderType.LMT, lmtPrice: 1.3, totalQuantity: 2, account: "DU1234567", transmit: true });
      expect(publishedPulses).toEqual(["ibkr-gateway"]);
      expect(state.notifications).toEqual([]);
    });

    it("places a combo with its reduced ratios", async () => {
      const orderId = await insertOrder("confirmed", payloadOf([stockLeg({ action: SELL, quantity: 300 }), optionLeg({ action: BUY, quantity: 3 })]));
      await placeConfirmedOrder(orderId, dependencies);
      const [, contract, order] = ib.placeOrder.mock.calls[0]!;
      expect(contract.comboLegs.map((leg: { ratio: number }) => leg.ratio)).toEqual([100, 1]);
      expect(order.totalQuantity).toBe(3);
    });

    it("runs its guards in a fixed order: placement check, connection, account binding, live price check, then the order id", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      await placeConfirmedOrder(orderId, dependencies);
      expect(callOrder).toEqual(["endOrderIfPlacementBlocked", "getIb", "getCurrentAccountBinding", "endOrderIfLimitPriceUnsafe", "getNextOrderId"]);
    });

    it("does nothing for an order that is not confirmed (already placed, cancelled, or never confirmed)", async () => {
      for (const status of ["pending_confirmation", "submitted", "cancelled", "cancel_requested", "filled"]) {
        const orderId = await insertOrder(status, singleLegPayload());
        await placeConfirmedOrder(orderId, dependencies);
        expect((await rowOf(orderId)).status).toBe(status);
      }
      expect(callOrder).toEqual([]);
      expect(ib.placeOrder).not.toHaveBeenCalled();
    });

    it("does nothing for an unknown order id", async () => {
      await placeConfirmedOrder("00000000-0000-0000-0000-000000000000", dependencies);
      expect(callOrder).toEqual([]);
    });

    it("stops at the placement check before touching the connection, and tells you when it ended the order", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      state.placementBlock = { reason: "Trading is halted.", ended: true };
      await placeConfirmedOrder(orderId, dependencies);
      expect(callOrder).toEqual(["endOrderIfPlacementBlocked"]);
      expect(state.notifications).toEqual([`🛑 Order for AAA (id ${orderId}) was NOT sent to IBKR.\nTrading is halted.`]);
      expect(ib.placeOrder).not.toHaveBeenCalled();
    });

    it("stays quiet when the placement check did not end the order (a cancel landed first)", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      state.placementBlock = { reason: "Order is no longer confirmed.", ended: false };
      await placeConfirmedOrder(orderId, dependencies);
      expect(state.notifications).toEqual([]);
      expect(ib.placeOrder).not.toHaveBeenCalled();
    });

    it("leaves the order confirmed for the next cycle when there is no IBKR connection", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      state.ib = null;
      await placeConfirmedOrder(orderId, dependencies);
      expect((await rowOf(orderId)).status).toBe("confirmed");
      expect(callOrder).toEqual(["endOrderIfPlacementBlocked", "getIb"]);
    });

    it("leaves the order confirmed while the account binding is pending", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      state.binding = { status: "pending", reason: "accounts not reported yet" };
      await placeConfirmedOrder(orderId, dependencies);
      expect((await rowOf(orderId)).status).toBe("confirmed");
      expect(callOrder).not.toContain("endOrderIfLimitPriceUnsafe");
      expect(ib.placeOrder).not.toHaveBeenCalled();
      expect(state.notifications).toEqual([]);
    });

    it("errors the order for good on an account-binding mismatch and says why", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      state.binding = { status: "mismatch", reason: "Gateway manages DU999, expected DU123" };
      await placeConfirmedOrder(orderId, dependencies);
      const row = await rowOf(orderId);
      expect(row).toMatchObject({ status: "error", error_message: "Trading blocked by account binding: Gateway manages DU999, expected DU123" });
      expect(state.notifications).toEqual([`🛑 Order for AAA (id ${orderId}) was NOT sent to IBKR.\nTrading blocked by account binding: Gateway manages DU999, expected DU123`]);
      expect(ib.placeOrder).not.toHaveBeenCalled();
      expect(callOrder).not.toContain("getNextOrderId");
    });

    it("stops at an unsafe live limit price, notifying only when that check ended the order", async () => {
      const endedOrderId = await insertOrder("confirmed", singleLegPayload());
      state.priceBlock = { reason: "Limit price is 40% below the live bid.", ended: true };
      await placeConfirmedOrder(endedOrderId, dependencies);
      expect(state.notifications).toEqual([`🛑 Order for AAA (id ${endedOrderId}) was NOT sent to IBKR.\nLimit price is 40% below the live bid.`]);

      state.notifications.length = 0;
      const keptOrderId = await insertOrder("confirmed", singleLegPayload());
      state.priceBlock = { reason: "Cancelled meanwhile.", ended: false };
      await placeConfirmedOrder(keptOrderId, dependencies);
      expect(state.notifications).toEqual([]);
      expect(ib.placeOrder).not.toHaveBeenCalled();
      expect(callOrder).not.toContain("getNextOrderId");
    });

    it("errors the order when a contract cannot be resolved, and places nothing", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      state.resolver = createResolverDependencies(() => null);
      dependencies.resolveContractId = state.resolver.resolveContractId;
      await placeConfirmedOrder(orderId, dependencies);
      expect(await rowOf(orderId)).toMatchObject({ status: "error", error_message: "Could not resolve one or more contract ids.", ibkr_order_id: null });
      expect(ib.placeOrder).not.toHaveBeenCalled();
    });

    it("never places an order that was cancelled while it was being built", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      dependencies.resolveContractId = async () => {
        await testDb("order_requests").where({ id: orderId }).update({ status: "cancelled" });
        return 4242;
      };
      await placeConfirmedOrder(orderId, dependencies);
      expect(await rowOf(orderId)).toMatchObject({ status: "cancelled", ibkr_order_id: null });
      expect(ib.placeOrder).not.toHaveBeenCalled();
      expect(publishedPulses).toEqual([]);
    });

    it("errors the order and alerts when an IBKR order id is not available", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      state.nextOrderId = "throw";
      await placeConfirmedOrder(orderId, dependencies);
      expect(await rowOf(orderId)).toMatchObject({ status: "error", error_message: "No IBKR order id available yet — not connected." });
      expect(state.notifications).toEqual([`🔥 Order request errored while placing with IBKR: AAA (id ${orderId}).\nNo IBKR order id available yet — not connected.`]);
      expect(ib.placeOrder).not.toHaveBeenCalled();
    });

    it("errors the order and alerts when the order cannot be built (malformed expiry)", async () => {
      const orderId = await insertOrder("confirmed", payloadOf([optionLeg({ expiry: "2026-11-20" })]));
      await placeConfirmedOrder(orderId, dependencies);
      const row = await rowOf(orderId);
      expect(row.status).toBe("error");
      expect(row.error_message).toContain('expected YYYYMMDD');
      expect(state.notifications[0]).toContain("🔥 Order request errored while placing with IBKR");
    });

    it("records an error when IBKR's placeOrder itself throws after the row was claimed", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      ib.placeOrder.mockImplementation(() => {
        throw new Error("socket closed");
      });
      await placeConfirmedOrder(orderId, dependencies);
      expect(await rowOf(orderId)).toMatchObject({ status: "error", error_message: "socket closed" });
      expect(state.notifications[0]).toContain("socket closed");
    });

    it("is not affected by the live-activity pulse failing", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      dependencies.publishPulse = async () => {
        throw new Error("notification channel down");
      };
      await placeConfirmedOrder(orderId, dependencies);
      expect((await rowOf(orderId)).status).toBe("submitted");
    });

    it("places the same confirmed order only once when two workers race for it", async () => {
      const orderId = await insertOrder("confirmed", singleLegPayload());
      await Promise.all([placeConfirmedOrder(orderId, dependencies), placeConfirmedOrder(orderId, dependencies)]);
      expect(ib.placeOrder).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancelSubmittedOrder", () => {
    it("asks IBKR to cancel a cancel-requested order by its IBKR id and leaves the row for the status listener", async () => {
      const orderId = await insertOrder("cancel_requested", singleLegPayload(), { ibkr_order_id: 7777 });
      await cancelSubmittedOrder(orderId, dependencies);
      expect(ib.cancelOrder).toHaveBeenCalledExactlyOnceWith(7777);
      expect((await rowOf(orderId)).status).toBe("cancel_requested");
    });

    it("errors a cancel request that has no IBKR order id instead of leaving it stuck", async () => {
      const orderId = await insertOrder("cancel_requested", singleLegPayload());
      await cancelSubmittedOrder(orderId, dependencies);
      expect(await rowOf(orderId)).toMatchObject({ status: "error", error_message: "cancel_requested with no ibkr_order_id." });
      expect(ib.cancelOrder).not.toHaveBeenCalled();
    });

    it("sends nothing and changes nothing without a connection (it is retried on the next cycle)", async () => {
      const orderId = await insertOrder("cancel_requested", singleLegPayload(), { ibkr_order_id: 7778 });
      state.ib = null;
      await cancelSubmittedOrder(orderId, dependencies);
      expect((await rowOf(orderId)).status).toBe("cancel_requested");
    });

    it("ignores an order that is not cancel-requested (already cancelled or filled)", async () => {
      for (const status of ["cancelled", "filled", "submitted"]) {
        const orderId = await insertOrder(status, singleLegPayload(), { ibkr_order_id: 7779 });
        await cancelSubmittedOrder(orderId, dependencies);
      }
      expect(ib.cancelOrder).not.toHaveBeenCalled();
    });
  });
});
