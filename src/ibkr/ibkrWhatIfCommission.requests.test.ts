import { EventEmitter } from "node:events";
import { EventName, OrderAction, OrderType, type Contract, type Order } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readExpectedAccountId: vi.fn(),
  borrowSharedConnectionOrConnect: vi.fn(),
  resolveContractId: vi.fn(),
  nextReqIdForCalls: [] as number[],
  nextFallbackValue: 90_000,
}));

vi.mock("../lib/accountBinding.js", () => ({ readExpectedAccountId: mocks.readExpectedAccountId }));
vi.mock("./ibkrGatewayResolveContractId.js", () => ({ resolveContractId: mocks.resolveContractId }));
vi.mock("./sharedReadConnection.js", () => ({
  borrowSharedConnectionOrConnect: mocks.borrowSharedConnectionOrConnect,
  nextReqIdFor: (_ib: unknown, fallback: () => number) => {
    const reqId = fallback();
    mocks.nextReqIdForCalls.push(reqId);
    return reqId;
  },
  sharedReadConnection: { label: "shared-read-fake" },
}));

const { allocateWhatIfOrderId, requestWhatIfCommissionRange, fetchWhatIfCommissionRange } = await import("./ibkrWhatIfCommission.js");
import type { OrderLegPayload } from "./ibkrGatewayOrderPayload.js";

interface FakeIb extends EventEmitter {
  reqIds: ReturnType<typeof vi.fn>;
  placeOrder: ReturnType<typeof vi.fn>;
}

function createFakeIb(): FakeIb {
  return Object.assign(new EventEmitter(), { reqIds: vi.fn(), placeOrder: vi.fn() });
}

const soldCall: OrderLegPayload = { role: "option", action: OrderAction.SELL, symbol: "AAOI", quantity: 3, unitPrice: 1.2, strike: 40, expiry: "20261120", right: "C" };
const boughtShares: OrderLegPayload = { role: "stock", action: OrderAction.BUY, symbol: "AAOI", quantity: 300, unitPrice: 31 };

const whatIfContract = { conId: 111, symbol: "AAOI" } as Contract;
const whatIfOrder = { whatIf: true, transmit: true, action: OrderAction.SELL, orderType: OrderType.LMT } as Order;

function asIb(fake: FakeIb) {
  return fake as unknown as Parameters<typeof allocateWhatIfOrderId>[0];
}

const placeholderOrderState = { commission: 0 };
const realOrderState = { minCommission: 1.5, maxCommission: 2.25 };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.readExpectedAccountId.mockReset().mockReturnValue("DU12345");
  mocks.borrowSharedConnectionOrConnect.mockReset();
  mocks.resolveContractId.mockReset();
  mocks.nextReqIdForCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("allocateWhatIfOrderId", () => {
  it("asks IBKR for the first valid id once and hands out consecutive ids afterwards without asking again", async () => {
    const ib = createFakeIb();
    ib.reqIds.mockImplementation(() => ib.emit(EventName.nextValidId, 700));
    expect(await allocateWhatIfOrderId(asIb(ib))).toBe(700);
    expect(await allocateWhatIfOrderId(asIb(ib))).toBe(701);
    expect(await allocateWhatIfOrderId(asIb(ib))).toBe(702);
    expect(ib.reqIds).toHaveBeenCalledTimes(1);
    expect(ib.reqIds).toHaveBeenCalledWith(1);
  });

  it("keeps a separate counter per connection", async () => {
    const first = createFakeIb();
    const second = createFakeIb();
    first.reqIds.mockImplementation(() => first.emit(EventName.nextValidId, 10));
    second.reqIds.mockImplementation(() => second.emit(EventName.nextValidId, 500));
    expect(await allocateWhatIfOrderId(asIb(first))).toBe(10);
    expect(await allocateWhatIfOrderId(asIb(second))).toBe(500);
    expect(await allocateWhatIfOrderId(asIb(first))).toBe(11);
  });

  it("gives concurrent first callers on one connection distinct ids", async () => {
    const ib = createFakeIb();
    ib.reqIds.mockImplementation(() => setTimeout(() => ib.emit(EventName.nextValidId, 40), 100));
    const pending = Promise.all([allocateWhatIfOrderId(asIb(ib)), allocateWhatIfOrderId(asIb(ib)), allocateWhatIfOrderId(asIb(ib))]);
    await vi.advanceTimersByTimeAsync(100);
    const ids = await pending;
    expect(new Set(ids).size).toBe(3);
    expect(Math.min(...ids)).toBe(40);
    expect(Math.max(...ids)).toBe(42);
  });

  it("rejects after 5 s without an id and detaches its listener", async () => {
    const ib = createFakeIb();
    const outcome = allocateWhatIfOrderId(asIb(ib)).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ib.listenerCount(EventName.nextValidId)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe("IBKR did not return a valid order id.");
    expect(ib.listenerCount(EventName.nextValidId)).toBe(0);
  });

  it("can retry successfully after a timeout", async () => {
    const ib = createFakeIb();
    const failed = allocateWhatIfOrderId(asIb(ib)).catch(() => "failed");
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    ib.reqIds.mockImplementation(() => ib.emit(EventName.nextValidId, 90));
    expect(await allocateWhatIfOrderId(asIb(ib))).toBe(90);
  });
});

