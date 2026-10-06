import { OptionType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GreeksContract } from "./fetchLiveGreeks.js";

type Quote = { delta: number | null; gamma: number | null; vega: number | null; theta: number | null; impliedVolatility: number | null; underlyingPrice: number | null };

const pool = vi.hoisted(() => ({
  pooledQuotes: new Map<string, Record<string, unknown>>(),
  peeked: [] as Record<string, unknown>[],
  subscriptions: [] as { contract: Record<string, unknown>; push: (quote: unknown) => void; unsubscribe: ReturnType<typeof vi.fn> }[],
  graceMs: 1_000,
  fetchLiveGreeksCalls: [] as GreeksContract[][],
  fetchLiveGreeksResult: {} as Record<string, unknown>,
}));
vi.mock("./marketDataPool.js", () => ({
  peekPooledQuote: (contract: Record<string, unknown>) => {
    pool.peeked.push(contract);
    return pool.pooledQuotes.get(contract.key as string) ?? null;
  },
  subscribeToPooledQuote: async (contract: Record<string, unknown>, push: (quote: unknown) => void) => {
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
vi.mock("./fetchLiveGreeks.js", () => ({
  fetchLiveGreeks: async (contracts: GreeksContract[]) => {
    pool.fetchLiveGreeksCalls.push(contracts);
    return pool.fetchLiveGreeksResult;
  },
}));

import { fetchGreeksPoolFirst, streamPooledGreeks, subscribeToPooledGreeks } from "./greeksPool.js";

const contract = (key: string, strike = 200, right: OptionType = OptionType.Call): GreeksContract => ({ key, symbol: "AAPL", expiry: "20261016", strike, right });
const quote = (overrides: Partial<Quote> = {}): Quote => ({ delta: 0.3, gamma: 0.02, vega: 0.1, theta: -0.05, impliedVolatility: 0.4, underlyingPrice: 200, ...overrides });
const emptyReading = { delta: null, gamma: null, vega: null, theta: null };

beforeEach(() => {
  vi.useFakeTimers();
  pool.pooledQuotes.clear();
  pool.peeked.length = 0;
  pool.subscriptions.length = 0;
  pool.fetchLiveGreeksCalls.length = 0;
  pool.fetchLiveGreeksResult = {};
});
afterEach(() => vi.useRealTimers());

describe("fetchGreeksPoolFirst", () => {
  it("peeks the pool for each contract as an option price contract", async () => {
    pool.fetchLiveGreeksResult = {};
    await fetchGreeksPoolFirst([contract("a", 200, OptionType.Call)]);
    expect(pool.peeked[0]).toEqual({ key: "a", legType: "option", symbol: "AAPL", expiry: "20261016", strike: 200, right: OptionType.Call });
  });

  it("takes the greeks of a pooled contract that has a delta, with no IBKR snapshot at all", async () => {
    pool.pooledQuotes.set("a", quote({ delta: -0.4, impliedVolatility: 0.55 }));
    expect(await fetchGreeksPoolFirst([contract("a")])).toEqual({ a: { delta: -0.4, gamma: 0.02, vega: 0.1, theta: -0.05, impliedVolatility: 0.55, underlyingPrice: 200 } });
    expect(pool.fetchLiveGreeksCalls).toEqual([]);
  });

  it("counts a delta of exactly 0 as pooled", async () => {
    pool.pooledQuotes.set("a", quote({ delta: 0 }));
    expect((await fetchGreeksPoolFirst([contract("a")])).a).toMatchObject({ delta: 0 });
    expect(pool.fetchLiveGreeksCalls).toEqual([]);
  });

  it("snapshots the contracts with no pooled delta and merges them with the pooled ones", async () => {
    pool.pooledQuotes.set("a", quote());
    pool.pooledQuotes.set("b", quote({ delta: null }));
    pool.fetchLiveGreeksResult = { b: { delta: 0.2, gamma: 0.01, vega: 0.05, theta: -0.02 }, c: emptyReading };
    const result = await fetchGreeksPoolFirst([contract("a"), contract("b"), contract("c")]);
    expect(pool.fetchLiveGreeksCalls).toEqual([[contract("b"), contract("c")]]);
    expect(Object.keys(result).sort()).toEqual(["a", "b", "c"]);
    expect(result.a).toMatchObject({ delta: 0.3 });
    expect(result.b).toMatchObject({ delta: 0.2 });
  });

  it("returns an empty map for no contracts", async () => {
    expect(await fetchGreeksPoolFirst([])).toEqual({});
    expect(pool.fetchLiveGreeksCalls).toEqual([]);
  });
});

describe("subscribeToPooledGreeks", () => {
  it("subscribes the contract as an option and forwards the greeks of each pooled quote", async () => {
    const onUpdate = vi.fn();
    const unsubscribe = await subscribeToPooledGreeks(contract("a", 195, OptionType.Put), onUpdate);
    expect(pool.subscriptions[0]!.contract).toEqual({ key: "a", legType: "option", symbol: "AAPL", expiry: "20261016", strike: 195, right: OptionType.Put });
    pool.subscriptions[0]!.push({ ...quote({ delta: -0.3 }), bid: 1, last: 2 });
    expect(onUpdate).toHaveBeenCalledWith({ delta: -0.3, gamma: 0.02, vega: 0.1, theta: -0.05, impliedVolatility: 0.4, underlyingPrice: 200 });
    expect(unsubscribe).toBe(pool.subscriptions[0]!.unsubscribe);
  });
});

describe("streamPooledGreeks", () => {
  const stream = (contracts: GreeksContract[], onUpdate = vi.fn(), controller = new AbortController()) => ({ promise: streamPooledGreeks(contracts, onUpdate, controller.signal), onUpdate, controller });

  it("does nothing for no contracts", async () => {
    const { promise, onUpdate } = stream([]);
    await promise;
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("emits one snapshot as soon as every contract has a delta", async () => {
    const { onUpdate } = stream([contract("a"), contract("b")]);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(quote({ delta: 0.3 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).not.toHaveBeenCalled();
    pool.subscriptions[1]!.push(quote({ delta: 0.2 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0]).toEqual({ a: quote({ delta: 0.3 }), b: quote({ delta: 0.2 }) });
  });

  it("emits after the 1 s grace with an empty reading for a contract that never ticked", async () => {
    const { onUpdate } = stream([contract("a"), contract("b")]);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(quote());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0]).toEqual({ a: quote(), b: emptyReading });
  });

  it("emits a fresh full snapshot for every later update", async () => {
    const { onUpdate } = stream([contract("a")]);
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(quote({ delta: 0.3 }));
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(quote({ delta: 0.31 }));
    expect(onUpdate.mock.calls.map((call) => (call[0] as Record<string, Quote>).a!.delta)).toEqual([0.3, 0.31]);
  });

  it("stays pending until aborted and then unsubscribes everything", async () => {
    const { promise, controller } = stream([contract("a"), contract("b")]);
    let finished = false;
    void promise.then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    pool.subscriptions[0]!.push(quote());
    pool.subscriptions[1]!.push(quote());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(finished).toBe(false);
    controller.abort();
    await promise;
    expect(pool.subscriptions.map((subscription) => subscription.unsubscribe.mock.calls.length)).toEqual([1, 1]);
  });

  it("unsubscribes at once and emits nothing when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { promise, onUpdate } = stream([contract("a")], vi.fn(), controller);
    await promise;
    expect(onUpdate).not.toHaveBeenCalled();
    expect(pool.subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
