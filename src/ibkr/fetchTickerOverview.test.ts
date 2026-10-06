import { EventEmitter } from "node:events";
import { BarSizeSetting, EventName, WhatToShow } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserveResult: { ok: true, availableLines: 90, priorityLinesHeld: 0 } as { ok: boolean; availableLines: number; priorityLinesHeld: number; disabled?: boolean },
  reservations: [] as { holder: string; lines: number; ttlSeconds: number }[],
  releases: [] as string[],
  releaseError: null as Error | null,
  recordedPrices: [] as unknown[],
  connection: null as unknown,
  disconnect: vi.fn(),
  realtimeRequests: [] as unknown[],
}));
vi.mock("./marketDataLineBudget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./marketDataLineBudget.js")>()),
  reserveMarketDataLines: async (holder: string, lines: number, ttlSeconds: number) => {
    mocks.reservations.push({ holder, lines, ttlSeconds });
    return mocks.reserveResult;
  },
  releaseMarketDataLines: async (holder: string) => {
    mocks.releases.push(holder);
    if (mocks.releaseError) throw mocks.releaseError;
  },
}));
vi.mock("../lib/priceService.js", () => ({ recordStockPrices: async (entries: unknown) => void mocks.recordedPrices.push(entries) }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: async () => ({ ib: (mocks.connection as { ib: unknown }).ib, disconnect: mocks.disconnect }) }));
vi.mock("./requestMarketData.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./requestMarketData.js")>()),
  requestRealtimeMarketData: (ib: unknown) => void mocks.realtimeRequests.push(ib),
}));

import { fetchHistoricalBarsRaw, fetchPriceBars, lookupHistoricalBars, lookupLatestDailyBar, lookupPricingSnapshot } from "./fetchTickerOverview.js";

class FakeIbApi extends EventEmitter {
  reqMktData = vi.fn();
  cancelMktData = vi.fn();
  reqHistoricalData = vi.fn();
}

const asConnection = (ib: FakeIbApi) => ({ ib, disconnect: vi.fn() }) as unknown as Parameters<typeof lookupPricingSnapshot>[0];