describe("requestWhatIfCommissionRange", () => {
  it("refuses to send anything that is not a what-if order, without touching the connection", () => {
    const ib = createFakeIb();
    expect(() => requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, { ...whatIfOrder, whatIf: false })).toThrow("Refusing to send a non-what-if order from the web process.");
    expect(() => requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, { ...whatIfOrder, whatIf: undefined })).toThrow("Refusing to send a non-what-if order from the web process.");
    expect(ib.placeOrder).not.toHaveBeenCalled();
    expect(ib.listenerCount(EventName.openOrder)).toBe(0);
  });

  it("places the what-if under the given order id and resolves with the range from the second order state", async () => {
    const ib = createFakeIb();
    const result = requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, whatIfOrder);
    expect(ib.placeOrder).toHaveBeenCalledWith(5, whatIfContract, whatIfOrder);
    ib.emit(EventName.openOrder, 5, whatIfContract, whatIfOrder, placeholderOrderState);
    ib.emit(EventName.openOrder, 5, whatIfContract, whatIfOrder, realOrderState);
    await expect(result).resolves.toEqual({ minDollars: 1.5, maxDollars: 2.25 });
  });

  it("keeps listening past an order state without a usable commission", async () => {
    const ib = createFakeIb();
    const result = requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, whatIfOrder);
    ib.emit(EventName.openOrder, 5, whatIfContract, whatIfOrder, { commission: 1.7976931348623157e308 });
    ib.emit(EventName.openOrder, 5, whatIfContract, whatIfOrder, {});
    expect(ib.listenerCount(EventName.openOrder)).toBe(1);
    ib.emit(EventName.openOrder, 5, whatIfContract, whatIfOrder, { commission: 1.0 });
    await expect(result).resolves.toEqual({ minDollars: 1, maxDollars: 1 });
  });

  it("ignores order states and errors that belong to other order ids", async () => {
    const ib = createFakeIb();
    const result = requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, whatIfOrder);
    ib.emit(EventName.openOrder, 6, whatIfContract, whatIfOrder, realOrderState);
    ib.emit(EventName.error, new Error("other order rejected"), 201, 6);
    expect(ib.listenerCount(EventName.openOrder)).toBe(1);
    ib.emit(EventName.openOrder, 5, whatIfContract, whatIfOrder, realOrderState);
    await expect(result).resolves.toEqual({ minDollars: 1.5, maxDollars: 2.25 });
  });

  it("rejects with the IBKR code and message when IBKR rejects the what-if", async () => {
    const ib = createFakeIb();
    const result = requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, whatIfOrder);
    ib.emit(EventName.error, new Error("Order rejected - reason: insufficient permissions"), 321, 5);
    await expect(result).rejects.toThrow("IBKR what-if rejected (321): Order rejected - reason: insufficient permissions");
  });

  it("times out after 12 s, not earlier", async () => {
    const ib = createFakeIb();
    const outcome = requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, whatIfOrder).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(ib.listenerCount(EventName.openOrder)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe("IBKR what-if timed out.");
  });

  it("removes both listeners and its timer however it settles", async () => {
    for (const settle of [
      (ib: FakeIb) => ib.emit(EventName.openOrder, 5, whatIfContract, whatIfOrder, realOrderState),
      (ib: FakeIb) => ib.emit(EventName.error, new Error("rejected"), 321, 5),
    ]) {
      const ib = createFakeIb();
      const result = requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, whatIfOrder).catch(() => "rejected");
      settle(ib);
      await result;
      expect(ib.listenerCount(EventName.openOrder)).toBe(0);
      expect(ib.listenerCount(EventName.error)).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles once: a rejection after the range arrived changes nothing", async () => {
    const ib = createFakeIb();
    ib.on(EventName.error, () => {});
    const result = requestWhatIfCommissionRange(asIb(ib), 5, whatIfContract, whatIfOrder);
    ib.emit(EventName.openOrder, 5, whatIfContract, whatIfOrder, realOrderState);
    ib.emit(EventName.error, new Error("late"), 321, 5);
    await expect(result).resolves.toEqual({ minDollars: 1.5, maxDollars: 2.25 });
  });
});

