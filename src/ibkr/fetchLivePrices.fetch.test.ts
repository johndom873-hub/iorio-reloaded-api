import { EventEmitter } from "node:events";
import { EventName, MarketDataType, OptionType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserveResult: { ok: true, availableLines: 90, priorityLinesHeld: 0 } as { ok: boolean; availableLines: number; priorityLinesHeld: number; disabled?: boolean },
  reservations: [] as { holder: string; lines: number; ttlSeconds: number; options: unknown }[],
  releases: [] as string[],
  releaseError: null as Error | null,
  recorded: [] as { symbol: string; price: number; source: string }[][],
  fallbackSymbolsRequested: [] as string[][],
  fallbackPrices: new Map<string, { price: number }>(),
  borrow: vi.fn(),
  allocateReqId: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("./marketDataLineBudget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./marketDataLineBudget.js")>()),
  reserveMarketDataLines: async (holder: string, lines: number, ttlSeconds: number, options: unknown) => {
    mocks.reservations.push({ holder, lines, ttlSeconds, options });
    return mocks.reserveResult;
  },
  releaseMarketDataLines: async (holder: string) => {
    mocks.releases.push(holder);
    if (mocks.releaseError) throw mocks.releaseError;
  },
}));
vi.mock("../lib/priceService.js", () => ({
  recordStockPrices: async (entries: { symbol: string; price: number; source: string }[]) => void mocks.recorded.push(entries),
  loadFallbackStockPrices: async (symbols: string[]) => {
    mocks.fallbackSymbolsRequested.push(symbols);
    return mocks.fallbackPrices;
  },
}));
vi.mock("./sharedReadConnection.js", () => ({ sharedReadConnection: { borrow: mocks.borrow, allocateReqId: mocks.allocateReqId } }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: mocks.connect }));

import { fetchLivePrices, requestLivePrices, type PriceContract } from "./fetchLivePrices.js";

class FakeIbApi extends EventEmitter {
  reqMarketDataType = vi.fn();
  reqMktData = vi.fn();
  cancelMktData = vi.fn();
}

const stock = (key: string, symbol: string): PriceContract => ({ key, legType: "stock", symbol });
const callOption = (key: string, symbol = "AAPL"): PriceContract => ({ key, legType: "option", symbol, expiry: "20261016", strike: 200, right: OptionType.Call });

let ib: FakeIbApi;
let nextReqId: number;

