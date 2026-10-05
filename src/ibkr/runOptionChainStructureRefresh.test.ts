import { describe, expect, it, vi } from "vitest";
import { IbkrLookupTimeoutError, type StoredOptionChainRefresh } from "./fetchOptionChain.js";
import { runOptionChainStructureRefresh, structureGridMaxAgeDays, type OptionChainStructureDependencies, type OptionChainStructureEvent } from "./runOptionChainStructureRefresh.js";
import type { UniverseTicker } from "./runOptionChainCapture.js";

const fakeIb = {} as never;
const ticker = (symbol: string, contractId: number | null = 1): UniverseTicker => ({ tickerId: `id-${symbol}`, symbol, contractId });

const emptyTotals = { failedSymbols: [], skippedSymbols: [], gridLookups: 0, gridsReused: 0 };

const refreshResult = (expiries: { expiry: string; strikeCount: number; reused?: boolean }[]): StoredOptionChainRefresh => ({
  expirations: expiries.map((expiry) => expiry.expiry),
  strikesByExpiry: new Map(expiries.map((expiry) => [expiry.expiry, Array.from({ length: expiry.strikeCount }, (_, index) => 100 + index)])),
  timings: { optionParamsMs: 1, expiries: expiries.map((expiry) => ({ expiry: expiry.expiry, strikeCount: expiry.strikeCount, elapsedMs: 1, reused: expiry.reused })), totalMs: 2 },
});

function runDependencies(overrides: Partial<OptionChainStructureDependencies> = {}): OptionChainStructureDependencies {
  const disconnect = vi.fn();
  return {
    now: () => new Date("2026-09-23T12:00:00Z"),
    loadUniverse: async () => [ticker("AAA"), ticker("BBB")],
    connect: async () => ({ ib: fakeIb, disconnect }),
    refreshStoredOptionChain: async () => refreshResult([{ expiry: "20261016", strikeCount: 5 }]),
    loadSpotPrices: async () => new Map([["AAA", 101]]),
    ...overrides,
  };
}

