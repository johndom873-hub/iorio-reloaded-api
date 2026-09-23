import { describe, expect, it, vi } from "vitest";
import type { SnapshotCoverage } from "../lib/optionChainCaptureCoverage.js";
import type { StoredOptionChainRefresh } from "./fetchOptionChain.js";
import {
  prepareTicker,
  runOptionChainCapture,
  type OptionChainCaptureDependencies,
  type OptionChainCaptureEvent,
  type PrepareTickerDependencies,
  type PreparedTicker,
  type UniverseTicker,
} from "./runOptionChainCapture.js";

const fakeIb = {} as never;
const today = "2026-09-21";
const ticker = (symbol: string, contractId: number | null = 1): UniverseTicker => ({ tickerId: `id-${symbol}`, symbol, contractId });

// --- prepareTicker ---------------------------------------------------------

const fullGrid = Array.from({ length: 81 }, (_, index) => 60 + index);

/** A stored-chain refresh result where every listed expiry has the given grid (or its own, when a map is passed). */
function storedChain(expirations: string[], grid: number[] | Map<string, number[]> = fullGrid): StoredOptionChainRefresh {
  const strikesByExpiry = grid instanceof Map ? grid : new Map(expirations.map((expiry) => [expiry, grid]));
  return {
    expirations,
    strikesByExpiry,
    timings: { optionParamsMs: 1, expiries: [...strikesByExpiry].map(([expiry, strikes]) => ({ expiry, strikeCount: strikes.length, elapsedMs: 1 })), totalMs: 2 },
  };
}

function prepareDependencies(overrides: Partial<PrepareTickerDependencies> = {}): PrepareTickerDependencies {
  return {
    fetchSpotPrice: async () => 100,
    loadReferenceVolatility: async () => ({ volatility: 0.3, source: "implied_volatility" }),
    refreshStoredOptionChain: async () => storedChain(["20261016"]),
    ...overrides,
  };
}

