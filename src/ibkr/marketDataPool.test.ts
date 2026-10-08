import { EventEmitter } from "node:events";
import { EventName, OptionType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceContract } from "./fetchLivePrices.js";

interface FakeIb extends EventEmitter {
  reqMktData: ReturnType<typeof vi.fn>;
  cancelMktData: ReturnType<typeof vi.fn>;
}

const poolHarness = vi.hoisted(() => ({
  currentIb: null as unknown,
  borrowFails: false,
  borrowCount: 0,
  nextReqId: 1000,
  availableLines: 90,
  reserveFailsWith: null as Error | null,
  reserveDelayMs: 0,
  reserveCalls: [] as Array<{ holder: string; lines: number; ttlSeconds: number }>,
  reservePriorities: [] as boolean[],
  releaseCalls: [] as string[],
  reservesInFlight: 0,
  maxReservesInFlight: 0,
  fallbackPrices: new Map<string, { price: number }>(),
  fallbackDeferred: null as null | { promise: Promise<Map<string, { price: number }>>; resolve: (value: Map<string, { price: number }>) => void },
  fallbackRejects: false,
  broadcasts: [] as unknown[],
}));

vi.mock("./sharedReadConnection.js", () => ({
  sharedLiveConnection: {
    borrow: async () => {
      poolHarness.borrowCount += 1;
      if (poolHarness.borrowFails) throw new Error("connection unavailable");
      return { ib: poolHarness.currentIb };
    },
    allocateReqId: () => poolHarness.nextReqId++,
  },
}));
vi.mock("./marketDataLineBudget.js", () => ({
  reserveMarketDataLines: async (holder: string, lines: number, ttlSeconds: number, options: { priority?: boolean } = {}) => {
    poolHarness.reserveCalls.push({ holder, lines, ttlSeconds });
    poolHarness.reservePriorities.push(options.priority ?? false);
    poolHarness.reservesInFlight += 1;
    poolHarness.maxReservesInFlight = Math.max(poolHarness.maxReservesInFlight, poolHarness.reservesInFlight);
    try {
      if (poolHarness.reserveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, poolHarness.reserveDelayMs));
      if (poolHarness.reserveFailsWith) throw poolHarness.reserveFailsWith;
      if (lines <= poolHarness.availableLines) return { ok: true, availableLines: poolHarness.availableLines, priorityLinesHeld: 0 };
      return { ok: false, availableLines: poolHarness.availableLines, priorityLinesHeld: 50 };
    } finally {
      poolHarness.reservesInFlight -= 1;
    }
  },
  releaseMarketDataLines: async (holder: string) => {
    poolHarness.releaseCalls.push(holder);
  },
}));
vi.mock("../lib/priceService.js", () => ({
  loadFallbackStockPrices: (_symbols: string[]) => {
    if (poolHarness.fallbackRejects) return Promise.reject(new Error("fallback unavailable"));
    if (poolHarness.fallbackDeferred) return poolHarness.fallbackDeferred.promise;
    return Promise.resolve(poolHarness.fallbackPrices);
  },
}));
vi.mock("../lib/notificationBroadcaster.js", () => ({ broadcastToLocalSubscribers: (notification: unknown) => poolHarness.broadcasts.push(notification) }));

function createFakeIb(): FakeIb {
  return Object.assign(new EventEmitter(), { reqMktData: vi.fn(), cancelMktData: vi.fn() });
}

async function loadPool() {
  vi.resetModules();
  return import("./marketDataPool.js");
}

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await vi.advanceTimersByTimeAsync(0);
}

const stockAlpha: PriceContract = { key: "ALPHA", legType: "stock", symbol: "ALPHA" };
const stockBravo: PriceContract = { key: "BRAVO", legType: "stock", symbol: "BRAVO" };
const optionAlpha: PriceContract = { key: "ALPHA-C", legType: "option", symbol: "ALPHA", expiry: "20261120", strike: 50, right: OptionType.Call };
const optionBravo: PriceContract = { key: "BRAVO-P", legType: "option", symbol: "BRAVO", expiry: "20261120", strike: 20, right: OptionType.Put };

let ib: FakeIb;

