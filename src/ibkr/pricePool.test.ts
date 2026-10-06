import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceContract } from "./fetchLivePrices.js";

const pool = vi.hoisted(() => ({
  pooledQuotes: new Map<string, Record<string, unknown>>(),
  peeked: [] as PriceContract[],
  subscriptions: [] as { contract: PriceContract; push: (quote: { last: number | null }) => void; unsubscribe: ReturnType<typeof vi.fn> }[],
  graceMs: 1_000,
  fetchLivePricesCalls: [] as { contracts: PriceContract[]; options: unknown }[],
  fetchLivePricesResult: {} as Record<string, number | null>,
}));
vi.mock("./marketDataPool.js", () => ({
  peekPooledQuote: (contract: PriceContract) => {
    pool.peeked.push(contract);
    return pool.pooledQuotes.get(contract.key) ?? null;
  },
  subscribeToPooledQuote: async (contract: PriceContract, push: (quote: { last: number | null }) => void) => {
    const unsubscribe = vi.fn();
    pool.subscriptions.push({ contract, push, unsubscribe });
    return unsubscribe;
  },
  waitForFirstReading: (isComplete: () => boolean) => {
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => (resolveSettled = resolve));
    const timer = setTimeout(resolveSettled, pool.graceMs);
    return {
      settled,
      check: () => {
        if (!isComplete()) return;
        clearTimeout(timer);
        resolveSettled();
      },
    };
  },
}));
vi.mock("./fetchLivePrices.js", () => ({
  fetchLivePrices: async (contracts: PriceContract[], options: unknown) => {
    pool.fetchLivePricesCalls.push({ contracts, options });
    return pool.fetchLivePricesResult;
  },
}));

import { fetchPricesPoolFirst, streamPooledPrices, streamPooledStockPrices, subscribeToPooledPrice } from "./pricePool.js";

const stock = (symbol: string): PriceContract => ({ key: symbol, legType: "stock", symbol });
const option = (key: string): PriceContract => ({ key, legType: "option", symbol: "AAPL", expiry: "20261016", strike: 200 });

beforeEach(() => {
  vi.useFakeTimers();
  pool.pooledQuotes.clear();
  pool.peeked.length = 0;
  pool.subscriptions.length = 0;
  pool.fetchLivePricesCalls.length = 0;
  pool.fetchLivePricesResult = {};
});
afterEach(() => vi.useRealTimers());

describe("fetchPricesPoolFirst", () => {
  it("reads pooled contracts from the pool and never calls IBKR when every contract is pooled", async () => {
    pool.pooledQuotes.set("AAPL", { last: 190 });
    pool.pooledQuotes.set("MSFT", { last: 410 });
    expect(await fetchPricesPoolFirst([stock("AAPL"), stock("MSFT")])).toEqual({ AAPL: 190, MSFT: 410 });
    expect(pool.fetchLivePricesCalls).toEqual([]);
  });

  it("snapshots only the contracts that are not pooled, passing the options through, and merges the results", async () => {
    pool.pooledQuotes.set("AAPL", { last: 190 });
    pool.fetchLivePricesResult = { MSFT: 410, o: null };
    const options = { priorityLines: true, snapshotTimeoutMs: 2_000 };
    expect(await fetchPricesPoolFirst([stock("AAPL"), stock("MSFT"), option("o")], options)).toEqual({ AAPL: 190, MSFT: 410, o: null });
    expect(pool.fetchLivePricesCalls).toEqual([{ contracts: [stock("MSFT"), option("o")], options }]);
  });

  it("treats a pooled contract with no last price yet as not pooled", async () => {
    pool.pooledQuotes.set("AAPL", { last: null });
    pool.fetchLivePricesResult = { AAPL: 191 };
    expect(await fetchPricesPoolFirst([stock("AAPL")])).toEqual({ AAPL: 191 });
    expect(pool.fetchLivePricesCalls[0]!.contracts).toEqual([stock("AAPL")]);
  });

  it("accepts a pooled last of zero as a pooled price", async () => {
    pool.pooledQuotes.set("AAPL", { last: 0 });
    expect(await fetchPricesPoolFirst([stock("AAPL")])).toEqual({ AAPL: 0 });
    expect(pool.fetchLivePricesCalls).toEqual([]);
  });

  it("returns an empty map for no contracts", async () => {
    expect(await fetchPricesPoolFirst([])).toEqual({});
    expect(pool.fetchLivePricesCalls).toEqual([]);
  });

  it("passes empty options by default", async () => {
    pool.fetchLivePricesResult = { AAPL: 190 };
    await fetchPricesPoolFirst([stock("AAPL")]);
    expect(pool.fetchLivePricesCalls[0]!.options).toEqual({});
  });
});