function emitBar(ib: FakeIbApi, reqId: number, date: string, close: number, volume = 100): void {
  ib.emit(EventName.historicalData, reqId, date, close - 1, close + 1, close - 2, close, volume, 10, close, false);
}
const finish = (ib: FakeIbApi, reqId: number) => emitBar(ib, reqId, "finished-20260101  20260102", -1, -1);

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(mocks, { reserveResult: { ok: true, availableLines: 90, priorityLinesHeld: 0 }, releaseError: null });
  mocks.reservations.length = 0;
  mocks.releases.length = 0;
  mocks.recordedPrices.length = 0;
  mocks.realtimeRequests.length = 0;
  mocks.disconnect.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lookupPricingSnapshot", () => {
  it("reserves one line for 20 seconds, subscribes to a snapshot of the stock and releases the line afterwards", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 7);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reservations).toHaveLength(1);
    expect(mocks.reservations[0]).toMatchObject({ lines: 1, ttlSeconds: 20 });
    expect(mocks.reservations[0]!.holder).toMatch(/^snapshot:pricing:AAPL:[0-9a-f-]{36}$/);
    expect(ib.reqMktData).toHaveBeenCalledWith(7, expect.objectContaining({ symbol: "AAPL", secType: "STK", exchange: "SMART", currency: "USD" }), "", true, false);
    ib.emit(EventName.tickSnapshotEnd, 7);
    await result;
    expect(mocks.releases).toEqual([mocks.reservations[0]!.holder]);
  });

  it("fails with the shortage message and subscribes to nothing when no line is available", async () => {
    mocks.reserveResult = { ok: false, availableLines: 0, priorityLinesHeld: 0 };
    const ib = new FakeIbApi();
    await expect(lookupPricingSnapshot(asConnection(ib), "AAPL")).rejects.toThrow("IBKR market data is busy (another live view) — AAPL pricing needs 1 lines, only 0 available. Try again shortly.");
    expect(ib.reqMktData).not.toHaveBeenCalled();
    expect(mocks.releases).toEqual([]);
  });

  it("maps real-time and delayed tick types to the pricing fields and resolves on the snapshot end", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2);
    await vi.advanceTimersByTimeAsync(0);
    const price = (tickType: number, value: number) => ib.emit(EventName.tickPrice, 2, tickType, value);
    price(1, 99.5);
    price(2, 100.5);
    price(4, 100);
    price(6, 105);
    price(7, 95);
    price(9, 98);
    price(14, 97);
    ib.emit(EventName.tickSize, 2, 8, 12_345);
    ib.emit(EventName.tickSnapshotEnd, 2);
    expect(await result).toEqual({ last: 100, bid: 99.5, ask: 100.5, open: 97, high: 105, low: 95, previousClose: 98, volume: 12_345 });
  });

  it("accepts the delayed tick types (66, 67, 68, 72, 73, 75, 76, 74) too", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2);
    await vi.advanceTimersByTimeAsync(0);
    for (const [tickType, value] of [[66, 1], [67, 2], [68, 3], [72, 4], [73, 5], [75, 6], [76, 7]] as const) ib.emit(EventName.tickPrice, 2, tickType, value);
    ib.emit(EventName.tickSize, 2, 74, 500);
    ib.emit(EventName.tickSnapshotEnd, 2);
    expect(await result).toEqual({ bid: 1, ask: 2, last: 3, high: 4, low: 5, previousClose: 6, open: 7, volume: 500 });
  });

  it("turns IBKR's -1 and 0 'no data' prices into null, clearing an earlier real value", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickPrice, 2, 1, 99);
    ib.emit(EventName.tickPrice, 2, 1, -1);
    ib.emit(EventName.tickPrice, 2, 2, 0);
    ib.emit(EventName.tickSnapshotEnd, 2);
    expect(await result).toMatchObject({ bid: null, ask: null });
  });

  it("ignores ticks, sizes and snapshot ends for other requests", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickPrice, 9, 4, 500);
    ib.emit(EventName.tickSize, 9, 8, 500);
    ib.emit(EventName.tickSnapshotEnd, 9);
    let settled = false;
    void result.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    ib.emit(EventName.tickSnapshotEnd, 2);
    expect(await result).toMatchObject({ last: null, volume: null });
  });

  it("ignores a size tick with no size, and non-volume size ticks", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickSize, 2, 8, undefined);
    ib.emit(EventName.tickSize, 2, 0, 77);
    ib.emit(EventName.tickSnapshotEnd, 2);
    expect(await result).toMatchObject({ volume: null });
  });

  it("records each real last price as the shared live price", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickPrice, 2, 4, 100.25);
    ib.emit(EventName.tickPrice, 2, 4, -1);
    ib.emit(EventName.tickSnapshotEnd, 2);
    await result;
    expect(mocks.recordedPrices).toEqual([[{ symbol: "AAPL", price: 100.25, source: "live" }]]);
  });

  it("with resolveOnFirstLast, resolves on the first real last with what has arrived, cancelling the subscription and listeners", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2, { resolveOnFirstLast: true });
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickPrice, 2, 1, 99);
    ib.emit(EventName.tickPrice, 2, 4, -1);
    ib.emit(EventName.tickPrice, 2, 4, 100);
    ib.emit(EventName.tickPrice, 2, 2, 101);
    expect(await result).toEqual({ last: 100, bid: 99, ask: null, open: null, high: null, low: null, previousClose: null, volume: null });
    expect(ib.cancelMktData).toHaveBeenCalledWith(2);
    expect(ib.listenerCount(EventName.tickPrice)).toBe(0);
    expect(ib.listenerCount(EventName.tickSnapshotEnd)).toBe(0);
  });

  it("times out after 10 s with the generic message, cancelling the subscription", async () => {
    const ib = new FakeIbApi();
    const captured = lookupPricingSnapshot(asConnection(ib), "AAPL", 2).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await captured) as Error).message).toBe("Pricing snapshot timeout for AAPL");
    expect(ib.cancelMktData).toHaveBeenCalledWith(2);
    expect(ib.listenerCount(EventName.error)).toBe(0);
    expect(mocks.releases).toHaveLength(1);
  });

  it("explains a timeout with the last real IBKR error for its request and logs it, but not delayed-data notices", async () => {
    const ib = new FakeIbApi();
    const captured = lookupPricingSnapshot(asConnection(ib), "AAPL", 2).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("Requested market data is not subscribed. Displaying delayed market data."), 10167, 2);
    ib.emit(EventName.error, new Error("other request"), 200, 9);
    expect(console.warn).not.toHaveBeenCalled();
    ib.emit(EventName.error, new Error("No security definition has been found"), 200, 2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await captured) as Error).message).toBe("Pricing snapshot error for AAPL (code 200): No security definition has been found");
    expect(console.warn).toHaveBeenCalledWith("IBKR pricing snapshot warning for AAPL (code 200): No security definition has been found");
  });

  it("does not fail a request on an error that is followed by ticks", async () => {
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("notice"), 2104, 2);
    ib.emit(EventName.tickPrice, 2, 4, 50);
    ib.emit(EventName.tickSnapshotEnd, 2);
    expect(await result).toMatchObject({ last: 50 });
  });

  it("does not fail when releasing the line fails", async () => {
    mocks.releaseError = new Error("db down");
    const ib = new FakeIbApi();
    const result = lookupPricingSnapshot(asConnection(ib), "AAPL", 2);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickSnapshotEnd, 2);
    await expect(result).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to release IBKR market data line reservation snapshot:pricing:AAPL:"));
  });
});