beforeEach(() => {
  vi.useFakeTimers();
  ib = createFakeIb();
  poolHarness.currentIb = ib;
  poolHarness.borrowFails = false;
  poolHarness.borrowCount = 0;
  poolHarness.nextReqId = 1000;
  poolHarness.availableLines = 90;
  poolHarness.reserveFailsWith = null;
  poolHarness.reserveDelayMs = 0;
  poolHarness.reserveCalls.length = 0;
  poolHarness.reservePriorities.length = 0;
  poolHarness.releaseCalls.length = 0;
  poolHarness.reservesInFlight = 0;
  poolHarness.maxReservesInFlight = 0;
  poolHarness.fallbackPrices = new Map();
  poolHarness.fallbackDeferred = null;
  poolHarness.fallbackRejects = false;
  poolHarness.broadcasts.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("poolKeyFor", () => {
  it("keys a stock by symbol and an option by symbol, expiry, strike and right", async () => {
    const { poolKeyFor } = await loadPool();
    expect(poolKeyFor(stockAlpha)).toBe("stock|ALPHA");
    expect(poolKeyFor(optionAlpha)).toBe("option|ALPHA|20261120|50|C");
    expect(poolKeyFor({ ...optionAlpha, right: OptionType.Put })).not.toBe(poolKeyFor(optionAlpha));
    expect(poolKeyFor({ ...optionAlpha, strike: 55 })).not.toBe(poolKeyFor(optionAlpha));
    expect(poolKeyFor({ ...optionAlpha, key: "different-caller-key" })).toBe(poolKeyFor(optionAlpha));
  });
});

describe("waitForFirstReading", () => {
  it("resolves at once when a check finds every contract complete", async () => {
    const { waitForFirstReading } = await loadPool();
    let complete = false;
    const { settled, check } = waitForFirstReading(() => complete);
    let resolved = false;
    void settled.then(() => (resolved = true));
    check();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    complete = true;
    check();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves with whatever arrived after the 3 s settle grace, and not earlier", async () => {
    const { waitForFirstReading, settleGraceMs } = await loadPool();
    const { settled } = waitForFirstReading(() => false);
    let resolved = false;
    void settled.then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(settleGraceMs - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    expect(settleGraceMs).toBe(3_000);
  });
});

describe("subscribing and the line budget", () => {
  it("reports an empty pool", async () => {
    const pool = await loadPool();
    expect(pool.marketDataPoolSnapshot()).toEqual({ contractCount: 0, subscriberCount: 0, pausedCount: 0, openLineCount: 0, restricted: false });
  });

  it("reserves one line per contract under the pool holder and opens a plain stock subscription", async () => {
    const pool = await loadPool();
    const onUpdate = vi.fn();
    await pool.subscribeToPooledQuote(stockAlpha, onUpdate);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(pool.emptyPooledQuote);
    await settle();

    expect(poolHarness.reserveCalls).toEqual([{ holder: "marketDataPool", lines: 1, ttlSeconds: 90 }]);
    expect(ib.reqMktData).toHaveBeenCalledTimes(1);
    const [reqId, contract, genericTicks, snapshot, regulatorySnapshot] = ib.reqMktData.mock.calls[0]!;
    expect(reqId).toBe(1000);
    expect(contract).toMatchObject({ symbol: "ALPHA", secType: "STK", exchange: "SMART", currency: "USD" });
    expect([genericTicks, snapshot, regulatorySnapshot]).toEqual(["", false, false]);
    expect(pool.marketDataPoolSnapshot()).toEqual({ contractCount: 1, subscriberCount: 1, pausedCount: 0, openLineCount: 1, restricted: false });
  });

  it("opens an option subscription with its expiry, strike and right", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(optionAlpha, () => {});
    await settle();
    expect(ib.reqMktData.mock.calls[0]![1]).toMatchObject({ symbol: "ALPHA", secType: "OPT", lastTradeDateOrContractMonth: "20261120", strike: 50, right: "C", exchange: "SMART" });
  });

  it("shares one line between subscribers of the same contract and gives a late joiner the current quote at once", async () => {
    const pool = await loadPool();
    const first = vi.fn();
    const second = vi.fn();
    await pool.subscribeToPooledQuote(stockAlpha, first);
    await settle();
    ib.emit(EventName.tickPrice, 1000, 4, 12.5);
    await pool.subscribeToPooledQuote(stockAlpha, second);
    await settle();

    expect(ib.reqMktData).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]![0]).toMatchObject({ last: 12.5 });
    ib.emit(EventName.tickPrice, 1000, 1, 12.4);
    expect(first).toHaveBeenLastCalledWith(expect.objectContaining({ bid: 12.4, last: 12.5 }));
    expect(second).toHaveBeenLastCalledWith(expect.objectContaining({ bid: 12.4, last: 12.5 }));
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 1, subscriberCount: 2, openLineCount: 1 });
  });

  it("reports a contract's line state: not pooled, waiting for IBKR's first tick, streaming, paused (measurement only)", async () => {
    poolHarness.availableLines = 1;
    const pool = await loadPool();
    expect(pool.pooledLineState(stockAlpha)).toBeNull();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    expect(pool.pooledLineState(stockAlpha)).toBe("waiting");
    ib.emit(EventName.tickPrice, 1000, 4, 12.5);
    expect(pool.pooledLineState(stockAlpha)).toBe("streaming");
    await pool.subscribeToPooledQuote(optionAlpha, () => {}); // one line only: the newest (the option) is paused
    await settle();
    expect(pool.pooledLineState(optionAlpha)).toBe("paused");
    expect(pool.pooledLineState(stockAlpha)).toBe("streaming");
  });

  it("sheds the newest options first when the budget hands out fewer lines than contracts, holding exactly what fits", async () => {
    poolHarness.availableLines = 2;
    const pool = await loadPool();
    for (const contract of [stockAlpha, optionAlpha, stockBravo, optionBravo]) await pool.subscribeToPooledQuote(contract, () => {});
    await settle();

    expect(pool.marketDataPoolSnapshot()).toEqual({ contractCount: 4, subscriberCount: 4, pausedCount: 2, openLineCount: 2, restricted: true });
    expect(poolHarness.reserveCalls.at(-1)).toEqual({ holder: "marketDataPool", lines: 2, ttlSeconds: 90 });
    const subscribedSymbols = ib.reqMktData.mock.calls.map((call) => `${(call[1] as { secType: string }).secType}:${(call[1] as { symbol: string }).symbol}`);
    const activeReqIds = new Set<number>();
    for (const call of ib.reqMktData.mock.calls) activeReqIds.add(call[0] as number);
    for (const call of ib.cancelMktData.mock.calls) activeReqIds.delete(call[0] as number);
    expect(activeReqIds.size).toBe(2);
    expect(subscribedSymbols.filter((label) => label.startsWith("STK"))).toHaveLength(2);
  });

  it("sheds stocks only after every option, newest stock first", async () => {
    poolHarness.availableLines = 1;
    const pool = await loadPool();
    for (const contract of [stockAlpha, optionAlpha, stockBravo]) await pool.subscribeToPooledQuote(contract, () => {});
    await settle();
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ pausedCount: 2, openLineCount: 1, restricted: true });
    const liveReqIds = ib.reqMktData.mock.calls.map((call) => call[0] as number).filter((reqId) => !ib.cancelMktData.mock.calls.some((cancel) => cancel[0] === reqId));
    expect(liveReqIds).toHaveLength(1);
    const liveCall = ib.reqMktData.mock.calls.find((call) => call[0] === liveReqIds[0])!;
    expect(liveCall[1]).toMatchObject({ symbol: "ALPHA", secType: "STK" });
  });

  it("cancels the line of a contract that gets paused and keeps its subscribers and last quote", async () => {
    const pool = await loadPool();
    const optionListener = vi.fn();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await pool.subscribeToPooledQuote(optionAlpha, optionListener);
    await settle();
    const optionReqId = ib.reqMktData.mock.calls.find((call) => (call[1] as { secType: string }).secType === "OPT")![0] as number;
    ib.emit(EventName.tickPrice, optionReqId, 2, 3.2);

    poolHarness.availableLines = 1;
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();

    expect(ib.cancelMktData).toHaveBeenCalledWith(optionReqId);
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 2, subscriberCount: 2, pausedCount: 1, openLineCount: 1, restricted: true });
    expect(pool.peekPooledQuote(optionAlpha)).toMatchObject({ ask: 3.2 });
    ib.emit(EventName.tickPrice, optionReqId, 2, 9.9);
    expect(pool.peekPooledQuote(optionAlpha)).toMatchObject({ ask: 3.2 });
  });

  it("opens no line at all and reports restricted when the budget grants zero lines or is disabled", async () => {
    poolHarness.availableLines = 0;
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    expect(ib.reqMktData).not.toHaveBeenCalled();
    expect(poolHarness.releaseCalls).toContain("marketDataPool");
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 1, pausedCount: 1, openLineCount: 0, restricted: true });
  });

  it("resumes paused contracts oldest-option-first as the budget frees up, and lifts the restriction when all fit", async () => {
    poolHarness.availableLines = 2;
    const pool = await loadPool();
    for (const contract of [stockAlpha, optionAlpha, stockBravo, optionBravo]) await pool.subscribeToPooledQuote(contract, () => {});
    await settle();
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ pausedCount: 2, openLineCount: 2, restricted: true });

    poolHarness.availableLines = 3;
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ pausedCount: 1, openLineCount: 3, restricted: true });
    const lastSubscribed = ib.reqMktData.mock.calls.at(-1)![1] as { symbol: string; secType: string };
    expect(lastSubscribed).toMatchObject({ symbol: "ALPHA", secType: "OPT" });

    poolHarness.availableLines = 90;
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(pool.marketDataPoolSnapshot()).toEqual({ contractCount: 4, subscriberCount: 4, pausedCount: 0, openLineCount: 4, restricted: false });
    expect(ib.reqMktData.mock.calls.at(-1)![1]).toMatchObject({ symbol: "BRAVO", secType: "OPT" });
  });

  it("never opens a line when the reservation itself fails, then subscribes at the next reconcile", async () => {
    poolHarness.reserveFailsWith = new Error("db hiccup");
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    expect(ib.reqMktData).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("marketDataPool: reservation reconcile failed — db hiccup");
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 1, openLineCount: 0, pausedCount: 0 });

    poolHarness.reserveFailsWith = null;
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(ib.reqMktData).toHaveBeenCalledTimes(1);
    expect(pool.marketDataPoolSnapshot().openLineCount).toBe(1);
  });

  it("serializes reservation writes during a subscribe burst and ends up reserving the full count", async () => {
    poolHarness.reserveDelayMs = 20;
    const pool = await loadPool();
    for (const contract of [stockAlpha, stockBravo, optionAlpha, optionBravo, { ...stockAlpha, symbol: "CHARLIE", key: "CHARLIE" }]) {
      void pool.subscribeToPooledQuote(contract, () => {});
    }
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(poolHarness.maxReservesInFlight).toBe(1);
    expect(poolHarness.reserveCalls.at(-1)?.lines).toBe(5);
    expect(pool.marketDataPoolSnapshot().openLineCount).toBe(5);
    expect(ib.reqMktData).toHaveBeenCalledTimes(5);
  });

  it("does not open lines for a contract subscribed while the connection is unavailable until it returns", async () => {
    poolHarness.borrowFails = true;
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    expect(ib.reqMktData).not.toHaveBeenCalled();
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 1, openLineCount: 0 });

    poolHarness.borrowFails = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(ib.reqMktData).toHaveBeenCalledTimes(1);
    expect(pool.marketDataPoolSnapshot().openLineCount).toBe(1);
  });
});