describe("prepareTicker", () => {
  it("fails clearly without a stored contract id, and without a usable spot price", async () => {
    await expect(prepareTicker(fakeIb, ticker("AAA", null), today, prepareDependencies())).rejects.toThrow("no ibkr_contract_id");
    for (const spot of [null, undefined, 0, -5]) {
      await expect(prepareTicker(fakeIb, ticker("AAA"), today, prepareDependencies({ fetchSpotPrice: async () => spot }))).rejects.toThrow("no usable spot price");
    }
  });

  it("keeps only expiries from 0 to 90 days out (both ends inclusive) and attaches the expiry to each contract", async () => {
    const prepared = await prepareTicker(
      fakeIb,
      ticker("AAA"),
      today,
      prepareDependencies({ refreshStoredOptionChain: async () => storedChain(["20261221", "20261220", "20260921", "20260918"], [95, 100, 105]) }),
    );
    expect([...new Set(prepared.contracts.map((contract) => contract.expiry))]).toEqual(["20260921", "20261220"]);
    expect(prepared.contracts.every((contract) => typeof contract.expiry === "string" && contract.expiry.length === 8)).toBe(true);
  });

  it("refreshes the stored chain once per ticker and selects each expiry's contracts from that expiry's own grid", async () => {
    const refreshStoredOptionChain = vi.fn(async () =>
      storedChain(
        ["20261016", "20261120"],
        new Map([
          ["20261016", fullGrid.filter((strike) => strike % 2 === 0)],
          ["20261120", fullGrid.filter((strike) => strike % 5 === 0)],
        ]),
      ),
    );
    const prepared = await prepareTicker(
      fakeIb,
      ticker("AAA"),
      today,
      prepareDependencies({ loadReferenceVolatility: async () => ({ volatility: null, source: "widest_window" }), refreshStoredOptionChain }),
    );
    expect(refreshStoredOptionChain).toHaveBeenCalledTimes(1);
    expect(refreshStoredOptionChain).toHaveBeenCalledWith(fakeIb, { tickerId: "id-AAA", symbol: "AAA", contractId: 1 }, today);
    expect(prepared.contracts.length).toBeGreaterThan(0);
    expect(prepared.contracts.filter((contract) => contract.expiry === "20261016").every((contract) => contract.strike % 2 === 0)).toBe(true);
    expect(prepared.contracts.filter((contract) => contract.expiry === "20261120").every((contract) => contract.strike % 5 === 0)).toBe(true);
    expect(prepared.chainRefresh.expiries.map((expiry) => expiry.expiry)).toEqual(["20261016", "20261120"]);
  });

  it("sizes the window from the reference volatility, and falls back to the widest (±50%) window when there is none", async () => {
    const narrow = await prepareTicker(fakeIb, ticker("AAA"), today, prepareDependencies({ loadReferenceVolatility: async () => ({ volatility: 0.2, source: "implied_volatility" }) }));
    const widest = await prepareTicker(fakeIb, ticker("AAA"), today, prepareDependencies({ loadReferenceVolatility: async () => ({ volatility: null, source: "widest_window" }) }));
    const strikesOf = (prepared: PreparedTicker) => prepared.contracts.map((contract) => contract.strike);
    expect(widest.referenceVolatilitySource).toBe("widest_window");
    expect(widest.referenceVolatility).toBeNull();
    expect(widest.contracts.length).toBeGreaterThan(narrow.contracts.length);
    // 25 days at 20% IV: half-width 2·0.2·√(25/365) ≈ 0.1047 → strikes ≈ 90.1..111.0 (puts below 100, calls above)
    expect(Math.min(...strikesOf(narrow))).toBeGreaterThanOrEqual(90);
    expect(Math.max(...strikesOf(narrow))).toBeLessThanOrEqual(111);
    // ±50% in log terms: lower bound 100·e^-0.5 ≈ 60.65, so strike 60 is just outside and 61 is the lowest kept
    expect(Math.min(...strikesOf(widest))).toBe(61);
    expect(Math.max(...strikesOf(widest))).toBe(140);
  });

  it("returns no contracts (not an error) when the ticker has no expiry in range", async () => {
    const prepared = await prepareTicker(fakeIb, ticker("AAA"), today, prepareDependencies({ refreshStoredOptionChain: async () => storedChain(["20270115"], [100]) }));
    expect(prepared.contracts).toEqual([]);
  });
});

// --- runOptionChainCapture -------------------------------------------------

const coverage = (requested: number, anyTick: number): SnapshotCoverage => ({
  contractsRequested: requested,
  contractsWithAnyTick: anyTick,
  contractsWithTwoSidedQuote: anyTick,
  contractsWithImpliedVolatility: anyTick,
});
const preparedFor = (universeTicker: UniverseTicker): PreparedTicker => ({
  ticker: universeTicker,
  spotPrice: 100,
  referenceVolatility: 0.3,
  referenceVolatilitySource: "implied_volatility",
  contracts: [{ expiry: "20261016", strike: 100, right: "P" }],
  chainRefresh: { optionParamsMs: 1, expiries: [{ expiry: "20261016", strikeCount: 1, elapsedMs: 1 }], totalMs: 2 },
});

function runDependencies(overrides: Partial<OptionChainCaptureDependencies> = {}) {
  const disconnect = vi.fn();
  const saveFailedSnapshot = vi.fn(async () => {});
  const clock = { nowMs: Date.UTC(2026, 8, 21, 14, 0, 0) };
  const dependencies: OptionChainCaptureDependencies = {
    now: () => new Date(clock.nowMs),
    loadUniverse: async () => [ticker("AAA"), ticker("BBB")],
    getRiskFreeRate: async () => 0.04,
    connect: async () => ({ ib: fakeIb, disconnect }),
    prepareTicker: async (_ib, universeTicker) => preparedFor(universeTicker),
    captureAndSave: async () => coverage(10, 10),
    saveFailedSnapshot,
    ...overrides,
  };
  return { dependencies, disconnect, saveFailedSnapshot, clock };
}

