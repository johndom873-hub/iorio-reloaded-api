import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptionType } from "@stoqey/ib";
import type { CycleInput } from "./cycles.js";
import type { CloseLiveState } from "./closeLiveState.js";
import type { PooledQuote } from "../ibkr/marketDataPool.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";

// The database is faked as a chain that records what was asked and answers `first` (the position row) and `select` (the open legs).
const hoisted = vi.hoisted(() => ({
  positionRow: { current: undefined as unknown },
  legRows: { current: [] as unknown[] },
  positionLookupError: { current: null as Error | string | null },
  chainCalls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  subscribeToPooledQuote: vi.fn(),
  loadCycleInputsForTickers: vi.fn(),
  computeMarketSessionStatus: vi.fn(),
}));

vi.mock("../db/connection.js", () => {
  function chainFor(table: string) {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ["join", "where", "whereNull"]) {
      chain[method] = (...args) => {
        hoisted.chainCalls.push({ table, method, args });
        return chain;
      };
    }
    chain.first = async (...args) => {
      hoisted.chainCalls.push({ table, method: "first", args });
      if (hoisted.positionLookupError.current !== null) throw hoisted.positionLookupError.current;
      return hoisted.positionRow.current;
    };
    chain.select = async (...args) => {
      hoisted.chainCalls.push({ table, method: "select", args });
      return hoisted.legRows.current;
    };
    return chain;
  }
  const db = Object.assign((table: string) => chainFor(table), { raw: (sql: string) => ({ rawSql: sql }) });
  return { db };
});
vi.mock("../ibkr/marketDataPool.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/marketDataPool.js")>("../ibkr/marketDataPool.js");
  return { ...actual, subscribeToPooledQuote: (...args: unknown[]) => hoisted.subscribeToPooledQuote(...args) };
});
vi.mock("./cycleQueries.js", () => ({ loadCycleInputsForTickers: (...args: unknown[]) => hoisted.loadCycleInputsForTickers(...args) }));
vi.mock("./marketSessionStatus.js", async () => {
  const actual = await vi.importActual<typeof import("./marketSessionStatus.js")>("./marketSessionStatus.js");
  return { ...actual, computeMarketSessionStatus: (...args: unknown[]) => hoisted.computeMarketSessionStatus(...args) };
});

const { closeGateVerdictFromState, evaluateCloseGateForPosition, inputsForDerivation, loadCloseLiveInputs, toCloseLiveQuote } = await import("./closeGate.js");
const { settleGraceMs } = await import("../ibkr/marketDataPool.js");

const base: CloseLiveState = { live: false, pending: false, blockReason: null, marketOpen: true, legQuotes: {}, cycleTotal: null };

// 100 shares bought at 50 on 2026-09-01 with no commission, last daily bar 55.
const stockCycleInput: CycleInput = {
  optionLegs: [],
  stockLegs: [{ positionId: "pos-1", quantity: 100, entryAt: new Date("2026-09-01T15:00:00Z"), exitAt: null }],
  stockTrades: [{ at: new Date("2026-09-01T15:00:00Z"), side: "buy", quantity: 100, price: 50, commission: 0 }],
  dailyCloses: new Map([["2026-09-25", 55]]),
  lastPrice: { date: "2026-09-25", price: 55 },
  openPositionPremiumPnl: new Map(),
};

const stockLegRow = { id: "leg-stock", legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: "50.0000", optionType: null, strikePrice: null, expiryDate: null, expiryLabel: null };
const shortPutLegRow = { id: "leg-put", legType: "option", side: "short", quantity: 1, multiplier: 100, entryPrice: "2.5000", optionType: "put", strikePrice: "45.0000", expiryDate: "20261016", expiryLabel: "2026-10-16" };
const shortCallLegRow = { id: "leg-call", legType: "option", side: "short", quantity: 1, multiplier: 100, entryPrice: "1.2000", optionType: "call", strikePrice: "152.5000", expiryDate: "20261016", expiryLabel: "2026-10-16" };