describe("tick handling", () => {
  async function subscribedStock() {
    const pool = await loadPool();
    const onUpdate = vi.fn();
    await pool.subscribeToPooledQuote(stockAlpha, onUpdate);
    await settle();
    onUpdate.mockClear();
    return { pool, onUpdate, reqId: 1000 };
  }

  it("maps real-time and delayed price ticks onto last, bid, ask, high, low, previous close and open", async () => {
    const { pool, reqId } = await subscribedStock();
    const priceTicks: Array<[number, number]> = [[4, 10.1], [1, 10.0], [2, 10.2], [6, 11], [7, 9], [9, 9.8], [14, 9.9]];
    for (const [tickType, price] of priceTicks) ib.emit(EventName.tickPrice, reqId, tickType, price);
    expect(pool.peekPooledQuote(stockAlpha)).toMatchObject({ last: 10.1, bid: 10.0, ask: 10.2, high: 11, low: 9, previousClose: 9.8, open: 9.9 });

    for (const [tickType, price] of [[68, 20.1], [66, 20.0], [67, 20.2], [72, 21], [73, 19], [75, 19.8], [76, 19.9]] as const) ib.emit(EventName.tickPrice, reqId, tickType, price);
    expect(pool.peekPooledQuote(stockAlpha)).toMatchObject({ last: 20.1, bid: 20.0, ask: 20.2, high: 21, low: 19, previousClose: 19.8, open: 19.9 });
  });

  it("turns IBKR's -1 and 0 prices into null instead of keeping a stale value", async () => {
    const { pool, reqId } = await subscribedStock();
    ib.emit(EventName.tickPrice, reqId, 1, 10);
    ib.emit(EventName.tickPrice, reqId, 1, -1);
    expect(pool.peekPooledQuote(stockAlpha)?.bid).toBeNull();
    ib.emit(EventName.tickPrice, reqId, 2, 10);
    ib.emit(EventName.tickPrice, reqId, 2, 0);
    expect(pool.peekPooledQuote(stockAlpha)?.ask).toBeNull();
  });

  it("notifies subscribers only when the quote actually changed", async () => {
    const { onUpdate, reqId } = await subscribedStock();
    ib.emit(EventName.tickPrice, reqId, 4, 10);
    ib.emit(EventName.tickPrice, reqId, 4, 10);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    ib.emit(EventName.tickPrice, reqId, 4, 10.01);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    ib.emit(EventName.tickPrice, reqId, 4, -1);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    ib.emit(EventName.tickPrice, reqId, 4, -1);
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it("ignores ticks for request ids the pool does not own and tick types it does not track", async () => {
    const { pool, onUpdate, reqId } = await subscribedStock();
    ib.emit(EventName.tickPrice, 5, 4, 10);
    ib.emit(EventName.tickPrice, reqId, 99, 10);
    ib.emit(EventName.tickSize, 5, 8, 100);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(pool.peekPooledQuote(stockAlpha)).toEqual(pool.emptyPooledQuote);
  });

  it("reads volume from size ticks 8 and 74 only and maps a negative size to null", async () => {
    const { pool, reqId } = await subscribedStock();
    ib.emit(EventName.tickSize, reqId, 8, 1_200);
    expect(pool.peekPooledQuote(stockAlpha)?.volume).toBe(1_200);
    ib.emit(EventName.tickSize, reqId, 74, 1_500);
    expect(pool.peekPooledQuote(stockAlpha)?.volume).toBe(1_500);
    ib.emit(EventName.tickSize, reqId, 0, 77);
    ib.emit(EventName.tickSize, reqId, undefined, 77);
    ib.emit(EventName.tickSize, reqId, 8, undefined);
    expect(pool.peekPooledQuote(stockAlpha)?.volume).toBe(1_500);
    ib.emit(EventName.tickSize, reqId, 8, -1);
    expect(pool.peekPooledQuote(stockAlpha)?.volume).toBeNull();
  });

  it("merges option computation ticks (13, 83), keeping a field the tick left out, and ignores other computation types", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(optionAlpha, () => {});
    await settle();
    const reqId = 1000;
    // Argument order: reqId, tickType, tickAttrib, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, underlyingPrice.
    ib.emit(EventName.tickOptionComputation, reqId, 13, undefined, 0.42, 0.55, 3.1, 0.4, 0.02, 0.1, -0.05, 61.2);
    expect(pool.peekPooledQuote(optionAlpha)).toMatchObject({ impliedVolatility: 0.42, delta: 0.55, gamma: 0.02, vega: 0.1, theta: -0.05, underlyingPrice: 61.2 });

    ib.emit(EventName.tickOptionComputation, reqId, 83, undefined, undefined, 0.6, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(pool.peekPooledQuote(optionAlpha)).toMatchObject({ impliedVolatility: 0.42, delta: 0.6, gamma: 0.02, vega: 0.1, theta: -0.05, underlyingPrice: 61.2 });

    ib.emit(EventName.tickOptionComputation, reqId, 10, undefined, 0.9, 0.99, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(pool.peekPooledQuote(optionAlpha)?.delta).toBe(0.6);
  });

  it("ignores delayed-data fallback notices and unrelated errors, and logs an error for a pooled request", async () => {
    const { pool, reqId } = await subscribedStock();
    ib.emit(EventName.error, new Error("Delayed market data is available"), 10167, reqId);
    expect(console.error).not.toHaveBeenCalled();
    ib.emit(EventName.error, new Error("No security definition"), 200, reqId);
    expect(console.error).toHaveBeenCalledWith("marketDataPool: error for stock|ALPHA (code 200): No security definition");
    expect(pool.marketDataFeedRefusal()).toBeNull();
  });

  it("attaches its listeners once per connection however many subscribe passes run", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    await pool.subscribeToPooledQuote(stockBravo, () => {});
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(ib.listenerCount(EventName.tickPrice)).toBe(1);
    expect(ib.listenerCount(EventName.tickSize)).toBe(1);
    expect(ib.listenerCount(EventName.tickOptionComputation)).toBe(1);
    expect(ib.listenerCount(EventName.error)).toBe(1);
    expect(ib.listenerCount(EventName.disconnected)).toBe(1);
  });
});

describe("peekPooledQuote", () => {
  it("returns null for a contract nobody pooled and creates no subscription or reservation", async () => {
    const pool = await loadPool();
    expect(pool.peekPooledQuote(stockAlpha)).toBeNull();
    await settle();
    expect(poolHarness.reserveCalls).toEqual([]);
    expect(ib.reqMktData).not.toHaveBeenCalled();
    expect(pool.marketDataPoolSnapshot().contractCount).toBe(0);
  });

  it("returns the pooled quote for a subscribed contract and distinguishes options by strike and right", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(optionAlpha, () => {});
    await settle();
    ib.emit(EventName.tickPrice, 1000, 4, 2.5);
    expect(pool.peekPooledQuote(optionAlpha)).toMatchObject({ last: 2.5 });
    expect(pool.peekPooledQuote({ ...optionAlpha, key: "other", strike: 55 })).toBeNull();
    expect(pool.peekPooledQuote({ ...optionAlpha, key: "other", right: OptionType.Put })).toBeNull();
  });
});

describe("configureMarketDataPoolReservation", () => {
  it("books the web dyno's pool as a non-priority marketDataPool row by default", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    expect(poolHarness.reserveCalls.map((call) => call.holder)).toEqual(["marketDataPool"]);
    expect(poolHarness.reservePriorities).toEqual([false]);
  });

  it("books another process's pool under its own holder at the configured priority, sized to what is subscribed", async () => {
    const pool = await loadPool();
    pool.configureMarketDataPoolReservation({ holder: "pluto_agent", priority: true });
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    const unsubscribeOption = await pool.subscribeToPooledQuote(optionAlpha, () => {});
    await settle();
    expect(poolHarness.reserveCalls.map((call) => [call.holder, call.lines])).toEqual([["pluto_agent", 1], ["pluto_agent", 2]]);
    expect(poolHarness.reservePriorities).toEqual([true, true]);

    unsubscribeOption();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs);
    await settle();
    expect(poolHarness.reserveCalls.at(-1)).toMatchObject({ holder: "pluto_agent", lines: 1 });
    expect(poolHarness.reservePriorities.at(-1)).toBe(true);
    expect(poolHarness.releaseCalls).toEqual([]);
  });

  it("refuses to change the holder once the pool has a subscription", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    expect(() => pool.configureMarketDataPoolReservation({ holder: "pluto_agent", priority: true })).toThrow(/before the first pooled subscription/);
  });
});

