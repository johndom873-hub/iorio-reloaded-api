import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeIb = Object.assign(new EventEmitter(), { reqMktData: vi.fn(), cancelMktData: vi.fn(), reqMarketDataType: vi.fn() });
let nextReqId = 100;
let borrowShouldFail = false;

vi.mock("./sharedReadConnection.js", () => ({
  sharedLiveConnection: {
    borrow: async () => {
      if (borrowShouldFail) throw new Error("connection unavailable");
      return { ib: fakeIb };
    },
    allocateReqId: () => nextReqId++,
  },
}));
vi.mock("./marketDataLineBudget.js", () => ({
  reserveMarketDataLines: async () => ({ ok: true, availableLines: 90, priorityLinesHeld: 0 }),
  releaseMarketDataLines: async () => {},
}));
vi.mock("../lib/priceService.js", () => ({ loadFallbackStockPrices: async () => new Map() }));
const broadcast = vi.fn();
vi.mock("../lib/notificationBroadcaster.js", () => ({ broadcastToLocalSubscribers: (notification: unknown) => broadcast(notification) }));

const { marketDataFeedRefusal, subscribeToPooledQuote } = await import("./marketDataPool.js");

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("marketDataPool feed refusal (IBKR 10197, live account logged in elsewhere)", () => {
  beforeEach(() => broadcast.mockClear());

  it("reports the refusal once, pushes it, and clears it on the next real price", async () => {
    const unsubscribe = await subscribeToPooledQuote({ key: "AAOI", legType: "stock", symbol: "AAOI" }, () => {});
    await settle();
    const reqId = fakeIb.reqMktData.mock.calls.at(-1)![0] as number;

    fakeIb.emit(EventName.error, new Error("No market data during competing live session"), 10197, reqId);
    fakeIb.emit(EventName.error, new Error("No market data during competing live session"), 10197, reqId);
    expect(marketDataFeedRefusal()).toMatchObject({ code: 10197, message: "No market data during competing live session" });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ type: "market_data_feed", refusal: expect.objectContaining({ code: 10197 }) }));

    // IBKR's -1 "no data" and non-price ticks (high/low/close) don't prove data is flowing.
    fakeIb.emit(EventName.tickPrice, reqId, 4, -1);
    fakeIb.emit(EventName.tickPrice, reqId, 9, 101.4);
    expect(marketDataFeedRefusal()).not.toBeNull();

    fakeIb.emit(EventName.tickPrice, reqId, 1, 99.6);
    expect(marketDataFeedRefusal()).toBeNull();
    expect(broadcast).toHaveBeenLastCalledWith({ type: "market_data_feed", refusal: null });
    expect(broadcast).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("ignores other error codes and errors for requests outside the pool", async () => {
    const unsubscribe = await subscribeToPooledQuote({ key: "MU", legType: "stock", symbol: "MU" }, () => {});
    await settle();
    const reqId = fakeIb.reqMktData.mock.calls.at(-1)![0] as number;
    fakeIb.emit(EventName.error, new Error("not subscribed"), 354, reqId);
    fakeIb.emit(EventName.error, new Error("competing"), 10197, 999_999);
    expect(marketDataFeedRefusal()).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("marketDataPool feed refusal re-check (market closed: no bid/ask/last tick ever clears it)", () => {
  const competingSessionMessage = "No market data during competing live session";
  const recheckIntervalMs = 60_000;
  const probeTimeoutMs = 5_000;

  beforeEach(() => {
    broadcast.mockClear();
    fakeIb.reqMktData.mockClear();
    fakeIb.cancelMktData.mockClear();
    borrowShouldFail = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => vi.useRealTimers());

  async function raiseRefusal(symbol: string) {
    const unsubscribe = await subscribeToPooledQuote({ key: symbol, legType: "stock", symbol }, () => {});
    await settle();
    const poolReqId = fakeIb.reqMktData.mock.calls.at(-1)![0] as number;
    fakeIb.emit(EventName.error, new Error(competingSessionMessage), 10197, poolReqId);
    expect(marketDataFeedRefusal()).not.toBeNull();
    return { poolReqId, unsubscribe };
  }

  function lastProbeCall() {
    const [reqId, contract] = fakeIb.reqMktData.mock.calls.at(-1)! as [number, { symbol: string }];
    return { reqId, symbol: contract.symbol };
  }

  it("clears the refusal when a fresh SPY subscription gets a price, then stops probing", async () => {
    const { unsubscribe } = await raiseRefusal("RECHK1");
    const callsBeforeProbe = fakeIb.reqMktData.mock.calls.length;

    await vi.advanceTimersByTimeAsync(recheckIntervalMs - 1);
    expect(fakeIb.reqMktData.mock.calls.length).toBe(callsBeforeProbe);
    await vi.advanceTimersByTimeAsync(1);
    expect(fakeIb.reqMktData.mock.calls.length).toBe(callsBeforeProbe + 1);
    const probe = lastProbeCall();
    expect(probe.symbol).toBe("SPY");

    // The close tick is all a closed market sends.
    fakeIb.emit(EventName.tickPrice, probe.reqId, 9, 101.4);
    await settle();
    expect(marketDataFeedRefusal()).toBeNull();
    expect(broadcast).toHaveBeenLastCalledWith({ type: "market_data_feed", refusal: null });

    await vi.advanceTimersByTimeAsync(recheckIntervalMs * 3);
    expect(fakeIb.reqMktData.mock.calls.length).toBe(callsBeforeProbe + 1);
    unsubscribe();
  });

  it("keeps the refusal while the probe is refused or times out, and keeps probing", async () => {
    const { poolReqId, unsubscribe } = await raiseRefusal("RECHK2");
    const callsBeforeProbe = fakeIb.reqMktData.mock.calls.length;

    await vi.advanceTimersByTimeAsync(recheckIntervalMs);
    const refusedProbe = lastProbeCall();
    fakeIb.emit(EventName.error, new Error(competingSessionMessage), 10197, refusedProbe.reqId);
    await settle();
    expect(marketDataFeedRefusal()).not.toBeNull();
    expect(fakeIb.cancelMktData).toHaveBeenCalledWith(refusedProbe.reqId);

    await vi.advanceTimersByTimeAsync(recheckIntervalMs);
    expect(lastProbeCall().reqId).not.toBe(refusedProbe.reqId);
    await vi.advanceTimersByTimeAsync(probeTimeoutMs);
    expect(marketDataFeedRefusal()).not.toBeNull();
    expect(fakeIb.reqMktData.mock.calls.length).toBe(callsBeforeProbe + 2);

    fakeIb.emit(EventName.tickPrice, poolReqId, 1, 99.6);
    expect(marketDataFeedRefusal()).toBeNull();
    unsubscribe();
  });

  it("survives an unavailable connection and clears on a later probe", async () => {
    const { unsubscribe } = await raiseRefusal("RECHK3");
    const callsBeforeProbe = fakeIb.reqMktData.mock.calls.length;

    borrowShouldFail = true;
    await vi.advanceTimersByTimeAsync(recheckIntervalMs);
    expect(fakeIb.reqMktData.mock.calls.length).toBe(callsBeforeProbe);
    expect(marketDataFeedRefusal()).not.toBeNull();

    borrowShouldFail = false;
    await vi.advanceTimersByTimeAsync(recheckIntervalMs);
    fakeIb.emit(EventName.tickPrice, lastProbeCall().reqId, 9, 101.4);
    await settle();
    expect(marketDataFeedRefusal()).toBeNull();
    unsubscribe();
  });
});