beforeEach(() => {
  vi.useFakeTimers();
  ib = new FakeIbApi();
  nextReqId = 100;
  Object.assign(mocks, { reserveResult: { ok: true, availableLines: 90, priorityLinesHeld: 0 }, releaseError: null, fallbackPrices: new Map() });
  mocks.reservations.length = 0;
  mocks.releases.length = 0;
  mocks.recorded.length = 0;
  mocks.fallbackSymbolsRequested.length = 0;
  mocks.release.mockReset();
  mocks.disconnect.mockReset();
  mocks.connect.mockReset();
  mocks.borrow.mockReset();
  mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
  mocks.allocateReqId.mockReset();
  mocks.allocateReqId.mockImplementation(() => nextReqId++);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("requestLivePrices", () => {
  const start = (contracts: PriceContract[], timeoutMs = 6_000) => {
    const result = requestLivePrices(ib as never, () => nextReqId++, contracts, timeoutMs);
    return result;
  };

  it("asks for FROZEN data and a snapshot per contract, with a stock or an option contract as needed", () => {
    void start([stock("s", "AAPL"), callOption("o")]);
    expect(ib.reqMarketDataType).toHaveBeenCalledWith(MarketDataType.FROZEN);
    expect(ib.reqMktData).toHaveBeenCalledTimes(2);
    expect(ib.reqMktData.mock.calls[0]![0]).toBe(100);
    expect(ib.reqMktData.mock.calls[0]![1]).toMatchObject({ symbol: "AAPL", secType: "STK", exchange: "SMART", currency: "USD" });
    expect(ib.reqMktData.mock.calls[0]!.slice(2)).toEqual(["", true, false]);
    expect(ib.reqMktData.mock.calls[1]![0]).toBe(101);
    expect(ib.reqMktData.mock.calls[1]![1]).toMatchObject({ symbol: "AAPL", secType: "OPT", lastTradeDateOrContractMonth: "20261016", strike: 200, right: OptionType.Call, exchange: "SMART" });
  });

  it("takes only last ticks (4 real-time, 68 delayed) as the price, and keeps the latest of them", async () => {
    const result = start([stock("s", "AAPL")]);
    ib.emit(EventName.tickPrice, 100, 1, 10); // bid
    ib.emit(EventName.tickPrice, 100, 9, 20); // previous close
    ib.emit(EventName.tickPrice, 100, 75, 30); // delayed close
    ib.emit(EventName.tickPrice, 100, 68, 41);
    expect(await result).toEqual({ s: 41 });
  });

  it("ignores zero and negative last prices, leaving the contract null until the snapshot ends", async () => {
    const result = start([stock("s", "AAPL")]);
    ib.emit(EventName.tickPrice, 100, 4, -1);
    ib.emit(EventName.tickPrice, 100, 4, 0);
    ib.emit(EventName.tickSnapshotEnd, 100);
    expect(await result).toEqual({ s: null });
  });

  it("resolves when every contract has either a price or a snapshot end", async () => {
    const result = start([stock("s", "AAPL"), callOption("o")]);
    ib.emit(EventName.tickPrice, 100, 4, 190);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    ib.emit(EventName.tickSnapshotEnd, 101);
    expect(await result).toEqual({ s: 190, o: null });
  });

  it("ignores ticks and ends for unknown request ids", async () => {
    const result = start([stock("s", "AAPL")]);
    ib.emit(EventName.tickPrice, 5, 4, 999);
    ib.emit(EventName.tickSnapshotEnd, 5);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    ib.emit(EventName.tickPrice, 100, 4, 190);
    expect(await result).toEqual({ s: 190 });
  });

  it("returns whatever arrived at the timeout, null for the rest", async () => {
    const result = start([stock("a", "AAPL"), stock("m", "MSFT")], 3_000);
    ib.emit(EventName.tickPrice, 100, 4, 190);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toEqual({ a: 190, m: null });
  });

  it("cancels every subscription and removes its listeners on completion", async () => {
    const result = start([stock("a", "AAPL"), stock("m", "MSFT")]);
    ib.emit(EventName.tickSnapshotEnd, 100);
    ib.emit(EventName.tickSnapshotEnd, 101);
    await result;
    expect(ib.cancelMktData.mock.calls.map((call) => call[0])).toEqual([100, 101]);
    for (const eventName of [EventName.tickPrice, EventName.tickSnapshotEnd, EventName.error]) expect(ib.listenerCount(eventName)).toBe(0);
  });

  it("logs errors for its own contracts but not the delayed-data notices, and not other requests' errors", async () => {
    const result = start([stock("s", "AAPL")]);
    ib.emit(EventName.error, new Error("Requested market data is not subscribed. Displaying delayed market data."), 10167, 100);
    ib.emit(EventName.error, new Error("someone else"), 200, 999);
    expect(console.error).not.toHaveBeenCalled();
    ib.emit(EventName.error, new Error("No market data permissions"), 354, 100);
    expect(console.error).toHaveBeenCalledWith("Live price error for AAPL (stock, code 354): No market data permissions");
    ib.emit(EventName.tickSnapshotEnd, 100);
    await result;
  });
});

describe("fetchLivePrices", () => {
  const runFetch = async (contracts: PriceContract[], options: Parameters<typeof fetchLivePrices>[1] = {}) => {
    const result = fetchLivePrices(contracts, options);
    await vi.advanceTimersByTimeAsync(0);
    return result;
  };

  /** Answers every outstanding snapshot with a last price (null: only the snapshot end). */
  const answerAll = (pricesByReqId: Record<number, number | null>) => {
    for (const [reqId, price] of Object.entries(pricesByReqId)) {
      if (price !== null) ib.emit(EventName.tickPrice, Number(reqId), 4, price);
      else ib.emit(EventName.tickSnapshotEnd, Number(reqId));
    }
  };

  it("returns an empty map for no contracts without reserving lines", async () => {
    expect(await fetchLivePrices([])).toEqual({});
    expect(mocks.reservations).toEqual([]);
  });

  it("reserves one line per contract for 15 seconds as a non-priority holder, and releases it afterwards", async () => {
    const result = runFetch([stock("a", "AAPL"), callOption("o")]);
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 190, 101: 3.2 });
    await result;
    expect(mocks.reservations).toHaveLength(1);
    expect(mocks.reservations[0]).toMatchObject({ lines: 2, ttlSeconds: 15, options: { priority: false } });
    expect(mocks.reservations[0]!.holder).toMatch(/^snapshot:prices:[0-9a-f-]{36}$/);
    expect(mocks.releases).toEqual([mocks.reservations[0]!.holder]);
  });

  it("reserves with priority when asked", async () => {
    const result = runFetch([stock("a", "AAPL")], { priorityLines: true });
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 190 });
    await result;
    expect(mocks.reservations[0]!.options).toEqual({ priority: true });
  });

  it("fails with the shortage message, requesting nothing from IBKR, when the lines are not available", async () => {
    mocks.reserveResult = { ok: false, availableLines: 1, priorityLinesHeld: 0 };
    await expect(fetchLivePrices([stock("a", "AAPL"), stock("m", "MSFT")])).rejects.toThrow("IBKR market data is busy (another live view) — a 2-contract price snapshot needs 2 lines, only 1 available. Try again shortly.");
    expect(mocks.borrow).not.toHaveBeenCalled();
    expect(mocks.releases).toEqual([]);
  });

  it("returns live stock and option prices and records only the real stock prices as frozen", async () => {
    const result = runFetch([stock("a", "AAPL"), callOption("o"), stock("m", "MSFT")]);
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 190.5, 101: 3.2, 102: 410 });
    expect(await result).toEqual({ a: 190.5, o: 3.2, m: 410 });
    expect(mocks.recorded).toEqual([[{ symbol: "AAPL", price: 190.5, source: "frozen" }, { symbol: "MSFT", price: 410, source: "frozen" }]]);
  });

  it("does not call the price recorder when no stock price arrived", async () => {
    const result = runFetch([callOption("o")]);
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 3.2 });
    await result;
    expect(mocks.recorded).toEqual([]);
  });

  it("looks the fallback prices up for the distinct stock legs only, in contract order", async () => {
    const result = runFetch([stock("a", "AAPL"), callOption("o"), stock("m", "MSFT")]);
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 1, 101: 1, 102: 1 });
    await result;
    expect(mocks.fallbackSymbolsRequested).toEqual([["AAPL", "MSFT"]]);
  });

  it("fills a stock with no last from the stored price and reports which symbols used the fallback", async () => {
    mocks.fallbackPrices = new Map([["MSFT", { price: 405.5 }], ["NVDA", { price: 1 }]]);
    const onFallbackPriceUsed = vi.fn();
    const result = runFetch([stock("a", "AAPL"), stock("m", "MSFT")], { onFallbackPriceUsed });
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 190, 101: null });
    expect(await result).toEqual({ a: 190, m: 405.5 });
    expect(onFallbackPriceUsed).toHaveBeenCalledWith(["MSFT"]);
  });

  it("does not record a fallback price as a real last, and does not use a fallback to override a real price", async () => {
    mocks.fallbackPrices = new Map([["AAPL", { price: 1 }], ["MSFT", { price: 405.5 }]]);
    const result = runFetch([stock("a", "AAPL"), stock("m", "MSFT")]);
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 190, 101: null });
    const prices = await result;
    expect(prices.a).toBe(190);
    expect(mocks.recorded).toEqual([[{ symbol: "AAPL", price: 190, source: "frozen" }]]);
  });

  it("leaves a stock null when there is no fallback either, and never calls onFallbackPriceUsed", async () => {
    const onFallbackPriceUsed = vi.fn();
    const result = runFetch([stock("a", "AAPL")], { onFallbackPriceUsed });
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: null });
    expect(await result).toEqual({ a: null });
    expect(onFallbackPriceUsed).not.toHaveBeenCalled();
  });

  it("never fills an option leg from the stock fallbacks", async () => {
    mocks.fallbackPrices = new Map([["AAPL", { price: 190 }]]);
    const result = runFetch([callOption("o", "AAPL")]);
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: null });
    expect(await result).toEqual({ o: null });
  });

  it("fills two legs of the same stock from the one fallback price", async () => {
    mocks.fallbackPrices = new Map([["MSFT", { price: 405.5 }]]);
    const onFallbackPriceUsed = vi.fn();
    const result = runFetch([stock("first", "MSFT"), stock("second", "MSFT")], { onFallbackPriceUsed });
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: null, 101: null });
    expect(await result).toEqual({ first: 405.5, second: 405.5 });
    expect(onFallbackPriceUsed).toHaveBeenCalledWith(["MSFT", "MSFT"]);
  });

  it("honours the snapshot timeout override", async () => {
    const result = runFetch([stock("a", "AAPL")], { snapshotTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toEqual({ a: null });
  });

  it("uses the 6 s ceiling by default", async () => {
    let settled = false;
    const result = runFetch([stock("a", "AAPL")]).then((value) => ((settled = true), value));
    await vi.advanceTimersByTimeAsync(5_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ a: null });
  });

  it("releases the shared connection after the snapshot", async () => {
    const result = runFetch([stock("a", "AAPL")]);
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 190 });
    await result;
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("falls back to a one-shot connection numbering requests from 30000, then disconnects", async () => {
    mocks.borrow.mockRejectedValue(new Error("not connected"));
    mocks.connect.mockResolvedValue({ ib, disconnect: mocks.disconnect });
    const result = runFetch([stock("a", "AAPL"), stock("m", "MSFT")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqMktData.mock.calls.map((call) => call[0])).toEqual([30_000, 30_001]);
    answerAll({ 30_000: 190, 30_001: 410 });
    expect(await result).toEqual({ a: 190, m: 410 });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("fetchLivePrices: shared read connection unavailable (not connected), falling back to a one-shot connection.");
  });

  it("releases the reserved lines when the IBKR request fails", async () => {
    mocks.borrow.mockRejectedValue(new Error("not connected"));
    mocks.connect.mockRejectedValue(new Error("tunnel down"));
    const captured = fetchLivePrices([stock("a", "AAPL")]).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(((await captured) as Error).message).toBe("tunnel down");
    expect(mocks.releases).toHaveLength(1);
  });

  it("does not fail when releasing the lines fails; it only warns", async () => {
    mocks.releaseError = new Error("db down");
    const result = runFetch([stock("a", "AAPL")]);
    await vi.advanceTimersByTimeAsync(0);
    answerAll({ 100: 190 });
    expect(await result).toEqual({ a: 190 });
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to release IBKR market data line reservation snapshot:prices:"));
  });
});
