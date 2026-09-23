import { describe, expect, it, vi } from "vitest";
import type { StoredOptionChainRefresh } from "./fetchOptionChain.js";
import { runOptionChainStructureRefresh, type OptionChainStructureDependencies, type OptionChainStructureEvent } from "./runOptionChainStructureRefresh.js";
import type { UniverseTicker } from "./runOptionChainCapture.js";

const fakeIb = {} as never;
const ticker = (symbol: string, contractId: number | null = 1): UniverseTicker => ({ tickerId: `id-${symbol}`, symbol, contractId });

const refreshResult = (expiries: { expiry: string; strikeCount: number }[]): StoredOptionChainRefresh => ({
  expirations: expiries.map((expiry) => expiry.expiry),
  strikesByExpiry: new Map(expiries.map((expiry) => [expiry.expiry, Array.from({ length: expiry.strikeCount }, (_, index) => 100 + index)])),
  timings: { optionParamsMs: 1, expiries: expiries.map((expiry) => ({ expiry: expiry.expiry, strikeCount: expiry.strikeCount, elapsedMs: 1 })), totalMs: 2 },
});

function runDependencies(overrides: Partial<OptionChainStructureDependencies> = {}): OptionChainStructureDependencies {
  const disconnect = vi.fn();
  return {
    now: () => new Date("2026-09-23T12:00:00Z"),
    loadUniverse: async () => [ticker("AAA"), ticker("BBB")],
    connect: async () => ({ ib: fakeIb, disconnect }),
    refreshStoredOptionChain: async () => refreshResult([{ expiry: "20261016", strikeCount: 5 }]),
    ...overrides,
  };
}

describe("runOptionChainStructureRefresh", () => {
  it("refreshes every ticker in order, reports events, and disconnects", async () => {
    const dependencies = runDependencies();
    const events: OptionChainStructureEvent[] = [];
    const result = await runOptionChainStructureRefresh((event) => events.push(event), dependencies);
    expect(result).toEqual({ tickersAttempted: 2, tickersComplete: 2, tickersFailed: 0 });
    expect(events.filter((event) => event.type === "tickerDone").map((event) => (event as { symbol: string }).symbol)).toEqual(["AAA", "BBB"]);
  });

  it("passes each ticker's id/symbol/contractId and today's Eastern date to the refresh call", async () => {
    const refreshStoredOptionChain = vi.fn(async () => refreshResult([{ expiry: "20261016", strikeCount: 5 }]));
    const dependencies = runDependencies({ refreshStoredOptionChain, loadUniverse: async () => [ticker("AAA", 42)] });
    await runOptionChainStructureRefresh(undefined, dependencies);
    expect(refreshStoredOptionChain).toHaveBeenCalledWith(fakeIb, { tickerId: "id-AAA", symbol: "AAA", contractId: 42 }, "2026-09-23");
  });

  it("fails a ticker with no stored contract id clearly, without calling IBKR", async () => {
    const refreshStoredOptionChain = vi.fn(async () => refreshResult([]));
    const dependencies = runDependencies({ refreshStoredOptionChain, loadUniverse: async () => [ticker("AAA", null)] });
    const events: OptionChainStructureEvent[] = [];
    const result = await runOptionChainStructureRefresh((event) => events.push(event), dependencies);
    expect(result).toEqual({ tickersAttempted: 1, tickersComplete: 0, tickersFailed: 1 });
    expect(events).toContainEqual({ type: "tickerError", symbol: "AAA", message: "no ibkr_contract_id stored for this ticker" });
    expect(refreshStoredOptionChain).not.toHaveBeenCalled();
  });

  it("records a failed ticker, keeps going with the rest, and still disconnects", async () => {
    const disconnect = vi.fn();
    const dependencies = runDependencies({
      connect: async () => ({ ib: fakeIb, disconnect }),
      refreshStoredOptionChain: async (_ib, tickerArg) => {
        if (tickerArg.symbol === "AAA") throw new Error("strike grid lookup timed out");
        return refreshResult([{ expiry: "20261016", strikeCount: 5 }]);
      },
    });
    const events: OptionChainStructureEvent[] = [];
    const result = await runOptionChainStructureRefresh((event) => events.push(event), dependencies);
    expect(result).toEqual({ tickersAttempted: 2, tickersComplete: 1, tickersFailed: 1 });
    expect(events).toContainEqual({ type: "tickerError", symbol: "AAA", message: "strike grid lookup timed out" });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("handles an empty universe", async () => {
    const disconnect = vi.fn();
    const dependencies = runDependencies({ loadUniverse: async () => [], connect: async () => ({ ib: fakeIb, disconnect }) });
    expect(await runOptionChainStructureRefresh(undefined, dependencies)).toEqual({ tickersAttempted: 0, tickersComplete: 0, tickersFailed: 0 });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