describe("fetchWhatIfCommissionRange", () => {
  function borrowedConnection(ib: FakeIb) {
    const disconnect = vi.fn();
    mocks.borrowSharedConnectionOrConnect.mockResolvedValue({ ib, disconnect });
    return disconnect;
  }

  it("builds a single-leg what-if for the expected account, requests it and releases the connection", async () => {
    const ib = createFakeIb();
    const disconnect = borrowedConnection(ib);
    ib.reqIds.mockImplementation(() => ib.emit(EventName.nextValidId, 800));
    mocks.resolveContractId.mockResolvedValue(111);
    ib.placeOrder.mockImplementation((orderId: number) => ib.emit(EventName.openOrder, orderId, {}, {}, realOrderState));

    const range = await fetchWhatIfCommissionRange([soldCall]);

    expect(range).toEqual({ minDollars: 1.5, maxDollars: 2.25 });
    expect(mocks.borrowSharedConnectionOrConnect).toHaveBeenCalledWith(expect.anything(), "fetchWhatIfCommissionRange");
    const [orderId, contract, order] = ib.placeOrder.mock.calls[0]!;
    expect(orderId).toBe(800);
    expect(contract).toMatchObject({ conId: 111, secType: "OPT" });
    expect(order).toMatchObject({ whatIf: true, transmit: true, account: "DU12345", action: OrderAction.SELL, totalQuantity: 3, lmtPrice: 1.2 });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("uses a pre-resolved contract id without asking IBKR to resolve it", async () => {
    const ib = createFakeIb();
    borrowedConnection(ib);
    ib.reqIds.mockImplementation(() => ib.emit(EventName.nextValidId, 800));
    ib.placeOrder.mockImplementation((orderId: number) => ib.emit(EventName.openOrder, orderId, {}, {}, realOrderState));
    await fetchWhatIfCommissionRange([{ ...soldCall, ibkrContractId: 4242 }]);
    expect(mocks.resolveContractId).not.toHaveBeenCalled();
    expect(ib.placeOrder.mock.calls[0]![1]).toMatchObject({ conId: 4242 });
  });

  it("resolves each unresolved leg in order and builds a combo with reduced ratios", async () => {
    const ib = createFakeIb();
    borrowedConnection(ib);
    ib.reqIds.mockImplementation(() => ib.emit(EventName.nextValidId, 800));
    mocks.resolveContractId.mockResolvedValueOnce(222).mockResolvedValueOnce(111);
    ib.placeOrder.mockImplementation((orderId: number) => ib.emit(EventName.openOrder, orderId, {}, {}, realOrderState));

    await fetchWhatIfCommissionRange([boughtShares, soldCall]);

    expect(mocks.resolveContractId).toHaveBeenCalledTimes(2);
    expect(mocks.resolveContractId.mock.calls[0]![1]).toMatchObject({ secType: "STK", symbol: "AAOI" });
    expect(mocks.resolveContractId.mock.calls[1]![1]).toMatchObject({ secType: "OPT", symbol: "AAOI" });
    const [, contract, order] = ib.placeOrder.mock.calls[0]!;
    expect(contract.secType).toBe("BAG");
    expect(contract.comboLegs.map((leg: { conId: number; ratio: number }) => [leg.conId, leg.ratio])).toEqual([[222, 100], [111, 1]]);
    expect(order).toMatchObject({ whatIf: true, account: "DU12345", totalQuantity: 3 });
  });

  it("uses distinct fallback request ids for the contract lookups of a one-shot connection", async () => {
    const ib = createFakeIb();
    borrowedConnection(ib);
    ib.reqIds.mockImplementation(() => ib.emit(EventName.nextValidId, 800));
    mocks.resolveContractId.mockResolvedValueOnce(222).mockResolvedValueOnce(111);
    ib.placeOrder.mockImplementation((orderId: number) => ib.emit(EventName.openOrder, orderId, {}, {}, realOrderState));
    await fetchWhatIfCommissionRange([boughtShares, soldCall]);
    expect(mocks.nextReqIdForCalls).toEqual([90_000, 90_001]);
  });

  it("throws when IBKR cannot resolve a leg's contract, names the leg, sends no order and still releases the connection", async () => {
    const ib = createFakeIb();
    const disconnect = borrowedConnection(ib);
    mocks.resolveContractId.mockResolvedValue(null);
    await expect(fetchWhatIfCommissionRange([soldCall])).rejects.toThrow("IBKR could not resolve the option contract for AAOI.");
    expect(ib.placeOrder).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("releases the connection when IBKR rejects the what-if", async () => {
    const ib = createFakeIb();
    const disconnect = borrowedConnection(ib);
    ib.reqIds.mockImplementation(() => ib.emit(EventName.nextValidId, 800));
    mocks.resolveContractId.mockResolvedValue(111);
    ib.placeOrder.mockImplementation((orderId: number) => ib.emit(EventName.error, new Error("not permitted"), 321, orderId));
    await expect(fetchWhatIfCommissionRange([soldCall])).rejects.toThrow("IBKR what-if rejected (321): not permitted");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("fails before connecting when the expected account id is not configured", async () => {
    mocks.readExpectedAccountId.mockImplementation(() => {
      throw new Error("Missing required environment variable: IBKR_EXPECTED_ACCOUNT_ID");
    });
    await expect(fetchWhatIfCommissionRange([soldCall])).rejects.toThrow("IBKR_EXPECTED_ACCOUNT_ID");
    expect(mocks.borrowSharedConnectionOrConnect).not.toHaveBeenCalled();
  });

  it("propagates a connection failure", async () => {
    mocks.borrowSharedConnectionOrConnect.mockRejectedValue(new Error("tunnel down"));
    await expect(fetchWhatIfCommissionRange([soldCall])).rejects.toThrow("tunnel down");
  });

  it("releases the connection even when the order id request times out", async () => {
    const ib = createFakeIb();
    const disconnect = borrowedConnection(ib);
    mocks.resolveContractId.mockResolvedValue(111);
    const outcome = fetchWhatIfCommissionRange([soldCall]).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(outcome).resolves.toBe("IBKR did not return a valid order id.");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(ib.placeOrder).not.toHaveBeenCalled();
  });
});