function seedPosition(legRows: unknown[], overrides: { status?: string; cycleInput?: CycleInput | null } = {}) {
  hoisted.positionRow.current = { status: overrides.status ?? "open", tickerId: "ticker-1", symbol: "ABC" };
  hoisted.legRows.current = legRows;
  hoisted.loadCycleInputsForTickers.mockResolvedValue(overrides.cycleInput === null ? [] : [{ symbol: "ABC", tickerId: "ticker-1", input: overrides.cycleInput ?? stockCycleInput }]);
}

function pooledQuote(overrides: Partial<PooledQuote>): PooledQuote {
  return { last: null, bid: null, ask: null, ...overrides } as PooledQuote;
}

/** Makes subscribeToPooledQuote deliver `quotesByKey[key]` (when present) right away and hand back one unsubscribe spy per contract. */
function deliverQuotesOnSubscribe(quotesByKey: Record<string, PooledQuote>) {
  const unsubscribeByKey = new Map<string, ReturnType<typeof vi.fn>>();
  hoisted.subscribeToPooledQuote.mockImplementation(async (contract: PriceContract, onUpdate: (quote: PooledQuote) => void) => {
    const unsubscribe = vi.fn();
    unsubscribeByKey.set(contract.key, unsubscribe);
    const quote = quotesByKey[contract.key];
    if (quote) onUpdate(quote);
    return unsubscribe;
  });
  return unsubscribeByKey;
}