describe("unsubscribing and the cancel grace", () => {
  it("keeps the line for 2 s after the last subscriber leaves, then cancels it and releases the reservation", async () => {
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs - 1);
    expect(ib.cancelMktData).not.toHaveBeenCalled();
    expect(pool.marketDataPoolSnapshot().contractCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(ib.cancelMktData).toHaveBeenCalledWith(1000);
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 0, openLineCount: 0 });
    expect(pool.peekPooledQuote(stockAlpha)).toBeNull();
    expect(poolHarness.releaseCalls).toEqual(["marketDataPool"]);
  });

  it("cancels the pending cancel when someone resubscribes within the grace and re-requests nothing", async () => {
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(500);
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(ib.cancelMktData).not.toHaveBeenCalled();
    expect(ib.reqMktData).toHaveBeenCalledTimes(1);
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 1, subscriberCount: 1, openLineCount: 1 });
  });

  it("keeps the line while any subscriber remains", async () => {
    const pool = await loadPool();
    const leaving = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    leaving();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ib.cancelMktData).not.toHaveBeenCalled();
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ subscriberCount: 1, openLineCount: 1 });
  });

  it("treats a repeated unsubscribe call as a no-op", async () => {
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    unsubscribe();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs);
    await settle();
    expect(ib.cancelMktData).toHaveBeenCalledTimes(1);
  });

  it("lets a stale unsubscribe from a removed entry leave a re-created entry alone", async () => {
    const pool = await loadPool();
    const staleUnsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    staleUnsubscribe();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs);
    await settle();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    staleUnsubscribe();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 1, subscriberCount: 1, openLineCount: 1 });
  });

  it("stops the periodic reconcile once the pool is empty", async () => {
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs);
    await settle();
    const reserveCountAfterEmpty = poolHarness.reserveCalls.length;
    const releaseCountAfterEmpty = poolHarness.releaseCalls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(poolHarness.reserveCalls.length).toBe(reserveCountAfterEmpty);
    expect(poolHarness.releaseCalls.length).toBe(releaseCountAfterEmpty);
  });

  it("lifts the restriction when shedding is no longer needed because the pool emptied", async () => {
    poolHarness.availableLines = 0;
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    expect(pool.marketDataPoolSnapshot().restricted).toBe(true);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs);
    await settle();
    expect(pool.marketDataPoolSnapshot().restricted).toBe(false);
  });
});