describe("subscribeToPooledPrice", () => {
  it("forwards each pooled quote's last price and returns the pool's unsubscribe", async () => {
    const onUpdate = vi.fn();
    const unsubscribe = await subscribeToPooledPrice(stock("AAPL"), onUpdate);
    pool.subscriptions[0]!.push({ last: 190 });
    pool.subscriptions[0]!.push({ last: null });
    expect(onUpdate.mock.calls).toEqual([[190], [null]]);
    expect(unsubscribe).toBe(pool.subscriptions[0]!.unsubscribe);
  });
});

describe("streamPooledPrices", () => {
  const stream = (contracts: PriceContract[], onUpdate = vi.fn(), controller = new AbortController()) => ({ promise: streamPooledPrices(contracts, onUpdate, controller.signal), onUpdate, controller });

  it("does nothing for no contracts", async () => {
    const { promise, onUpdate } = stream([]);
    await promise;
    expect(onUpdate).not.toHaveBeenCalled();
    expect(pool.subscriptions).toEqual([]);
  });

  it("emits one combined snapshot as soon as every contract has a price, flagged as the frozen phase complete", async () => {
    const { promise, onUpdate, controller } = stream([stock("AAPL"), stock("MSFT")]);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push({ last: 190 });
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).not.toHaveBeenCalled();
    pool.subscriptions[1]!.push({ last: 410 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ AAPL: 190, MSFT: 410 }, { frozenPhaseComplete: true });
    controller.abort();
    await promise;
  });

  it("after the 1 s grace emits what it has, with null for silent contracts", async () => {
    const { onUpdate } = stream([stock("AAPL"), stock("MSFT")]);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push({ last: 190 });
    await vi.advanceTimersByTimeAsync(999);
    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ AAPL: 190, MSFT: null }, { frozenPhaseComplete: true });
  });

  it("emits a fresh full snapshot for every later change", async () => {
    const { onUpdate } = stream([stock("AAPL"), stock("MSFT")]);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push({ last: 190 });
    pool.subscriptions[1]!.push({ last: 410 });
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push({ last: 191 });
    pool.subscriptions[1]!.push({ last: 411 });
    expect(onUpdate.mock.calls.map((call) => call[0])).toEqual([{ AAPL: 190, MSFT: 410 }, { AAPL: 191, MSFT: 410 }, { AAPL: 191, MSFT: 411 }]);
  });

  it("hands out a copy: a later change does not mutate an earlier emitted snapshot", async () => {
    const { onUpdate } = stream([stock("AAPL")]);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push({ last: 190 });
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push({ last: 195 });
    expect(onUpdate.mock.calls[0]![0]).toEqual({ AAPL: 190 });
  });

  it("stays pending until the signal aborts, then unsubscribes every contract", async () => {
    const { promise, controller } = stream([stock("AAPL"), stock("MSFT")]);
    let finished = false;
    void promise.then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push({ last: 190 });
    pool.subscriptions[1]!.push({ last: 410 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(finished).toBe(false);
    controller.abort();
    await promise;
    expect(pool.subscriptions.map((subscription) => subscription.unsubscribe.mock.calls.length)).toEqual([1, 1]);
  });

  it("unsubscribes at once and emits nothing when the signal aborted before the subscriptions were ready", async () => {
    const controller = new AbortController();
    controller.abort();
    const { promise, onUpdate } = stream([stock("AAPL")], vi.fn(), controller);
    await promise;
    expect(onUpdate).not.toHaveBeenCalled();
    expect(pool.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("finishes at once after the first emit when the signal aborted during the grace wait", async () => {
    const controller = new AbortController();
    const { promise, onUpdate } = stream([stock("AAPL")], vi.fn(), controller);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
    expect(onUpdate).toHaveBeenCalledWith({ AAPL: null }, { frozenPhaseComplete: true });
    expect(pool.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("streamPooledStockPrices", () => {
  it("does nothing for no symbols", async () => {
    await streamPooledStockPrices([], vi.fn(), new AbortController().signal);
    expect(pool.subscriptions).toEqual([]);
  });

  it("subscribes each symbol as a stock keyed by itself and passes the prices without the status", async () => {
    const onUpdate = vi.fn();
    const controller = new AbortController();
    const promise = streamPooledStockPrices(["AAPL", "MSFT"], onUpdate, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.subscriptions.map((subscription) => subscription.contract)).toEqual([stock("AAPL"), stock("MSFT")]);
    pool.subscriptions[0]!.push({ last: 190 });
    pool.subscriptions[1]!.push({ last: 410 });
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledWith({ AAPL: 190, MSFT: 410 });
    expect(onUpdate.mock.calls[0]).toHaveLength(1);
    controller.abort();
    await promise;
  });
});