beforeEach(() => {
  hoisted.positionRow.current = undefined;
  hoisted.legRows.current = [];
  hoisted.positionLookupError.current = null;
  hoisted.chainCalls.length = 0;
  hoisted.subscribeToPooledQuote.mockReset();
  hoisted.loadCycleInputsForTickers.mockReset();
  hoisted.computeMarketSessionStatus.mockReset().mockResolvedValue({ state: "open", label: "closes in 1h", nextChangeAt: "" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("closeGateVerdictFromState", () => {
  it("allows a live state and passes the cycle total through", () => {
    expect(closeGateVerdictFromState({ ...base, live: true, cycleTotal: 123.4 })).toEqual({ blocked: false, reason: null, cycleTotal: 123.4 });
  });
  it("blocks with the derivation's own reason", () => {
    expect(closeGateVerdictFromState({ ...base, blockReason: "The market is closed right now." })).toEqual({ blocked: true, reason: "The market is closed right now.", cycleTotal: null });
  });
  it("still-waiting after the grace is a block, never a pass", () => {
    const verdict = closeGateVerdictFromState({ ...base, pending: true, blockReason: "Waiting for live quotes…" });
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe("Waiting for live quotes…");
  });
  it("never passes a non-live state without a reason", () => {
    expect(closeGateVerdictFromState(base).blocked).toBe(true);
    expect(closeGateVerdictFromState(base).reason).toMatch(/live quotes/);
  });
  it("drops a stale cycle total from a blocked state", () => {
    expect(closeGateVerdictFromState({ ...base, blockReason: "x", cycleTotal: 99 }).cycleTotal).toBeNull();
  });
});

describe("toCloseLiveQuote", () => {
  it("keeps only bid, ask and last", () => {
    expect(toCloseLiveQuote(pooledQuote({ bid: 1.1, ask: 1.3, last: 1.2, delta: 0.4 } as Partial<PooledQuote>))).toEqual({ bid: 1.1, ask: 1.3, last: 1.2 });
  });
  it("passes nulls through unchanged", () => {
    expect(toCloseLiveQuote(pooledQuote({}))).toEqual({ bid: null, ask: null, last: null });
  });
});

describe("loadCloseLiveInputs", () => {
  it("returns null when the position does not exist", async () => {
    hoisted.positionRow.current = undefined;
    expect(await loadCloseLiveInputs("missing")).toBeNull();
    expect(hoisted.loadCycleInputsForTickers).not.toHaveBeenCalled();
  });

  it.each(["closed", "pending", "cancelled"])("returns null for a position whose status is %s, without reading legs or cycles", async (status) => {
    seedPosition([stockLegRow], { status });
    expect(await loadCloseLiveInputs("pos-1")).toBeNull();
    expect(hoisted.loadCycleInputsForTickers).not.toHaveBeenCalled();
    expect(hoisted.chainCalls.some((call) => call.table === "position_legs")).toBe(false);
  });

  it("returns null when the ticker's cycle inputs cannot be loaded", async () => {
    seedPosition([stockLegRow], { cycleInput: null });
    expect(await loadCloseLiveInputs("pos-1")).toBeNull();
  });

  it("asks only for the position's own still-open legs", async () => {
    seedPosition([stockLegRow]);
    await loadCloseLiveInputs("pos-1");
    const legCalls = hoisted.chainCalls.filter((call) => call.table === "position_legs");
    expect(legCalls.find((call) => call.method === "where")!.args).toEqual([{ position_id: "pos-1" }]);
    expect(legCalls.find((call) => call.method === "whereNull")!.args).toEqual(["exit_at"]);
    expect(hoisted.loadCycleInputsForTickers).toHaveBeenCalledWith(["ticker-1"]);
  });

  it("builds a stock leg, labelled by symbol, and a single stock pool contract", async () => {
    seedPosition([stockLegRow]);
    const inputs = await loadCloseLiveInputs("pos-1");
    expect(inputs).toEqual({
      positionId: "pos-1",
      tickerId: "ticker-1",
      symbol: "ABC",
      legs: [{ id: "leg-stock", legType: "stock", side: "long", quantity: 100, multiplier: 1, entryPrice: 50, label: "ABC stock" }],
      contracts: [{ key: "stock", contract: { key: "stock", legType: "stock", symbol: "ABC" } }],
      cycleInput: stockCycleInput,
    });
  });

  it("builds option legs with numeric prices, call/put labels and an IBKR contract per leg after the stock contract", async () => {
    seedPosition([shortCallLegRow, shortPutLegRow]);
    const inputs = (await loadCloseLiveInputs("pos-1"))!;
    expect(inputs.legs.map((leg) => leg.label)).toEqual(["$152.5C 2026-10-16", "$45P 2026-10-16"]);
    expect(inputs.legs.map((leg) => leg.entryPrice)).toEqual([1.2, 2.5]);
    expect(inputs.contracts).toEqual([
      { key: "stock", contract: { key: "stock", legType: "stock", symbol: "ABC" } },
      { key: "leg-call", contract: { key: "leg-call", legType: "option", symbol: "ABC", expiry: "20261016", strike: 152.5, right: OptionType.Call } },
      { key: "leg-put", contract: { key: "leg-put", legType: "option", symbol: "ABC", expiry: "20261016", strike: 45, right: OptionType.Put } },
    ]);
  });

  it("a covered call yields the stock contract once (shared by the stock leg) plus the option contract", async () => {
    seedPosition([stockLegRow, shortCallLegRow]);
    const inputs = (await loadCloseLiveInputs("pos-1"))!;
    expect(inputs.legs).toHaveLength(2);
    expect(inputs.contracts.map((entry) => entry.key)).toEqual(["stock", "leg-call"]);
  });

  it("propagates a database failure rather than inventing inputs", async () => {
    hoisted.positionLookupError.current = new Error("connection reset");
    await expect(loadCloseLiveInputs("pos-1")).rejects.toThrow("connection reset");
  });
});

describe("inputsForDerivation", () => {
  it("carries the position identity, quotes and the Eastern date", () => {
    const inputs = { positionId: "pos-1", tickerId: "t", symbol: "ABC", legs: [], contracts: [], cycleInput: stockCycleInput };
    const stockQuote = { bid: 1, ask: 2, last: 1.5 };
    const optionQuotes = { "leg-call": { bid: 0.1, ask: 0.2, last: null } };
    const derived = inputsForDerivation(inputs, optionQuotes, stockQuote);
    expect(derived).toMatchObject({ symbol: "ABC", positionId: "pos-1", legs: [], optionQuotesByLegId: optionQuotes, stockQuote, cycleInput: stockCycleInput });
    expect(derived.todayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("evaluateCloseGateForPosition fails closed", () => {
  it("blocks, naming the cause, when loading the position's data throws", async () => {
    hoisted.positionLookupError.current = new Error("connection reset");
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict).toEqual({ blocked: true, reason: "Closing is blocked: the position's data could not be loaded (connection reset).", cycleTotal: null });
    expect(hoisted.subscribeToPooledQuote).not.toHaveBeenCalled();
  });

  it("blocks when a non-Error value is thrown while loading", async () => {
    hoisted.positionLookupError.current = "boom";
    expect((await evaluateCloseGateForPosition("pos-1")).reason).toBe("Closing is blocked: the position's data could not be loaded (boom).");
  });

  it("blocks a position that is not open", async () => {
    seedPosition([stockLegRow], { status: "closed" });
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict).toEqual({ blocked: true, reason: "Closing is blocked: the position is not open or its wheel-cycle data could not be loaded.", cycleTotal: null });
    expect(hoisted.computeMarketSessionStatus).not.toHaveBeenCalled();
    expect(hoisted.subscribeToPooledQuote).not.toHaveBeenCalled();
  });

  it("blocks an unknown position id", async () => {
    expect((await evaluateCloseGateForPosition("nope")).blocked).toBe(true);
  });

  it("blocks when the wheel-cycle data is missing", async () => {
    seedPosition([stockLegRow], { cycleInput: null });
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain("wheel-cycle data could not be loaded");
  });

  it("treats a failing market-state lookup as a closed market: blocked with the hours message and no pool round trip", async () => {
    seedPosition([stockLegRow]);
    hoisted.computeMarketSessionStatus.mockRejectedValue(new Error("calendar unavailable"));
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict.blocked).toBe(true);
    expect(verdict.cycleTotal).toBeNull();
    expect(verdict.reason).toBe("Closing is only available during regular trading hours (9:30 AM – 4:00 PM ET). The market is closed right now.");
    expect(hoisted.subscribeToPooledQuote).not.toHaveBeenCalled();
  });

  it.each([
    ["pre-market", "in pre-market"],
    ["after-hours", "in after-hours trading"],
    ["closed", "closed"],
  ])("blocks without touching the quote pool while the market is %s", async (state, phrase) => {
    seedPosition([stockLegRow]);
    hoisted.computeMarketSessionStatus.mockResolvedValue({ state, label: "", nextChangeAt: "" });
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain(`The market is ${phrase} right now.`);
    expect(hoisted.subscribeToPooledQuote).not.toHaveBeenCalled();
  });

  it("blocks, and still releases the contracts it did subscribe, when a later subscription throws", async () => {
    seedPosition([stockLegRow, shortCallLegRow]);
    const firstUnsubscribe = vi.fn();
    hoisted.subscribeToPooledQuote.mockResolvedValueOnce(firstUnsubscribe).mockRejectedValueOnce(new Error("IBKR is not connected"));
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict).toEqual({ blocked: true, reason: "Closing is blocked: live quotes could not be read (IBKR is not connected).", cycleTotal: null });
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("blocks when the very first subscription throws a non-Error", async () => {
    seedPosition([stockLegRow]);
    hoisted.subscribeToPooledQuote.mockRejectedValue("pool offline");
    expect((await evaluateCloseGateForPosition("pos-1")).reason).toBe("Closing is blocked: live quotes could not be read (pool offline).");
  });

  it("blocks once the grace passes with no quote at all, naming the missing leg, and unsubscribes everything", async () => {
    vi.useFakeTimers();
    seedPosition([stockLegRow]);
    const unsubscribeByKey = deliverQuotesOnSubscribe({});
    const resultPromise = evaluateCloseGateForPosition("pos-1");
    await vi.advanceTimersByTimeAsync(settleGraceMs - 1);
    expect(unsubscribeByKey.get("stock")).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const verdict = await resultPromise;
    expect(verdict).toEqual({ blocked: true, reason: "Live bid/ask is unavailable for ABC stock. Closing needs live prices.", cycleTotal: null });
    expect(unsubscribeByKey.get("stock")).toHaveBeenCalledTimes(1);
  });

  it("still returns a verdict, and releases every other subscription, when one unsubscribe throws", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedPosition([stockLegRow, shortCallLegRow]);
    const unsubscribeByKey = deliverQuotesOnSubscribe({});
    const firstUnsubscribeThrows = hoisted.subscribeToPooledQuote.getMockImplementation()!;
    let subscriptions = 0;
    hoisted.subscribeToPooledQuote.mockImplementation(async (contract: PriceContract, onUpdate: (quote: PooledQuote) => void) => {
      const unsubscribe = await firstUnsubscribeThrows(contract, onUpdate);
      if (subscriptions++ === 0) {
        unsubscribeByKey.get(contract.key)!.mockImplementation(() => {
          throw new Error("pool is gone");
        });
      }
      return unsubscribe;
    });
    const resultPromise = evaluateCloseGateForPosition("pos-1");
    await vi.advanceTimersByTimeAsync(settleGraceMs);
    const verdict = await resultPromise;
    expect(verdict.blocked).toBe(true);
    expect([...unsubscribeByKey.values()].every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
    expect(console.error).toHaveBeenCalledWith("Close gate: could not release a quote subscription: pool is gone");
  });

  it("never reports 'waiting' as the final answer: quotes that stay incomplete past the grace are a real block naming every missing leg", async () => {
    vi.useFakeTimers();
    seedPosition([stockLegRow, shortCallLegRow, shortPutLegRow]);
    deliverQuotesOnSubscribe({ stock: pooledQuote({ bid: 59.9, ask: 60.1, last: 60 }) });
    const resultPromise = evaluateCloseGateForPosition("pos-1");
    await vi.advanceTimersByTimeAsync(settleGraceMs);
    const verdict = await resultPromise;
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe("Live bid/ask is unavailable for $152.5C 2026-10-16, $45P 2026-10-16. Closing needs live prices.");
  });

  it("blocks when a leg has only one side of the market", async () => {
    vi.useFakeTimers();
    seedPosition([stockLegRow]);
    deliverQuotesOnSubscribe({ stock: pooledQuote({ bid: 59.9, ask: null, last: 60 }) });
    const resultPromise = evaluateCloseGateForPosition("pos-1");
    await vi.advanceTimersByTimeAsync(settleGraceMs);
    expect((await resultPromise).reason).toBe("Live bid/ask is unavailable for ABC stock. Closing needs live prices.");
  });

  it("blocks on a stock whose only price is the daily-close fallback (last without bid/ask)", async () => {
    vi.useFakeTimers();
    seedPosition([stockLegRow]);
    deliverQuotesOnSubscribe({ stock: pooledQuote({ last: 55 }) });
    const resultPromise = evaluateCloseGateForPosition("pos-1");
    await vi.advanceTimersByTimeAsync(settleGraceMs);
    expect((await resultPromise).blocked).toBe(true);
  });

  it("blocks when the ticker's cycle has no open cycle even with live quotes", async () => {
    seedPosition([stockLegRow], { cycleInput: { ...stockCycleInput, stockLegs: [], stockTrades: [] } });
    deliverQuotesOnSubscribe({ stock: pooledQuote({ bid: 59.9, ask: 60.1, last: 60 }) });
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict.blocked).toBe(true);
    expect(verdict.cycleTotal).toBeNull();
    expect(verdict.reason).toBe("No open wheel cycle was found for ABC, so closing can't be verified. Closing is blocked.");
  });
});

describe("evaluateCloseGateForPosition allows a live close", () => {
  it("allows a stock position with a live two-sided quote and returns the live cycle P&L (100 shares, cost 50, last 60 = 1000)", async () => {
    seedPosition([stockLegRow]);
    const unsubscribeByKey = deliverQuotesOnSubscribe({ stock: pooledQuote({ bid: 59.9, ask: 60.1, last: 60 }) });
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict).toEqual({ blocked: false, reason: null, cycleTotal: 1000 });
    expect(unsubscribeByKey.get("stock")).toHaveBeenCalledTimes(1);
  });

  it("subscribes the stock and each option leg's own contract exactly once", async () => {
    seedPosition([stockLegRow, shortCallLegRow]);
    deliverQuotesOnSubscribe({ stock: pooledQuote({ bid: 59.9, ask: 60.1, last: 60 }), "leg-call": pooledQuote({ bid: 1, ask: 1.2, last: 1.1 }) });
    await evaluateCloseGateForPosition("pos-1");
    const subscribedKeys = hoisted.subscribeToPooledQuote.mock.calls.map((call) => (call[0] as PriceContract).key);
    expect(subscribedKeys).toEqual(["stock", "leg-call"]);
  });

  it("does not wait out the grace when every quote is already there", async () => {
    vi.useFakeTimers();
    seedPosition([stockLegRow]);
    deliverQuotesOnSubscribe({ stock: pooledQuote({ bid: 59.9, ask: 60.1, last: 60 }) });
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict.blocked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles as soon as the last missing quote arrives, before the grace", async () => {
    vi.useFakeTimers();
    seedPosition([stockLegRow]);
    let deliverStockQuote: (quote: PooledQuote) => void = () => {};
    const unsubscribe = vi.fn();
    hoisted.subscribeToPooledQuote.mockImplementation(async (_contract: PriceContract, onUpdate: (quote: PooledQuote) => void) => {
      deliverStockQuote = onUpdate;
      return unsubscribe;
    });
    const resultPromise = evaluateCloseGateForPosition("pos-1");
    await vi.advanceTimersByTimeAsync(1000);
    deliverStockQuote(pooledQuote({ bid: 59.9, ask: 60.1, last: 60 }));
    const verdict = await resultPromise;
    expect(verdict).toEqual({ blocked: false, reason: null, cycleTotal: 1000 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("marks the option at the bid/ask mid for a covered call: share P&L 1000 plus premium P&L (1.2 - 1.1) x 1 x 100 = 10", async () => {
    const coveredCallCycleInput: CycleInput = {
      ...stockCycleInput,
      optionLegs: [
        {
          id: "leg-call", positionId: "pos-1", side: "short", optionType: "call", strike: 152.5, quantity: 1, multiplier: 100, entryPrice: 1.2,
          entryAt: new Date("2026-09-01T15:00:00Z"), exitPrice: null, exitAt: null, closingCommission: 0, hasClosingTrade: false,
          expiryDate: "2026-10-16", expiryClose: null,
        },
      ],
    };
    seedPosition([stockLegRow, shortCallLegRow], { cycleInput: coveredCallCycleInput });
    deliverQuotesOnSubscribe({ stock: pooledQuote({ bid: 59.9, ask: 60.1, last: 60 }), "leg-call": pooledQuote({ bid: 1, ask: 1.2, last: 1.1 }) });
    const verdict = await evaluateCloseGateForPosition("pos-1");
    expect(verdict).toEqual({ blocked: false, reason: null, cycleTotal: 1010 });
  });
});