describe("underlying connection drop and resubscription", () => {
  it("invalidates every line but keeps entries, subscribers and last quotes", async () => {
    const pool = await loadPool();
    const onUpdate = vi.fn();
    await pool.subscribeToPooledQuote(stockAlpha, onUpdate);
    await pool.subscribeToPooledQuote(optionAlpha, () => {});
    await settle();
    ib.emit(EventName.tickPrice, 1000, 4, 10.5);

    poolHarness.borrowFails = true;
    ib.emit(EventName.disconnected);

    expect(pool.marketDataPoolSnapshot()).toEqual({ contractCount: 2, subscriberCount: 2, pausedCount: 0, openLineCount: 0, restricted: false });
    expect(pool.peekPooledQuote(stockAlpha)).toMatchObject({ last: 10.5 });
    onUpdate.mockClear();
    ib.emit(EventName.tickPrice, 1000, 4, 99);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(pool.peekPooledQuote(stockAlpha)).toMatchObject({ last: 10.5 });
  });

  it("resubscribes every contract on the new connection after 1 s, with fresh request ids and listeners on the new ib", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await pool.subscribeToPooledQuote(optionAlpha, () => {});
    await settle();
    const firstReqIds = ib.reqMktData.mock.calls.map((call) => call[0] as number);

    const secondIb = createFakeIb();
    poolHarness.currentIb = secondIb;
    ib.emit(EventName.disconnected);
    await vi.advanceTimersByTimeAsync(999);
    expect(secondIb.reqMktData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(secondIb.reqMktData).toHaveBeenCalledTimes(2);
    const secondReqIds = secondIb.reqMktData.mock.calls.map((call) => call[0] as number);
    expect(secondReqIds.every((reqId) => !firstReqIds.includes(reqId))).toBe(true);
    expect(pool.marketDataPoolSnapshot().openLineCount).toBe(2);

    secondIb.emit(EventName.tickPrice, secondReqIds[0], 4, 33.3);
    expect(pool.peekPooledQuote(stockAlpha)).toMatchObject({ last: 33.3 });
    ib.emit(EventName.tickPrice, firstReqIds[0], 4, 1);
    expect(pool.peekPooledQuote(stockAlpha)).toMatchObject({ last: 33.3 });
    expect(secondIb.listenerCount(EventName.disconnected)).toBe(1);
  });

  it("keeps retrying while the connection stays unavailable, 1 s then 2 s then 5 s apart, and resubscribes once it is back", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    poolHarness.borrowFails = true;
    ib.emit(EventName.disconnected);
    poolHarness.borrowCount = 0;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poolHarness.borrowCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(poolHarness.borrowCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poolHarness.borrowCount).toBe(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(poolHarness.borrowCount).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poolHarness.borrowCount).toBe(3);
    expect(pool.marketDataPoolSnapshot().openLineCount).toBe(0);

    const recoveredIb = createFakeIb();
    poolHarness.currentIb = recoveredIb;
    poolHarness.borrowFails = false;
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(recoveredIb.reqMktData).toHaveBeenCalledTimes(1);
    expect(pool.marketDataPoolSnapshot().openLineCount).toBe(1);
  });

  it("starts over at 1 s on the next drop after a successful resubscribe", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    poolHarness.borrowFails = true;
    ib.emit(EventName.disconnected);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000);

    const secondIb = createFakeIb();
    poolHarness.currentIb = secondIb;
    poolHarness.borrowFails = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(pool.marketDataPoolSnapshot().openLineCount).toBe(1);

    const thirdIb = createFakeIb();
    poolHarness.currentIb = thirdIb;
    secondIb.emit(EventName.disconnected);
    await vi.advanceTimersByTimeAsync(999);
    expect(thirdIb.reqMktData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(thirdIb.reqMktData).toHaveBeenCalledTimes(1);
  });

  it("schedules a single retry timer when the drop is reported more than once", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    poolHarness.borrowFails = true;
    ib.emit(EventName.disconnected);
    ib.emit(EventName.disconnected);
    poolHarness.borrowCount = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poolHarness.borrowCount).toBe(1);
  });

  it("schedules no retry when the pool has no entries at the time of the drop", async () => {
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs);
    await settle();
    poolHarness.borrowCount = 0;
    ib.emit(EventName.disconnected);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poolHarness.borrowCount).toBe(0);
  });

  it("does not resubscribe a paused contract after a reconnect", async () => {
    poolHarness.availableLines = 1;
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await pool.subscribeToPooledQuote(optionAlpha, () => {});
    await settle();
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ pausedCount: 1, openLineCount: 1 });

    const secondIb = createFakeIb();
    poolHarness.currentIb = secondIb;
    ib.emit(EventName.disconnected);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(secondIb.reqMktData).toHaveBeenCalledTimes(1);
    expect(secondIb.reqMktData.mock.calls[0]![1]).toMatchObject({ symbol: "ALPHA", secType: "STK" });
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ pausedCount: 1, openLineCount: 1 });
  });

  it("does not try to cancel on the dead connection when a contract is unsubscribed after the drop", async () => {
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    poolHarness.borrowFails = true;
    ib.emit(EventName.disconnected);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs);
    await settle();
    expect(ib.cancelMktData).not.toHaveBeenCalled();
    expect(pool.marketDataPoolSnapshot().contractCount).toBe(0);
  });
});

