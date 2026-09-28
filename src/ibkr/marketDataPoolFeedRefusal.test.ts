import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeIb = Object.assign(new EventEmitter(), { reqMktData: vi.fn(), cancelMktData: vi.fn() });
let nextReqId = 100;

vi.mock("./sharedReadConnection.js", () => ({
  sharedLiveConnection: { borrow: async () => ({ ib: fakeIb }), allocateReqId: () => nextReqId++ },
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