describe("fetchHistoricalBarsRaw and bar time parsing", () => {
  it("requests the stock's bars with regular-hours-only, epoch-seconds dates and no keep-up-to-date", async () => {
    const ib = new FakeIbApi();
    const result = fetchHistoricalBarsRaw(asConnection(ib), "AAPL", BarSizeSetting.HOURS_ONE, "3 M", 5);
    expect(ib.reqHistoricalData).toHaveBeenCalledWith(5, expect.objectContaining({ symbol: "AAPL", secType: "STK", exchange: "SMART", currency: "USD" }), "", "3 M", BarSizeSetting.HOURS_ONE, WhatToShow.TRADES, 1, 2, false);
    finish(ib, 5);
    expect(await result).toEqual([]);
  });

  it("parses intraday epoch-second dates as numbers and YYYYMMDD dates as UTC midnight, trimming whitespace", async () => {
    const ib = new FakeIbApi();
    const result = fetchHistoricalBarsRaw(asConnection(ib), "AAPL", BarSizeSetting.DAYS_ONE, "1 Y", 1);
    emitBar(ib, 1, "1767614400", 100, 5);
    emitBar(ib, 1, "20260105", 101, 6);
    emitBar(ib, 1, " 20260106 ", 102, 7);
    finish(ib, 1);
    expect(await result).toEqual([
      { time: 1_767_614_400, open: 99, high: 101, low: 98, close: 100, volume: 5 },
      { time: Date.UTC(2026, 0, 5) / 1000, open: 100, high: 102, low: 99, close: 101, volume: 6 },
      { time: Date.UTC(2026, 0, 6) / 1000, open: 101, high: 103, low: 100, close: 102, volume: 7 },
    ]);
  });

  it("ignores bars and errors of other requests", async () => {
    const ib = new FakeIbApi();
    const result = fetchHistoricalBarsRaw(asConnection(ib), "AAPL", BarSizeSetting.DAYS_ONE, "1 Y", 1);
    emitBar(ib, 2, "20260105", 999);
    ib.emit(EventName.error, new Error("other"), 162, 2);
    emitBar(ib, 1, "20260105", 100);
    finish(ib, 1);
    expect(await result).toHaveLength(1);
  });

  it("rejects on an error for its request, naming symbol and code, and removes its listeners", async () => {
    const ib = new FakeIbApi();
    const captured = fetchHistoricalBarsRaw(asConnection(ib), "AAPL", BarSizeSetting.DAYS_ONE, "1 Y", 1).catch((error: Error) => error);
    ib.emit(EventName.error, new Error("HMDS query returned no data"), 162, 1);
    expect(((await captured) as Error).message).toBe("Historical data error for AAPL (code 162): HMDS query returned no data");
    expect(ib.listenerCount(EventName.historicalData)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
  });

  it("times out after 20 s", async () => {
    const ib = new FakeIbApi();
    const captured = fetchHistoricalBarsRaw(asConnection(ib), "AAPL", BarSizeSetting.DAYS_ONE, "1 Y", 1).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(ib.listenerCount(EventName.historicalData)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await captured) as Error).message).toBe("Historical data timeout for AAPL");
    expect(ib.listenerCount(EventName.historicalData)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
  });
});