describe("stock fallback price for a fast first paint", () => {
  it("shows the fallback price to subscribers of a stock until the live line delivers", async () => {
    poolHarness.fallbackPrices = new Map([["ALPHA", { price: 41.25 }]]);
    const pool = await loadPool();
    const onUpdate = vi.fn();
    await pool.subscribeToPooledQuote(stockAlpha, onUpdate);
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ last: 41.25 }));
    expect(pool.peekPooledQuote(stockAlpha)).toMatchObject({ last: 41.25 });
  });

  it("does not use the fallback for options", async () => {
    poolHarness.fallbackPrices = new Map([["ALPHA", { price: 41.25 }]]);
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(optionAlpha, () => {});
    await settle();
    expect(pool.peekPooledQuote(optionAlpha)?.last).toBeNull();
  });

  it("ignores a fallback that arrives after the live line is already open", async () => {
    let resolveFallback: (prices: Map<string, { price: number }>) => void = () => {};
    poolHarness.fallbackDeferred = { promise: new Promise((resolve) => (resolveFallback = resolve)), resolve: (value) => resolveFallback(value) };
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    expect(pool.marketDataPoolSnapshot().openLineCount).toBe(1);
    resolveFallback(new Map([["ALPHA", { price: 41.25 }]]));
    await settle();
    expect(pool.peekPooledQuote(stockAlpha)?.last).toBeNull();
  });

  it("ignores a missing price and swallows a failing fallback lookup", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    expect(pool.peekPooledQuote(stockAlpha)?.last).toBeNull();

    poolHarness.fallbackRejects = true;
    await expect(pool.subscribeToPooledQuote(stockBravo, () => {})).resolves.toBeTypeOf("function");
    await settle();
    expect(pool.peekPooledQuote(stockBravo)?.last).toBeNull();
  });
});

