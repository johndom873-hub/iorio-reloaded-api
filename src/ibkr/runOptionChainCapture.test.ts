import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotCoverage } from "../lib/optionChainCaptureCoverage.js";
import type { StoredOptionChainRefresh } from "./fetchOptionChain.js";
import {
  buildCaptureFailureMessage,
  prepareTicker,
  runOptionChainCapture,
  type OptionChainCaptureResult,
  type OptionChainCaptureDependencies,
  type OptionChainCaptureEvent,
  type PrepareTickerDependencies,
  type PreparedTicker,
  type UniverseTicker,
} from "./runOptionChainCapture.js";

// An EventEmitter: the run listens for the connection dropping.
const fakeIb = new EventEmitter() as never;
const today = "2026-09-21";
const emptySettleStats = () => ({
  intervalMs: 0,
  minInFlight: null,
  maxInFlight: null,
  lineBusyMs: 0,
  timedOutLineMs: 0,
  settled: 0,
  timedOut: 0,
  errored: 0,
  settledWithoutMarket: 0,
  holdMsP50: null,
  holdMsP90: null,
  holdMsMax: null,
  lastField: { price: 0, delta: 0, openInterest: 0 },
  missingOnTimeout: { price: 0, delta: 0, openInterest: 0 },
  afterFirstReplyMs: { price: { p50: null, p90: null }, delta: { p50: null, p90: null }, openInterest: { p50: null, p90: null } },
  lineUsage: { periodMs: 0, averageSubscribed: 0, averageAnswered: 0, messagesPerSecond: 0, released: 0, releasedUnanswered: 0, firstReplyMsP50: null, firstReplyMsP90: null, holdMsP50: null, holdMsP90: null },
});
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
    loadOpenShortLegContracts: async () => [],
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

  it("stores both rights at every strike within 3% of spot (the put-call parity forward needs several pairs) and only the OTM side further out", async () => {
    const prepared = await prepareTicker(fakeIb, ticker("AAA"), today, prepareDependencies({ refreshStoredOptionChain: async () => storedChain(["20261016"]) })); // spot 100, strikes 60..140
    const keys = new Set(prepared.contracts.map((contract) => `${contract.strike}${contract.right}`));
    for (const strike of [98, 99, 100, 101, 102]) {
      expect(keys.has(`${strike}C`)).toBe(true);
      expect(keys.has(`${strike}P`)).toBe(true);
    }
    expect(keys.has("95C")).toBe(false);
    expect(keys.has("95P")).toBe(true);
    expect(keys.has("105P")).toBe(false);
    expect(keys.has("105C")).toBe(true);
  });

  it("always captures every open short leg's exact contract, ITM or outside the window, once, and never a past expiry (Roll Signals)", async () => {
    const prepared = await prepareTicker(
      fakeIb,
      ticker("AAA"),
      today,
      prepareDependencies({
        refreshStoredOptionChain: async () => storedChain(["20261016"], [95, 100, 105]),
        loadOpenShortLegContracts: async () => [
          { expiry: "20261016", strike: 105, right: "P" }, // ITM put: the window keeps only the call at 105
          { expiry: "20261016", strike: 95, right: "P" }, // already captured by the window: not duplicated
          { expiry: "20261120", strike: 140, right: "C" }, // far outside any window and not in the stored chain: still captured
          { expiry: "20250101", strike: 90, right: "P" }, // already expired: left out
        ],
      }),
    );
    const keys = prepared.contracts.map((contract) => `${contract.expiry}|${contract.strike}|${contract.right}`);
    expect(keys).toContain("20261016|105|P");
    expect(keys).toContain("20261120|140|C");
    expect(keys.filter((key) => key === "20261016|95|P")).toHaveLength(1);
    expect(keys.some((key) => key.startsWith("20250101"))).toBe(false);
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
  const lineReservation = {
    reserve: vi.fn(async () => ({ ok: true, availableLines: 90, priorityLinesHeld: 0 })),
    renew: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const dependencies: OptionChainCaptureDependencies = {
    now: () => new Date(clock.nowMs),
    loadUniverse: async () => [ticker("AAA"), ticker("BBB")],
    getRiskFreeRate: async () => 0.04,
    connect: async () => ({ ib: fakeIb, disconnect }),
    fetchSpotPrices: async (symbols) => Object.fromEntries(symbols.map((symbol) => [symbol, 100])),
    prepareTicker: async (_ib, universeTicker) => preparedFor(universeTicker),
    openQuoteWindow: () => ({ capture: async () => [], close: vi.fn(), inFlightCount: () => 0, drainSettleStats: emptySettleStats, wholeRunSettleStats: emptySettleStats }),
    saveSnapshot: async () => coverage(10, 10),
    saveFailedSnapshot,
    lineReservation,
    waitForPoolShedding: async () => {},
    ...overrides,
  };
  return { dependencies, disconnect, saveFailedSnapshot, clock, lineReservation };
}

describe("runOptionChainCapture", () => {
  it("holds one priority line reservation for the whole run, waits for the pool to shed, and releases it even when the run fails", async () => {
    const { dependencies, lineReservation } = runDependencies();
    const order: string[] = [];
    lineReservation.reserve.mockImplementation(async () => {
      order.push("reserve");
      return { ok: true, availableLines: 90, priorityLinesHeld: 0 };
    });
    const waitForPoolShedding = vi.fn(async () => {
      order.push("wait");
    });
    const connect = vi.fn(async () => {
      order.push("connect");
      return { ib: fakeIb, disconnect: vi.fn() };
    });
    await runOptionChainCapture(undefined, { ...dependencies, waitForPoolShedding, connect });
    expect(order).toEqual(["reserve", "wait", "connect"]);
    expect(lineReservation.reserve).toHaveBeenCalledWith("optionChainCapture", 30, expect.any(Number));
    expect(lineReservation.release).toHaveBeenCalledWith("optionChainCapture");

    const failing = runDependencies({
      connect: async () => {
        throw new Error("gateway down");
      },
    });
    await expect(runOptionChainCapture(undefined, failing.dependencies)).rejects.toThrow("gateway down");
    expect(failing.lineReservation.release).toHaveBeenCalledTimes(1);
  });

  it("captures only the requested symbols, and neither reserves lines nor waits for the pool when the caller already holds them (retry rounds)", async () => {
    const { dependencies, lineReservation } = runDependencies({ loadUniverse: async () => [ticker("AAA"), ticker("BBB"), ticker("CCC")] });
    const waitForPoolShedding = vi.fn(async () => {});
    const fetchSpotPrices = vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((symbol) => [symbol, 100])));
    const events: OptionChainCaptureEvent[] = [];
    const result = await runOptionChainCapture((event) => events.push(event), { ...dependencies, waitForPoolShedding, fetchSpotPrices }, { symbols: ["BBB", "CCC"], linesAlreadyHeld: true });
    expect(result.tickersAttempted).toBe(2);
    expect(events.filter((event) => event.type === "tickerStart").map((event) => (event as { symbol: string }).symbol)).toEqual(["BBB", "CCC"]);
    // Fresh spots for just the retried tickers, so a retry is never priced off the first pass's stale spot.
    expect(fetchSpotPrices).toHaveBeenCalledWith(["BBB", "CCC"], expect.any(Function));
    expect(lineReservation.reserve).not.toHaveBeenCalled();
    expect(lineReservation.release).not.toHaveBeenCalled();
    expect(waitForPoolShedding).not.toHaveBeenCalled();
  });

  it("refuses to run when the priority reservation is rejected", async () => {
    const { dependencies, lineReservation } = runDependencies();
    lineReservation.reserve.mockResolvedValue({ ok: false, availableLines: 10, priorityLinesHeld: 80 });
    await expect(runOptionChainCapture(undefined, dependencies)).rejects.toThrow("chain capture");
  });

  it("captures every ticker in order, reports events, and disconnects", async () => {
    const { dependencies, disconnect } = runDependencies();
    const events: OptionChainCaptureEvent[] = [];
    const result = await runOptionChainCapture((event) => events.push(event), dependencies);
    expect(result).toMatchObject({ tickersAttempted: 2, tickersComplete: 2, tickersPartial: 0, tickersFailed: 0, failedSymbols: [], recapturedSymbols: [], riskFreeRateUnavailable: false, fallbackSpotSymbols: [] });
    expect(events.filter((event) => event.type === "tickerStart").map((event) => (event as { symbol: string }).symbol)).toEqual(["AAA", "BBB"]);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("stops when the IBKR connection drops mid-run instead of subscribing the rest on a dead socket", async () => {
    const ib = new EventEmitter();
    const close = vi.fn();
    const saveFailedSnapshot = vi.fn(async () => {});
    const prepareTicker = vi.fn(async (_ib: unknown, universeTicker: UniverseTicker) => {
      // The connection drops while the second ticker is being prepared (a Gateway restart).
      if (universeTicker.symbol === "BBB") ib.emit(EventName.disconnected);
      return preparedFor(universeTicker);
    });
    const { dependencies, disconnect, lineReservation } = runDependencies({
      loadUniverse: async () => [ticker("AAA"), ticker("BBB"), ticker("CCC")],
      connect: async () => ({ ib: ib as never, disconnect }),
      prepareTicker: prepareTicker as never,
      openQuoteWindow: () => ({ capture: async () => [], close, inFlightCount: () => 0, drainSettleStats: emptySettleStats, wholeRunSettleStats: emptySettleStats }),
    });
    await expect(runOptionChainCapture(undefined, { ...dependencies, saveFailedSnapshot })).rejects.toThrow("IBKR connection lost mid-run; not captured: CCC");
    expect(prepareTicker).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(lineReservation.release).toHaveBeenCalledWith("optionChainCapture");
    expect(ib.listenerCount(EventName.disconnected)).toBe(0);
  });

  it("passes today's Eastern date and the risk-free rate as a percent to the capture", async () => {
    const saveSnapshot = vi.fn(async () => coverage(10, 10));
    const { dependencies } = runDependencies({ saveSnapshot, loadUniverse: async () => [ticker("AAA")] });
    await runOptionChainCapture(undefined, dependencies);
    expect(saveSnapshot).toHaveBeenCalledWith(expect.anything(), [], "2026-09-21", 4, expect.any(Number));
    const noRate = vi.fn(async () => coverage(10, 10));
    await runOptionChainCapture(undefined, runDependencies({ saveSnapshot: noRate, getRiskFreeRate: async () => null, loadUniverse: async () => [ticker("AAA")] }).dependencies);
    expect(noRate).toHaveBeenCalledWith(expect.anything(), [], "2026-09-21", null, expect.any(Number));
  });

  it("collects the tickers whose spot came from a stored fallback", async () => {
    const fetchSpotPrices = vi.fn(async (symbols: string[], onFallbackPriceUsed?: (symbols: string[]) => void) => {
      onFallbackPriceUsed?.(["BBB"]);
      return Object.fromEntries(symbols.map((symbol) => [symbol, 100]));
    });
    const result = await runOptionChainCapture(undefined, runDependencies({ fetchSpotPrices }).dependencies);
    expect(result.fallbackSpotSymbols).toEqual(["BBB"]);
  });

  it("lists weak snapshots (thin quotes, delayed data) and keeps healthy real-time ones out", async () => {
    const realTimeQuote = { sawRealTimeTicks: true, sawDelayedTicks: false } as never;
    const delayedQuote = { sawRealTimeTicks: false, sawDelayedTicks: true } as never;
    const coverages: Record<string, SnapshotCoverage> = { AAA: coverage(100, 100), BBB: { ...coverage(100, 100), contractsWithTwoSidedQuote: 60 }, CCC: coverage(100, 100) };
    const quotesBySymbol: Record<string, never[]> = { AAA: [realTimeQuote], BBB: [realTimeQuote], CCC: [delayedQuote] };
    const { dependencies } = runDependencies({
      loadUniverse: async () => [ticker("AAA"), ticker("BBB"), ticker("CCC")],
      openQuoteWindow: () => ({ capture: async (symbol: string) => quotesBySymbol[symbol]!, close: vi.fn(), inFlightCount: () => 0, drainSettleStats: emptySettleStats, wholeRunSettleStats: emptySettleStats }),
      saveSnapshot: async (prepared) => coverages[prepared.ticker.symbol]!,
    });
    const result = await runOptionChainCapture(undefined, dependencies);
    expect(result.qualityProblems).toEqual(["BBB: two-sided quotes 60% (min 75%)", "CCC: market data type delayed"]);
  });

  it("flags the run when no risk-free rate was available", async () => {
    const withRate = await runOptionChainCapture(undefined, runDependencies({ loadUniverse: async () => [ticker("AAA")] }).dependencies);
    expect(withRate.riskFreeRateUnavailable).toBe(false);
    const withoutRate = await runOptionChainCapture(undefined, runDependencies({ getRiskFreeRate: async () => null, loadUniverse: async () => [ticker("AAA")] }).dependencies);
    expect(withoutRate.riskFreeRateUnavailable).toBe(true);
  });

  describe("buildCaptureFailureMessage", () => {
    const cleanResult: OptionChainCaptureResult = { tickersAttempted: 9, tickersComplete: 9, tickersPartial: 0, tickersFailed: 0, failedSymbols: [], recapturedSymbols: [], riskFreeRateUnavailable: false, fallbackSpotSymbols: [], qualityProblems: [] };

    it("is undefined for a clean run", () => {
      expect(buildCaptureFailureMessage(cleanResult)).toBeUndefined();
    });

    it("names the missing risk-free rate", () => {
      expect(buildCaptureFailureMessage({ ...cleanResult, riskFreeRateUnavailable: true })).toContain("risk-free rate unavailable");
    });

    it("reports failed tickers and a missing rate together", () => {
      const message = buildCaptureFailureMessage({ ...cleanResult, tickersComplete: 7, tickersFailed: 2, failedSymbols: ["AAA", "BBB"], riskFreeRateUnavailable: true });
      expect(message).toBe("2 of 9 tickers not captured: AAA, BBB; risk-free rate unavailable (FRED fetch failed and none is stored), so the snapshots were saved without it and no surface can be fitted");
    });

    it("reports an empty universe, fallback spots and weak snapshots", () => {
      expect(buildCaptureFailureMessage({ ...cleanResult, tickersAttempted: 0 })).toBe("no tickers to capture (shortlist and open positions are both empty)");
      const message = buildCaptureFailureMessage({ ...cleanResult, fallbackSpotSymbols: ["AAA", "BBB"], qualityProblems: ["CCC: partial (60% of contracts got a tick)", "DDD: market data type delayed"] });
      expect(message).toBe("spot price came from a stored fallback, not live: AAA, BBB; weak snapshots: CCC: partial (60% of contracts got a tick), DDD: market data type delayed");
    });

    it("never contains the '): ' sequence that truncates the Telegram alert", () => {
      expect(buildCaptureFailureMessage({ ...cleanResult, tickersFailed: 1, failedSymbols: ["AAA"], riskFreeRateUnavailable: true })).not.toContain("): ");
      expect(buildCaptureFailureMessage({ ...cleanResult, fallbackSpotSymbols: ["AAA"], qualityProblems: ["BBB: two-sided quotes 60% (min 75%)"] })).not.toContain("): ");
    });
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
    const { dependencies, disconnect } = runDependencies({ loadUniverse: async () => [ticker("AAA")], saveSnapshot: async () => coverage(10, 2) });
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
      saveSnapshot: async (prepared) => coverages[prepared.ticker.symbol]!,
    });
    const result = await runOptionChainCapture(undefined, dependencies);
    expect(result).toMatchObject({ tickersComplete: 1, tickersPartial: 1, tickersFailed: 1 });
  });

  it("re-captures a starved ticker once, and the re-capture's status is the one that counts", async () => {
    let bbbCalls = 0;
    const { dependencies } = runDependencies({
      saveSnapshot: async (prepared) => {
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
    const saveSnapshot = vi.fn(async () => coverage(0, 0));
    const { dependencies } = runDependencies({ saveSnapshot, loadUniverse: async () => [ticker("AAA")] });
    const result = await runOptionChainCapture(undefined, dependencies);
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ tickersFailed: 1, failedSymbols: expect.any(Array), recapturedSymbols: [] });
  });

  it("skips the re-capture entirely once the job has used up its 45-minute budget", async () => {
    const { dependencies, clock } = runDependencies({ loadUniverse: async () => [ticker("AAA")] });
    const saveSnapshot = vi.fn(async () => {
      clock.nowMs += 46 * 60 * 1000;
      return coverage(10, 2);
    });
    const result = await runOptionChainCapture(undefined, { ...dependencies, saveSnapshot });
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ tickersPartial: 1, recapturedSymbols: [] });
  });

  it("queues every starved ticker on the window at once for the re-capture pass and fetches all spots in one call up front", async () => {
    const fetchSpotPrices = vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((symbol) => [symbol, 100])));
    const captureCalls: string[] = [];
    let resolveAll: () => void = () => {};
    const gate = new Promise<void>((resolve) => (resolveAll = resolve));
    let firstPass = 0;
    const capture = vi.fn(async (symbol: string) => {
      captureCalls.push(symbol);
      if (firstPass < 3) {
        firstPass++;
        return [];
      }
      await gate; // re-captures are all in flight together before any resolves
      return [];
    });
    let saves = 0;
    const { dependencies } = runDependencies({
      loadUniverse: async () => [ticker("AAA"), ticker("BBB"), ticker("CCC")],
      fetchSpotPrices,
      openQuoteWindow: () => ({ capture, close: vi.fn(), inFlightCount: () => 0, drainSettleStats: emptySettleStats, wholeRunSettleStats: emptySettleStats }),
      saveSnapshot: async () => (++saves <= 3 ? coverage(10, 2) : coverage(10, 10)),
    });
    const run = runOptionChainCapture(undefined, dependencies);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captureCalls).toEqual(["AAA", "BBB", "CCC", "AAA", "BBB", "CCC"]);
    resolveAll();
    const result = await run;
    expect(fetchSpotPrices).toHaveBeenCalledTimes(1);
    expect(fetchSpotPrices).toHaveBeenCalledWith(["AAA", "BBB", "CCC"], expect.any(Function));
    expect(result).toMatchObject({ tickersComplete: 3, recapturedSymbols: ["AAA", "BBB", "CCC"] });
  });

  it("keeps the first result when a re-capture itself fails", async () => {
    let calls = 0;
    const { dependencies } = runDependencies({
      loadUniverse: async () => [ticker("AAA")],
      saveSnapshot: async () => {
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

  it("opens one quote window for the run, queues each ticker on it as soon as it is prepared, and closes it at the end", async () => {
    const order: string[] = [];
    const close = vi.fn();
    const capture = vi.fn(async (symbol: string) => {
      order.push(`capture:${symbol}`);
      return [];
    });
    const { dependencies } = runDependencies({
      openQuoteWindow: () => ({ capture, close, inFlightCount: () => 0, drainSettleStats: emptySettleStats, wholeRunSettleStats: emptySettleStats }),
      prepareTicker: async (_ib, universeTicker) => {
        order.push(`prepare:${universeTicker.symbol}`);
        return preparedFor(universeTicker);
      },
    });
    await runOptionChainCapture(undefined, dependencies);
    expect(order).toEqual(["prepare:AAA", "capture:AAA", "prepare:BBB", "capture:BBB"]);
    expect(capture).toHaveBeenCalledWith("AAA", preparedFor(ticker("AAA")).contracts);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("handles an empty universe", async () => {
    const { dependencies, disconnect } = runDependencies({ loadUniverse: async () => [] });
    expect(await runOptionChainCapture(undefined, dependencies)).toEqual({ tickersAttempted: 0, tickersComplete: 0, tickersPartial: 0, tickersFailed: 0, failedSymbols: [], recapturedSymbols: [], riskFreeRateUnavailable: false, fallbackSpotSymbols: [], qualityProblems: [] });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("waitForLinesToFitBudget", () => {
  function ledger(totals: (number | Error)[]) {
    let nowMs = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      dependencies: {
        loadReservations: async () => {
          const next = totals.length > 1 ? totals.shift()! : totals[0]!;
          if (next instanceof Error) throw next;
          return [{ holder: "optionChainCapture", lines: 30 }, { holder: "marketDataPool", lines: next - 30 }];
        },
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
          nowMs += milliseconds;
        },
        now: () => nowMs,
      },
    };
  }

  it("starts at once when every reservation already fits the budget", async () => {
    const { waitForLinesToFitBudget } = await import("./runOptionChainCapture.js");
    const { dependencies, sleeps } = ledger([72]);
    await expect(waitForLinesToFitBudget(dependencies)).resolves.toEqual({ waitedMs: 0, fits: true });
    expect(sleeps).toEqual([]);
  });

  it("checks every second until the live pool has shed, and keeps checking through a failed read", async () => {
    const { waitForLinesToFitBudget } = await import("./runOptionChainCapture.js");
    const { dependencies } = ledger([110, new Error("db hiccup"), 110, 90]);
    await expect(waitForLinesToFitBudget(dependencies)).resolves.toEqual({ waitedMs: 3_000, fits: true });
  });

  it("gives up after the grace and reports that the lines still do not fit", async () => {
    const { waitForLinesToFitBudget } = await import("./runOptionChainCapture.js");
    const { dependencies, sleeps } = ledger([110]);
    await expect(waitForLinesToFitBudget(dependencies, 2_500)).resolves.toEqual({ waitedMs: 2_500, fits: false });
    expect(sleeps).toEqual([1_000, 1_000, 500]);
  });
});

describe("describeCaptureLineUsage", () => {
  it("reports lines subscribed and answered, the message rate, the wait for IBKR, hold times, field arrival and where line time went", async () => {
    const { describeCaptureLineUsage } = await import("./runOptionChainCapture.js");
    const line = describeCaptureLineUsage("Capture window", 30, {
      ...emptySettleStats(),
      intervalMs: 10_000,
      minInFlight: 28,
      maxInFlight: 30,
      lineBusyMs: 495_000,
      timedOutLineMs: 72_000,
      settled: 101,
      timedOut: 9,
      settledWithoutMarket: 4,
      holdMsP50: 3_900,
      holdMsP90: 7_200,
      holdMsMax: 8_000,
      lastField: { price: 6, delta: 15, openInterest: 80 },
      missingOnTimeout: { price: 0, delta: 2, openInterest: 9 },
      afterFirstReplyMs: { price: { p50: 0, p90: 100 }, delta: { p50: 1_200, p90: 2_400 }, openInterest: { p50: 300, p90: 900 } },
      lineUsage: { periodMs: 10_000, averageSubscribed: 29.6, averageAnswered: 21, messagesPerSecond: 19.8, released: 110, releasedUnanswered: 2, firstReplyMsP50: 2_900, firstReplyMsP90: 3_400, holdMsP50: 3_900, holdMsP90: 7_200 },
    });
    expect(line).toBe(
      "Capture window: lines 30/30 now, min 28 max 30 over 10.0s, subscribed avg 29.6, answered avg 21.0, 19.8 msg/s, first reply p50 2.9s p90 3.4s (2 never answered of 110); " +
        "110 released, held p50 3.9s p90 7.2s max 8.0s; after first reply p50/p90: price 0.0s/0.1s, delta 1.2s/2.4s, OI 0.3s/0.9s; " +
        "101 full data (waited last on price 6, delta 15, OI 80; 4 with \"no data\" on a side), 9 timed out holding 72.0s of line time (missing price 0, delta 2, OI 9), 0 errored.",
    );
  });
});
