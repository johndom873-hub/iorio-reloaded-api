import { OptionType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PooledQuote } from "./marketDataPool.js";
import type { OptionQuote } from "./fetchOptionChain.js";

const pool = vi.hoisted(() => {
  const emptyPooledQuote = { last: null, bid: null, ask: null, delta: null, gamma: null, vega: null, theta: null, impliedVolatility: null, underlyingPrice: null, open: null, high: null, low: null, previousClose: null, volume: null };
  return {
    emptyPooledQuote,
    graceMs: 1_000,
    subscriptions: [] as { contract: Record<string, unknown>; push: (quote: PooledQuote) => void; unsubscribe: ReturnType<typeof vi.fn> }[],
  };
});
vi.mock("./marketDataPool.js", () => ({
  emptyPooledQuote: pool.emptyPooledQuote,
  subscribeToPooledQuote: async (contract: Record<string, unknown>, push: (quote: PooledQuote) => void) => {
    const unsubscribe = vi.fn();
    pool.subscriptions.push({ contract, push, unsubscribe });
    return unsubscribe;
  },
  // Same contract as the real one: settles when the predicate holds or after the grace.
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

import { streamPooledOptionQuotes, type OptionQuoteContract } from "./pooledOptionQuotes.js";

const call = (strike: number): OptionQuoteContract => ({ symbol: "AAPL", expiry: "20261016", strike, right: OptionType.Call });
const reading = (overrides: Partial<PooledQuote> = {}): PooledQuote => ({ ...(pool.emptyPooledQuote as PooledQuote), bid: 1, ask: 1.2, last: 1.1, delta: 0.3, gamma: 0.02, vega: 0.1, theta: -0.05, impliedVolatility: 0.4, ...overrides });

describe("streamPooledOptionQuotes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pool.subscriptions.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("returns nothing and subscribes to nothing for no contracts or an already-aborted signal", async () => {
    const onUpdate = vi.fn();
    expect(await streamPooledOptionQuotes([], onUpdate, new AbortController().signal)).toEqual([]);
    const aborted = new AbortController();
    aborted.abort();
    expect(await streamPooledOptionQuotes([call(100)], onUpdate, aborted.signal)).toEqual([]);
    expect(pool.subscriptions).toEqual([]);
  });

  it("subscribes to each contract as an option price contract keyed expiry|strike|right", async () => {
    const result = streamPooledOptionQuotes([call(100), { symbol: "AAPL", expiry: "20261023", strike: 97.5, right: OptionType.Put }], vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.subscriptions.map((subscription) => subscription.contract)).toEqual([
      { key: "20261016|100|C", legType: "option", symbol: "AAPL", expiry: "20261016", strike: 100, right: OptionType.Call },
      { key: "20261023|97.5|P", legType: "option", symbol: "AAPL", expiry: "20261023", strike: 97.5, right: OptionType.Put },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
  });

  it("resolves as soon as every contract has a price and a delta, with each contract's own reading", async () => {
    const result = streamPooledOptionQuotes([call(100), call(105)], vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(reading({ delta: 0.5, bid: 2, ask: 2.2 }));
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    pool.subscriptions[1]!.push(reading({ delta: 0.3, bid: null, ask: null, last: 0.9 }));
    const quotes = await result;
    expect(quotes).toEqual([
      { expiry: "20261016", strike: 100, right: OptionType.Call, bid: 2, ask: 2.2, last: 1.1, impliedVolatility: 0.4, delta: 0.5, gamma: 0.02, vega: 0.1, theta: -0.05 },
      { expiry: "20261016", strike: 105, right: OptionType.Call, bid: null, ask: null, last: 0.9, impliedVolatility: 0.4, delta: 0.3, gamma: 0.02, vega: 0.1, theta: -0.05 },
    ]);
  });

  it("does not count a one-sided quote without a last price as priced", async () => {
    const result = streamPooledOptionQuotes([call(100)], vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(reading({ bid: 1, ask: null, last: null }));
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(settled).toBe(true);
  });

  it("resolves after the grace with whatever it has, leaving silent contracts empty", async () => {
    const result = streamPooledOptionQuotes([call(100), call(105)], vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(reading());
    await vi.advanceTimersByTimeAsync(1_000);
    const quotes = await result;
    expect(quotes[0]).toMatchObject({ strike: 100, delta: 0.3 });
    expect(quotes[1]).toEqual({ expiry: "20261016", strike: 105, right: OptionType.Call, bid: null, ask: null, last: null, impliedVolatility: null, delta: null, gamma: null, vega: null, theta: null });
  });

  it("pushes later updates through onUpdate, coalescing a burst into one call with every contract's latest reading", async () => {
    const onUpdate = vi.fn();
    const result = streamPooledOptionQuotes([call(100), call(105)], onUpdate, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(reading());
    pool.subscriptions[1]!.push(reading());
    await result;
    expect(onUpdate).not.toHaveBeenCalled();

    pool.subscriptions[0]!.push(reading({ delta: 0.31 }));
    pool.subscriptions[0]!.push(reading({ delta: 0.32 }));
    pool.subscriptions[1]!.push(reading({ delta: 0.21 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect((onUpdate.mock.calls[0]![0] as OptionQuote[]).map((quote) => quote.delta)).toEqual([0.32, 0.21]);
  });

  it("does not push updates before the first reading has settled", async () => {
    const onUpdate = vi.fn();
    const result = streamPooledOptionQuotes([call(100), call(105)], onUpdate, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(reading());
    await vi.advanceTimersByTimeAsync(500);
    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await result;
  });

  it("unsubscribes every contract when the signal aborts after the first reading", async () => {
    const controller = new AbortController();
    const result = streamPooledOptionQuotes([call(100)], vi.fn(), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(reading());
    await result;
    expect(pool.subscriptions[0]!.unsubscribe).not.toHaveBeenCalled();
    controller.abort();
    expect(pool.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes at once and returns the current readings when aborted while waiting for the first reading", async () => {
    const controller = new AbortController();
    const result = streamPooledOptionQuotes([call(100)], vi.fn(), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(reading({ delta: null }));
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    const quotes = await result;
    expect(pool.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
    expect(quotes[0]).toMatchObject({ strike: 100, bid: 1, delta: null });
  });
});
