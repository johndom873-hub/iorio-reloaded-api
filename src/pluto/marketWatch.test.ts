import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlutoSettings } from "./settingsStore.js";

const harness = vi.hoisted(() => ({
  linesEnabled: true,
  subscribed: [] as string[],
  unsubscribed: [] as string[],
  /** The quote callback of each subscription, by key. */
  listeners: new Map<string, (quote: { last: number | null; bid: number | null; ask: number | null; previousClose: number | null }) => void>(),
}));

vi.mock("../config/env.js", () => ({ ibkrMarketDataLinesEnabled: () => harness.linesEnabled }));
vi.mock("../ibkr/marketDataPool.js", () => ({
  subscribeToPooledQuote: async (contract: { key: string }, listener: (quote: { last: number | null; bid: number | null; ask: number | null; previousClose: number | null }) => void) => {
    harness.subscribed.push(contract.key);
    harness.listeners.set(contract.key, listener);
    return () => harness.unsubscribed.push(contract.key);
  },
}));

const { PlutoMarketWatch } = await import("./marketWatch.js");

const settings = { burstLines: 10, burstSettleSeconds: 4 } as PlutoSettings;

beforeEach(() => {
  harness.linesEnabled = true;
  harness.subscribed.length = 0;
  harness.unsubscribed.length = 0;
  harness.listeners.clear();
});

describe("PlutoMarketWatch.watch", () => {
  it("subscribes one stock line per ticker plus SPY and books no burst lines up front", async () => {
    const watch = new PlutoMarketWatch(settings);
    const result = await watch.watch(["COIN", "HOOD"]);
    expect(result).toEqual({ ok: true, detail: "3 stock lines; a quote burst adds up to 10 more for 4 s" });
    expect(harness.subscribed).toEqual(["pluto-stock-COIN", "pluto-stock-HOOD", "pluto-stock-SPY"]);
  });

  it("drops tickers that left the list and keeps the rest subscribed once", async () => {
    const watch = new PlutoMarketWatch(settings);
    await watch.watch(["COIN", "HOOD"]);
    await watch.watch(["HOOD"]);
    expect(harness.unsubscribed).toEqual(["pluto-stock-COIN"]);
    expect(harness.subscribed).toEqual(["pluto-stock-COIN", "pluto-stock-HOOD", "pluto-stock-SPY"]);
  });

  it("refuses and holds nothing when market-data lines are disabled in the environment", async () => {
    const watch = new PlutoMarketWatch(settings);
    await watch.watch(["COIN"]);
    harness.linesEnabled = false;
    const result = await watch.watch(["COIN"]);
    expect(result.ok).toBe(false);
    expect(harness.unsubscribed).toEqual(["pluto-stock-COIN", "pluto-stock-SPY"]);
  });
});

describe("PlutoMarketWatch.watchNowAndAwaitQuote", () => {
  const quote = (bid: number | null, ask: number | null) => ({ last: 42.42, bid, ask, previousClose: 41 });

  it("subscribes a switched-on ticker's line at once and answers as soon as a two-sided quote arrives", async () => {
    vi.useFakeTimers();
    try {
      const watch = new PlutoMarketWatch(settings);
      await watch.watch(["NVDA"]);
      const waiting = watch.watchNowAndAwaitQuote("RKLB", 10_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.subscribed).toEqual(["pluto-stock-NVDA", "pluto-stock-SPY", "pluto-stock-RKLB"]);
      // A one-sided quote is not enough.
      harness.listeners.get("pluto-stock-RKLB")!(quote(null, 42.45));
      await vi.advanceTimersByTimeAsync(1_000);
      harness.listeners.get("pluto-stock-RKLB")!(quote(42.4, 42.45));
      await vi.advanceTimersByTimeAsync(250);
      expect(await waiting).toBe(true);
      // Housekeeping's next watch keeps it, subscribed once.
      await watch.watch(["NVDA", "RKLB"]);
      expect(harness.subscribed.filter((key) => key === "pluto-stock-RKLB")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers false after the timeout with no quote, the line kept; false at once when lines are disabled", async () => {
    vi.useFakeTimers();
    try {
      const watch = new PlutoMarketWatch(settings);
      const waiting = watch.watchNowAndAwaitQuote("RKLB", 10_000);
      await vi.advanceTimersByTimeAsync(10_250);
      expect(await waiting).toBe(false);
      expect(watch.snapshot("RKLB")).not.toBeNull();
      harness.linesEnabled = false;
      expect(await watch.watchNowAndAwaitQuote("AMD", 10_000)).toBe(false);
      expect(harness.subscribed).not.toContain("pluto-stock-AMD");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers at once for a ticker already quoted", async () => {
    const watch = new PlutoMarketWatch(settings);
    await watch.watch(["RKLB"]);
    harness.listeners.get("pluto-stock-RKLB")!(quote(42.4, 42.45));
    expect(await watch.watchNowAndAwaitQuote("RKLB", 10_000)).toBe(true);
  });
});

describe("PlutoMarketWatch.hasFreshTwoSidedQuote", () => {
  it("holds a quote to the order route's 15 seconds and to a bid above 0 at or under the ask", async () => {
    const watch = new PlutoMarketWatch(settings);
    await watch.watch(["RKLB"]);
    const listener = harness.listeners.get("pluto-stock-RKLB")!;
    expect(watch.hasFreshTwoSidedQuote("RKLB", Date.now())).toBe(false);
    listener({ last: 42.42, bid: 42.4, ask: 42.45, previousClose: 41 });
    const receivedAtMs = watch.snapshot("RKLB")!.updatedAtMs!;
    expect(watch.hasFreshTwoSidedQuote("RKLB", receivedAtMs + 15_000)).toBe(true);
    expect(watch.hasFreshTwoSidedQuote("RKLB", receivedAtMs + 15_001)).toBe(false);
    listener({ last: 42.42, bid: 0, ask: 42.45, previousClose: 41 });
    expect(watch.hasFreshTwoSidedQuote("RKLB", Date.now())).toBe(false);
    listener({ last: 42.42, bid: 42.5, ask: 42.45, previousClose: 41 });
    expect(watch.hasFreshTwoSidedQuote("RKLB", Date.now())).toBe(false);
    expect(watch.hasFreshTwoSidedQuote("AMD", Date.now())).toBe(false);
  });
});

describe("PlutoMarketWatch.burst", () => {
  it("subscribes at most burstLines contracts for the settle time, then lets them go", async () => {
    vi.useFakeTimers();
    try {
      const watch = new PlutoMarketWatch({ burstLines: 2, burstSettleSeconds: 4 } as PlutoSettings);
      const contracts = [100, 105, 110].map((strike) => ({ expiry: "2026-10-16", strike, right: "P" as const }));
      const burst = watch.burst("COIN", contracts);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.subscribed).toHaveLength(2);
      expect(harness.unsubscribed).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(4_000);
      await burst;
      expect(harness.unsubscribed).toEqual(harness.subscribed);
    } finally {
      vi.useRealTimers();
    }
  });
});