describe("feed refusal while lines are shed", () => {
  it("clears the pooled refusal when the pool empties because nothing is left to observe", async () => {
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stockAlpha, () => {});
    await settle();
    ib.emit(EventName.error, new Error("No market data during competing live session"), 10197, 1000);
    expect(pool.marketDataFeedRefusal()).toMatchObject({ code: 10197 });
    unsubscribe();
    await vi.advanceTimersByTimeAsync(pool.unsubscribeGraceMs);
    await settle();
    expect(pool.marketDataFeedRefusal()).toBeNull();
    expect(poolHarness.broadcasts.at(-1)).toEqual({ type: "market_data_feed", refusal: null });
  });
});

describe("contracts subscribed while a reconcile is in flight (2026-10-07)", () => {
  it("are never paused by a reservation sized before they existed, and only subscribe once a reconcile booked them", async () => {
    const pool = await loadPool();
    poolHarness.reserveDelayMs = 50;
    const contracts: PriceContract[] = [stockAlpha, stockBravo, optionAlpha, optionBravo, { ...optionAlpha, strike: 55 }, { ...optionAlpha, strike: 60 }];
    // A burst subscribes one contract at a time: the first starts a reconcile sized for 1, the rest arrive while it awaits.
    for (const contract of contracts) await pool.subscribeToPooledQuote(contract, () => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(ib.reqMktData).not.toHaveBeenCalled(); // nothing subscribes before its line is booked
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(ib.cancelMktData).not.toHaveBeenCalled();
    expect(ib.reqMktData).toHaveBeenCalledTimes(contracts.length);
    expect(pool.marketDataPoolSnapshot().pausedCount).toBe(0);
    expect(vi.mocked(console.log).mock.calls.some(([message]) => String(message).includes("paused"))).toBe(false);
    expect(poolHarness.reserveCalls.at(-1)!.lines).toBe(contracts.length);
  });
});