describe("lookupHistoricalBars range presets", () => {
  it.each([
    ["1D", BarSizeSetting.MINUTES_ONE, "2 D"],
    ["5D", BarSizeSetting.MINUTES_FIVE, "7 D"],
    ["1M", BarSizeSetting.MINUTES_THIRTY, "1 M"],
    ["3M", BarSizeSetting.HOURS_ONE, "3 M"],
    ["6M", BarSizeSetting.HOURS_TWO, "6 M"],
    ["1Y", BarSizeSetting.DAYS_ONE, "1 Y"],
    ["5Y", BarSizeSetting.WEEKS_ONE, "5 Y"],
    ["All", BarSizeSetting.WEEKS_ONE, "20 Y"],
  ] as const)("range %s requests %s bars over %s", (range, barSize, duration) => {
    const ib = new FakeIbApi();
    void lookupHistoricalBars(asConnection(ib), "AAPL", range, 4).catch(() => undefined);
    expect(ib.reqHistoricalData.mock.calls[0]!.slice(0, 1).concat(ib.reqHistoricalData.mock.calls[0]!.slice(3, 5))).toEqual([4, duration, barSize]);
  });
});

describe("lookupLatestDailyBar", () => {
  it("requests 2 days of daily bars and returns the last bar", async () => {
    const ib = new FakeIbApi();
    const result = lookupLatestDailyBar(asConnection(ib), "AAPL", 3);
    expect(ib.reqHistoricalData).toHaveBeenCalledWith(3, expect.objectContaining({ symbol: "AAPL" }), "", "2 D", BarSizeSetting.DAYS_ONE, WhatToShow.TRADES, 1, 2, false);
    emitBar(ib, 3, "20260105", 100);
    emitBar(ib, 3, "20260106", 101);
    finish(ib, 3);
    expect(await result).toEqual({ time: Date.UTC(2026, 0, 6) / 1000, open: 100, high: 102, low: 99, close: 101, volume: 100 });
  });

  it("returns null when no bar came back", async () => {
    const ib = new FakeIbApi();
    const result = lookupLatestDailyBar(asConnection(ib), "AAPL", 3);
    finish(ib, 3);
    expect(await result).toBeNull();
  });

  it("passes the requested data type through", () => {
    const ib = new FakeIbApi();
    void lookupLatestDailyBar(asConnection(ib), "AAPL", 3, WhatToShow.OPTION_IMPLIED_VOLATILITY).catch(() => undefined);
    expect(ib.reqHistoricalData.mock.calls[0]![5]).toBe(WhatToShow.OPTION_IMPLIED_VOLATILITY);
  });

  it("rejects on an error for its request and on a 20 s timeout", async () => {
    const ib = new FakeIbApi();
    const failed = lookupLatestDailyBar(asConnection(ib), "AAPL", 3).catch((error: Error) => error);
    ib.emit(EventName.error, new Error("no data"), 162, 3);
    expect(((await failed) as Error).message).toBe("Historical data error for AAPL (code 162): no data");
    const timedOut = lookupLatestDailyBar(asConnection(ib), "MSFT", 4).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(((await timedOut) as Error).message).toBe("Historical data timeout for MSFT");
    expect(ib.listenerCount(EventName.historicalData)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
  });
});

describe("fetchPriceBars", () => {
  it("connects, requests real-time data once, fetches the range's bars and always disconnects", async () => {
    const ib = new FakeIbApi();
    mocks.connection = { ib };
    const result = fetchPriceBars("AAPL", "1Y");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.realtimeRequests).toEqual([ib]);
    emitBar(ib, 1, "20260105", 100);
    finish(ib, 1);
    expect(await result).toHaveLength(1);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects when the fetch fails", async () => {
    const ib = new FakeIbApi();
    mocks.connection = { ib };
    const captured = fetchPriceBars("AAPL", "1Y").catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("boom"), 162, 1);
    expect(((await captured) as Error).message).toContain("Historical data error for AAPL (code 162)");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});