describe("runOptionChainCapture", () => {
  it("captures every ticker in order, reports events, and disconnects", async () => {
    const { dependencies, disconnect } = runDependencies();
    const events: OptionChainCaptureEvent[] = [];
    const result = await runOptionChainCapture((event) => events.push(event), dependencies);
    expect(result).toEqual({ tickersAttempted: 2, tickersComplete: 2, tickersPartial: 0, tickersFailed: 0, recapturedSymbols: [] });
    expect(events.filter((event) => event.type === "tickerStart").map((event) => (event as { symbol: string }).symbol)).toEqual(["AAA", "BBB"]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("passes today's Eastern date and the risk-free rate as a percent to the capture", async () => {
    const captureAndSave = vi.fn(async () => coverage(10, 10));
    const { dependencies } = runDependencies({ captureAndSave, loadUniverse: async () => [ticker("AAA")] });
    await runOptionChainCapture(undefined, dependencies);
    expect(captureAndSave).toHaveBeenCalledWith(fakeIb, expect.anything(), "2026-09-21", 4);
    const noRate = vi.fn(async () => coverage(10, 10));
    await runOptionChainCapture(undefined, runDependencies({ captureAndSave: noRate, getRiskFreeRate: async () => null, loadUniverse: async () => [ticker("AAA")] }).dependencies);
    expect(noRate).toHaveBeenCalledWith(fakeIb, expect.anything(), "2026-09-21", null);
  });

  it("records a failed ticker, keeps going with the rest, and still disconnects", async () => {
    const { dependencies, disconnect, saveFailedSnapshot } = runDependencies({
      prepareTicker: async (_ib, universeTicker) => {
        if (universeTicker.symbol === "AAA") throw new Error("no usable spot price");
        return preparedFor(universeTicker);
      },
    });
    const events: OptionChainCaptureEvent[] = [];
    const result = await runOptionChainCapture((event) => events.push(event), dependencies);
    expect(result).toMatchObject({ tickersAttempted: 2, tickersComplete: 1, tickersFailed: 1 });
    expect(saveFailedSnapshot).toHaveBeenCalledWith(expect.objectContaining({ symbol: "AAA" }), "2026-09-21", "no usable spot price");
    expect(events).toContainEqual({ type: "tickerError", symbol: "AAA", message: "no usable spot price" });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("survives a failure while recording the failed snapshot", async () => {
    const { dependencies } = runDependencies({
      prepareTicker: async () => {
        throw new Error("boom");
      },
      saveFailedSnapshot: async () => {
        throw new Error("db down");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runOptionChainCapture(undefined, dependencies);
    expect(result.tickersFailed).toBe(2);
    warn.mockRestore();
  });

  it("disconnects and rethrows if something outside the per-ticker handling blows up", async () => {
    const { dependencies, disconnect } = runDependencies({ loadUniverse: async () => [ticker("AAA")], captureAndSave: async () => coverage(10, 2) });
    await expect(
      runOptionChainCapture((event) => {
        if (event.type === "recaptureStart") throw new Error("listener blew up");
      }, dependencies),
    ).rejects.toThrow("listener blew up");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("counts partial (starved but some ticks) and failed (no ticks) statuses", async () => {
    const coverages: Record<string, SnapshotCoverage> = { AAA: coverage(10, 10), BBB: coverage(10, 5), CCC: coverage(10, 0) };
    const { dependencies } = runDependencies({
      loadUniverse: async () => [ticker("AAA"), ticker("BBB"), ticker("CCC")],
      captureAndSave: async (_ib, prepared) => coverages[prepared.ticker.symbol]!,
    });
    const result = await runOptionChainCapture(undefined, dependencies);
    expect(result).toMatchObject({ tickersComplete: 1, tickersPartial: 1, tickersFailed: 1 });
  });

  it("re-captures a starved ticker once, and the re-capture's status is the one that counts", async () => {
    let bbbCalls = 0;
    const { dependencies } = runDependencies({
      captureAndSave: async (_ib, prepared) => {
        if (prepared.ticker.symbol !== "BBB") return coverage(10, 10);
        bbbCalls++;
        return bbbCalls === 1 ? coverage(10, 3) : coverage(10, 10);
      },
    });
    const events: OptionChainCaptureEvent[] = [];
    const result = await runOptionChainCapture((event) => events.push(event), dependencies);
    expect(bbbCalls).toBe(2);
    expect(result).toMatchObject({ tickersComplete: 2, tickersPartial: 0, recapturedSymbols: ["BBB"] });
    expect(events).toContainEqual({ type: "recaptureStart", symbols: ["BBB"] });
  });

  it("does not re-capture a ticker that requested nothing, or one that got no ticks at all is still re-captured only if starved", async () => {
    const captureAndSave = vi.fn(async () => coverage(0, 0));
    const { dependencies } = runDependencies({ captureAndSave, loadUniverse: async () => [ticker("AAA")] });
    const result = await runOptionChainCapture(undefined, dependencies);
    expect(captureAndSave).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ tickersFailed: 1, recapturedSymbols: [] });
  });

  it("skips the re-capture entirely once the job has used up its 45-minute budget", async () => {
    const { dependencies, clock } = runDependencies({ loadUniverse: async () => [ticker("AAA")] });
    const captureAndSave = vi.fn(async () => {
      clock.nowMs += 46 * 60 * 1000;
      return coverage(10, 2);
    });
    const result = await runOptionChainCapture(undefined, { ...dependencies, captureAndSave });
    expect(captureAndSave).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ tickersPartial: 1, recapturedSymbols: [] });
  });

  it("stops the re-capture pass after its 10-minute budget, leaving the rest with their first result", async () => {
    const { dependencies, clock } = runDependencies({ loadUniverse: async () => [ticker("AAA"), ticker("BBB"), ticker("CCC")] });
    const calls: string[] = [];
    let firstPassDone = 0;
    const captureAndSave = vi.fn(async (_ib: unknown, prepared: PreparedTicker) => {
      calls.push(prepared.ticker.symbol);
      if (firstPassDone < 3) {
        firstPassDone++;
        return coverage(10, 2);
      }
      clock.nowMs += 11 * 60 * 1000; // the first re-capture alone blows the pass budget
      return coverage(10, 10);
    });
    const result = await runOptionChainCapture(undefined, { ...dependencies, captureAndSave });
    expect(calls).toEqual(["AAA", "BBB", "CCC", "AAA"]);
    expect(result.recapturedSymbols).toEqual(["AAA"]);
    expect(result).toMatchObject({ tickersComplete: 1, tickersPartial: 2 });
  });

  it("keeps the first result when a re-capture itself fails", async () => {
    let calls = 0;
    const { dependencies } = runDependencies({
      loadUniverse: async () => [ticker("AAA")],
      captureAndSave: async () => {
        calls++;
        if (calls === 2) throw new Error("gateway hiccup");
        return coverage(10, 4);
      },
    });
    const events: OptionChainCaptureEvent[] = [];
    const result = await runOptionChainCapture((event) => events.push(event), dependencies);
    expect(result).toMatchObject({ tickersPartial: 1, recapturedSymbols: [] });
    expect(events).toContainEqual({ type: "tickerError", symbol: "AAA", message: "re-capture failed: gateway hiccup" });
  });

  it("handles an empty universe", async () => {
    const { dependencies, disconnect } = runDependencies({ loadUniverse: async () => [] });
    expect(await runOptionChainCapture(undefined, dependencies)).toEqual({ tickersAttempted: 0, tickersComplete: 0, tickersPartial: 0, tickersFailed: 0, recapturedSymbols: [] });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