describe("runOptionChainStructureRefresh", () => {
  it("refreshes every ticker in order, reports events, and disconnects", async () => {
    const dependencies = runDependencies();
    const events: OptionChainStructureEvent[] = [];
    const result = await runOptionChainStructureRefresh((event) => events.push(event), dependencies);
    expect(result).toEqual({ tickersAttempted: 2, tickersComplete: 2, tickersFailed: 0, ...emptyTotals, gridLookups: 2 });
    expect(events.filter((event) => event.type === "tickerDone").map((event) => (event as { symbol: string }).symbol)).toEqual(["AAA", "BBB"]);
  });

  it("passes each ticker's id/symbol/contractId, today's Eastern date and the grid-reuse rule with its spot to the refresh call", async () => {
    const refreshStoredOptionChain = vi.fn(async () => refreshResult([{ expiry: "20261016", strikeCount: 5 }]));
    const dependencies = runDependencies({ refreshStoredOptionChain, loadUniverse: async () => [ticker("AAA", 42), ticker("BBB", 43)] });
    await runOptionChainStructureRefresh(undefined, dependencies);
    expect(refreshStoredOptionChain).toHaveBeenCalledWith(fakeIb, { tickerId: "id-AAA", symbol: "AAA", contractId: 42 }, "2026-09-23", { maxAgeDays: structureGridMaxAgeDays, spotPrice: 101 });
    // No known spot: the reuse rule falls back to age alone.
    expect(refreshStoredOptionChain).toHaveBeenCalledWith(fakeIb, { tickerId: "id-BBB", symbol: "BBB", contractId: 43 }, "2026-09-23", { maxAgeDays: structureGridMaxAgeDays, spotPrice: null });
  });

  it("counts a ticker with no expirations, or expirations without any strikes, as failed instead of complete", async () => {
    const dependencies = runDependencies({
      loadUniverse: async () => [ticker("AAA"), ticker("NOEXP"), ticker("NOSTRIKES")],
      refreshStoredOptionChain: async (_ib, universeTicker) => {
        if (universeTicker.symbol === "NOEXP") return refreshResult([]);
        if (universeTicker.symbol === "NOSTRIKES") return refreshResult([{ expiry: "20261016", strikeCount: 0 }]);
        return refreshResult([{ expiry: "20261016", strikeCount: 5 }]);
      },
    });
    const events: OptionChainStructureEvent[] = [];
    const result = await runOptionChainStructureRefresh((event) => events.push(event), dependencies);
    expect(result).toMatchObject({ tickersComplete: 1, tickersFailed: 2, failedSymbols: ["NOEXP", "NOSTRIKES"] });
    expect(events.filter((event) => event.type === "tickerError").map((event) => (event as { message: string }).message)).toEqual(["IBKR returned no option expirations", "IBKR returned no strikes for any expiry"]);
  });

  it("counts looked-up and reused grids", async () => {
    const dependencies = runDependencies({
      refreshStoredOptionChain: async () =>
        refreshResult([
          { expiry: "20261016", strikeCount: 5, reused: true },
          { expiry: "20261023", strikeCount: 5, reused: true },
          { expiry: "20261030", strikeCount: 5 },
        ]),
    });
    const result = await runOptionChainStructureRefresh(undefined, dependencies);
    expect(result.gridsReused).toBe(4);
    expect(result.gridLookups).toBe(2);
  });

  it("stops at the first IBKR timeout, skipping the rest instead of queueing more requests behind it", async () => {
    const disconnect = vi.fn();
    const refreshStoredOptionChain = vi.fn(async (_ib: unknown, tickerArg: { symbol: string }) => {
      if (tickerArg.symbol === "BBB") throw new IbkrLookupTimeoutError("strike grid lookup for BBB 20261030 timed out after 30s");
      return refreshResult([{ expiry: "20261016", strikeCount: 5 }]);
    });
    const dependencies = runDependencies({
      connect: async () => ({ ib: fakeIb, disconnect }),
      loadUniverse: async () => [ticker("AAA"), ticker("BBB"), ticker("CCC"), ticker("DDD")],
      refreshStoredOptionChain: refreshStoredOptionChain as never,
    });
    const events: OptionChainStructureEvent[] = [];
    const result = await runOptionChainStructureRefresh((event) => events.push(event), dependencies);
    expect(result).toMatchObject({ tickersComplete: 1, tickersFailed: 1, failedSymbols: ["BBB"], skippedSymbols: ["CCC", "DDD"] });
    expect(refreshStoredOptionChain).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "aborted", afterSymbol: "BBB", skippedSymbols: ["CCC", "DDD"] });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("fails a ticker with no stored contract id clearly, without calling IBKR", async () => {
    const refreshStoredOptionChain = vi.fn(async () => refreshResult([]));
    const dependencies = runDependencies({ refreshStoredOptionChain, loadUniverse: async () => [ticker("AAA", null)] });
    const events: OptionChainStructureEvent[] = [];
    const result = await runOptionChainStructureRefresh((event) => events.push(event), dependencies);
    expect(result).toEqual({ tickersAttempted: 1, tickersComplete: 0, tickersFailed: 1, ...emptyTotals, failedSymbols: ["AAA"] });
    expect(events).toContainEqual({ type: "tickerError", symbol: "AAA", message: "no ibkr_contract_id stored for this ticker" });
    expect(refreshStoredOptionChain).not.toHaveBeenCalled();
  });

  it("records a failed ticker (an IBKR error, not a timeout), keeps going with the rest, and still disconnects", async () => {
    const disconnect = vi.fn();
    const dependencies = runDependencies({
      connect: async () => ({ ib: fakeIb, disconnect }),
      refreshStoredOptionChain: async (_ib, tickerArg) => {
        if (tickerArg.symbol === "AAA") throw new Error("strike grid lookup for AAA 20261016 failed (code 321): invalid request");
        return refreshResult([{ expiry: "20261016", strikeCount: 5 }]);
      },
    });
    const events: OptionChainStructureEvent[] = [];
    const result = await runOptionChainStructureRefresh((event) => events.push(event), dependencies);
    expect(result).toEqual({ tickersAttempted: 2, tickersComplete: 1, tickersFailed: 1, ...emptyTotals, failedSymbols: ["AAA"], gridLookups: 1 });
    expect(events).toContainEqual({ type: "tickerError", symbol: "AAA", message: "strike grid lookup for AAA 20261016 failed (code 321): invalid request" });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("handles an empty universe", async () => {
    const disconnect = vi.fn();
    const dependencies = runDependencies({ loadUniverse: async () => [], connect: async () => ({ ib: fakeIb, disconnect }) });
    expect(await runOptionChainStructureRefresh(undefined, dependencies)).toEqual({ tickersAttempted: 0, tickersComplete: 0, tickersFailed: 0, ...emptyTotals });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("canReuseStoredGrid", async () => {
  const { canReuseStoredGrid } = await import("./fetchOptionChain.js");
  const now = new Date("2026-09-28T12:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const grid = (fetchedDaysAgo: number) => ({ strikes: [90, 95, 100, 105, 110], fetchedAt: daysAgo(fetchedDaysAgo) });

  it("reuses a grid younger than the max age while spot is inside its strike range (edges included)", () => {
    expect(canReuseStoredGrid(grid(3), { maxAgeDays: 7, spotPrice: 100 }, now)).toBe(true);
    expect(canReuseStoredGrid(grid(7), { maxAgeDays: 7, spotPrice: 90 }, now)).toBe(true);
    expect(canReuseStoredGrid(grid(3), { maxAgeDays: 7, spotPrice: 110 }, now)).toBe(true);
  });

  it("looks up again once the grid is older than the max age", () => {
    expect(canReuseStoredGrid(grid(7.01), { maxAgeDays: 7, spotPrice: 100 }, now)).toBe(false);
  });

  it("looks up again when spot moved outside the stored strike range", () => {
    expect(canReuseStoredGrid(grid(1), { maxAgeDays: 7, spotPrice: 89.99 }, now)).toBe(false);
    expect(canReuseStoredGrid(grid(1), { maxAgeDays: 7, spotPrice: 110.01 }, now)).toBe(false);
  });

  it("decides on age alone without a spot, and never reuses a missing or empty grid", () => {
    expect(canReuseStoredGrid(grid(1), { maxAgeDays: 7, spotPrice: null }, now)).toBe(true);
    expect(canReuseStoredGrid(undefined, { maxAgeDays: 7, spotPrice: 100 }, now)).toBe(false);
    expect(canReuseStoredGrid({ strikes: [], fetchedAt: daysAgo(1) }, { maxAgeDays: 7, spotPrice: 100 }, now)).toBe(false);
  });
});
