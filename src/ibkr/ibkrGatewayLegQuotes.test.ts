import { EventEmitter } from "node:events";
import { EventName, MarketDataType, type IBApi } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderLegPayload } from "./ibkrGatewayOrderPayload.js";
import { fetchLegQuoteSnapshots, legQuoteSnapshotTimeoutMs } from "./ibkrGatewayLegQuotes.js";

class FakeIbApi extends EventEmitter {
  reqMarketDataType = vi.fn();
  reqMktData = vi.fn();
  cancelMktData = vi.fn();
}

const bid = 1;
const ask = 2;
const delayedBid = 66;
const delayedAsk = 67;

const stockLeg = { role: "stock", action: "BUY", symbol: "AAOI", quantity: 200, unitPrice: 48.2 } as OrderLegPayload;
const putLeg = { role: "option", action: "SELL", symbol: "AAOI", quantity: 2, unitPrice: 1.35, strike: 50, expiry: "20261016", right: "P" } as OrderLegPayload;

function start(legs: OrderLegPayload[], timeoutMs?: number) {
  const ib = new FakeIbApi();
  let nextId = 100;
  const result = fetchLegQuoteSnapshots(ib as unknown as IBApi, legs, { timeoutMs, allocateRequestId: () => nextId++ });
  const tick = (requestId: number, field: number, price: number) => ib.emit(EventName.tickPrice, requestId, field, price);
  return { ib, result, tick };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fetchLegQuoteSnapshots", () => {
  it("asks for real-time data and one snapshot (not a streaming line) per leg, with the leg's own contract", async () => {
    const { ib, result, tick } = start([stockLeg, putLeg]);
    expect(ib.reqMarketDataType).toHaveBeenCalledWith(MarketDataType.REALTIME);
    expect(ib.reqMktData).toHaveBeenCalledTimes(2);
    const calls = ib.reqMktData.mock.calls as [number, Record<string, unknown>, string, boolean, boolean][];
    const [stockId, stockContract, , stockSnapshot] = calls[0]!;
    const [optionId, optionContract, , optionSnapshot] = calls[1]!;
    expect([stockId, optionId]).toEqual([100, 101]);
    expect(stockContract).toMatchObject({ symbol: "AAOI", secType: "STK" });
    expect(optionContract).toMatchObject({ symbol: "AAOI", secType: "OPT", strike: 50, lastTradeDateOrContractMonth: "20261016" });
    expect(stockSnapshot && optionSnapshot).toBe(true);
    for (const id of [100, 101]) {
      tick(id, bid, 1);
      tick(id, ask, 1.1);
    }
    await result;
  });

  it("resolves as soon as every leg has both sides, without waiting for the timeout, and releases everything", async () => {
    const { ib, result, tick } = start([stockLeg, putLeg]);
    tick(100, bid, 48.15);
    tick(100, ask, 48.25);
    tick(101, bid, 1.3);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    tick(101, ask, 1.4);
    expect(await result).toEqual({ quotes: [{ bid: 48.15, ask: 48.25 }, { bid: 1.3, ask: 1.4 }], notes: [] });
    expect(ib.cancelMktData.mock.calls.map((call) => call[0])).toEqual([100, 101]);
    expect(ib.listenerCount(EventName.tickPrice)).toBe(0);
    expect(ib.listenerCount(EventName.tickSnapshotEnd)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
  });

  it("a snapshot that ends with only one side leaves the other null", async () => {
    const { ib, result, tick } = start([putLeg]);
    tick(100, bid, 1.3);
    ib.emit(EventName.tickSnapshotEnd, 100);
    expect(await result).toEqual({ quotes: [{ bid: 1.3, ask: null }], notes: [] });
  });

  it("gives up at the timeout with whatever arrived, and still cancels and detaches", async () => {
    const { ib, result, tick } = start([putLeg]);
    tick(100, ask, 1.4);
    await vi.advanceTimersByTimeAsync(legQuoteSnapshotTimeoutMs);
    expect(await result).toEqual({ quotes: [{ bid: null, ask: 1.4 }], notes: [] });
    expect(ib.cancelMktData).toHaveBeenCalledWith(100);
    expect(ib.listenerCount(EventName.tickPrice)).toBe(0);
  });

  it("honours a shorter timeout", async () => {
    const { result } = start([putLeg], 500);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).quotes).toEqual([{ bid: null, ask: null }]);
  });

  it("ignores a -1 (no quote) side, keeps a zero bid, and ignores other tick types and other requests' ticks", async () => {
    const { ib, result, tick } = start([putLeg]);
    tick(100, bid, -1);
    tick(100, 4, 9.99); // last price
    tick(999, ask, 5); // someone else's request
    tick(100, bid, 0);
    tick(100, ask, 0.05);
    expect(await result).toEqual({ quotes: [{ bid: 0, ask: 0.05 }], notes: [] });
    expect(ib.cancelMktData).toHaveBeenCalledTimes(1);
  });

  it("does not accept delayed quotes as a real-time quote, and says so", async () => {
    const { ib, result, tick } = start([putLeg]);
    tick(100, delayedBid, 1.3);
    tick(100, delayedAsk, 1.4);
    ib.emit(EventName.tickSnapshotEnd, 100);
    const outcome = await result;
    expect(outcome.quotes).toEqual([{ bid: null, ask: null }]);
    expect(outcome.notes).toEqual(["IBKR sent only delayed quotes for leg 1 (the account is not entitled to real-time data for it)"]);
  });

  it("an IBKR error for a leg is reported and ends the wait for that leg; informational notices are not errors", async () => {
    const { ib, result } = start([putLeg]);
    ib.emit(EventName.error, new Error("Delayed market data is available"), 10167, 100);
    ib.emit(EventName.error, new Error("Market data farm is connecting"), 2104, 100);
    ib.emit(EventName.error, new Error("Requested market data is not subscribed"), 354, 100);
    expect(await result).toEqual({ quotes: [{ bid: null, ask: null }], notes: ["IBKR error 354 for leg 1: Requested market data is not subscribed"] });
  });

  it("an error for another request is none of its business", async () => {
    const { ib, result, tick } = start([putLeg]);
    ib.emit(EventName.error, new Error("order rejected"), 201, 7);
    tick(100, bid, 1);
    tick(100, ask, 1.1);
    expect((await result).notes).toEqual([]);
  });

  it("has nothing to wait for with no legs", async () => {
    const { ib, result } = start([]);
    expect(await result).toEqual({ quotes: [], notes: [] });
    expect(ib.reqMktData).not.toHaveBeenCalled();
  });

  it("cancels and detaches even when requesting a snapshot throws", async () => {
    const ib = new FakeIbApi();
    ib.reqMktData.mockImplementation(() => {
      throw new Error("not connected");
    });
    await expect(fetchLegQuoteSnapshots(ib as unknown as IBApi, [putLeg], { allocateRequestId: () => 100 })).rejects.toThrow("not connected");
    expect(ib.cancelMktData).toHaveBeenCalledWith(100);
    expect(ib.listenerCount(EventName.tickPrice)).toBe(0);
  });
});
