import { EventEmitter } from "node:events";
import { EventName, OptionType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceContract } from "./fetchLivePrices.js";

// Audit D (2026-10-07): the reconcile/subscribe race fix (planned entries). Same module fakes as marketDataPool.test.ts, plus a
// running "lines booked" figure so every reqMktData can be checked against what the budget actually granted.

interface FakeIb extends EventEmitter {
  reqMktData: ReturnType<typeof vi.fn>;
  cancelMktData: ReturnType<typeof vi.fn>;
}

const harness = vi.hoisted(() => ({
  currentIb: null as unknown,
  borrowFails: false,
  nextReqId: 1000,
  availableLines: 90,
  reserveDelayMs: 0,
  reserveFailsWith: null as Error | null,
  bookedLines: 0,
  reserveCalls: [] as number[],
}));

vi.mock("./sharedReadConnection.js", () => ({
  sharedLiveConnection: {
    borrow: async () => {
      if (harness.borrowFails) throw new Error("connection unavailable");
      return { ib: harness.currentIb };
    },
    allocateReqId: () => harness.nextReqId++,
  },
}));
vi.mock("./marketDataLineBudget.js", () => ({
  reserveMarketDataLines: async (_holder: string, lines: number) => {
    harness.reserveCalls.push(lines);
    if (harness.reserveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, harness.reserveDelayMs));
    if (harness.reserveFailsWith) throw harness.reserveFailsWith;
    if (lines <= harness.availableLines) {
      harness.bookedLines = lines;
      return { ok: true, availableLines: harness.availableLines, priorityLinesHeld: 0 };
    }
    return { ok: false, availableLines: harness.availableLines, priorityLinesHeld: 50 };
  },
  releaseMarketDataLines: async () => {
    harness.bookedLines = 0;
  },
}));
vi.mock("../lib/priceService.js", () => ({ loadFallbackStockPrices: async () => new Map() }));
vi.mock("../lib/notificationBroadcaster.js", () => ({ broadcastToLocalSubscribers: () => {} }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));

/** Open lines on the fake connection, and the worst excess over the booked count seen at any reqMktData. */
const lines = { open: new Set<number>(), worstExcess: 0 };

function createFakeIb(): FakeIb {
  const ib = Object.assign(new EventEmitter(), {
    reqMktData: vi.fn((reqId: number) => {
      lines.open.add(reqId);
      lines.worstExcess = Math.max(lines.worstExcess, lines.open.size - harness.bookedLines);
    }),
    cancelMktData: vi.fn((reqId: number) => {
      lines.open.delete(reqId);
    }),
  });
  ib.on(EventName.disconnected, () => lines.open.clear());
  return ib;
}

async function loadPool() {
  vi.resetModules();
  return import("./marketDataPool.js");
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await vi.advanceTimersByTimeAsync(0);
}

const option = (strike: number): PriceContract => ({ key: `ALPHA-${strike}`, legType: "option", symbol: "ALPHA", expiry: "20261120", strike, right: OptionType.Call });
const stock = (symbol: string): PriceContract => ({ key: symbol, legType: "stock", symbol });
const subscribedSymbols = (ib: FakeIb) => ib.reqMktData.mock.calls.map((call) => `${(call[1] as { symbol: string }).symbol}:${(call[1] as { strike?: number }).strike ?? "STK"}`);

let ib: FakeIb;

beforeEach(() => {
  vi.useFakeTimers();
  lines.open.clear();
  lines.worstExcess = 0;
  ib = createFakeIb();
  harness.currentIb = ib;
  harness.borrowFails = false;
  harness.nextReqId = 1000;
  harness.availableLines = 90;
  harness.reserveDelayMs = 0;
  harness.reserveFailsWith = null;
  harness.bookedLines = 0;
  harness.reserveCalls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("marketDataPool planned entries — audit D", () => {
  it("a contract added mid-reconcile whose follow-up reservation fails stays unsubscribed until a later reconcile books it", async () => {
    const pool = await loadPool();
    harness.reserveDelayMs = 50;
    await pool.subscribeToPooledQuote(stock("ALPHA"), () => {});
    await vi.advanceTimersByTimeAsync(10);
    await pool.subscribeToPooledQuote(stock("BRAVO"), () => {}); // arrives while the first reconcile awaits
    await vi.advanceTimersByTimeAsync(45); // first reconcile done: ALPHA booked and subscribed, BRAVO's reconcile starts
    harness.reserveFailsWith = new Error("database unavailable");
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(subscribedSymbols(ib)).toEqual(["ALPHA:STK"]);
    expect(lines.worstExcess).toBe(0);

    harness.reserveFailsWith = null;
    await vi.advanceTimersByTimeAsync(15_000 + 100); // the periodic reconcile
    await settle();
    expect(subscribedSymbols(ib)).toEqual(["ALPHA:STK", "BRAVO:STK"]);
    expect(lines.worstExcess).toBe(0);
  });

  it("the reconnect retry does not subscribe a contract that no reconcile has booked yet", async () => {
    const pool = await loadPool();
    await pool.subscribeToPooledQuote(stock("ALPHA"), () => {});
    await settle();
    expect(subscribedSymbols(ib)).toEqual(["ALPHA:STK"]);

    const secondIb = createFakeIb();
    harness.currentIb = secondIb;
    ib.emit(EventName.disconnected); // retry in 1 s
    harness.reserveDelayMs = 3_000;
    await pool.subscribeToPooledQuote(stock("BRAVO"), () => {}); // reconcile now awaiting a 3 s reservation
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    // The retry restored ALPHA (booked earlier); BRAVO waits for its reservation.
    expect(subscribedSymbols(secondIb)).toEqual(["ALPHA:STK"]);
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(subscribedSymbols(secondIb)).toEqual(["ALPHA:STK", "BRAVO:STK"]);
  });

  it("with a tight budget, a burst never opens more lines than booked and sheds the newest option, not an older one", async () => {
    const pool = await loadPool();
    harness.availableLines = 2;
    harness.reserveDelayMs = 20;
    const contracts = [stock("ALPHA"), option(50), option(55), option(60)];
    for (const contract of contracts) {
      await pool.subscribeToPooledQuote(contract, () => {});
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(lines.worstExcess).toBe(0);
    expect(lines.open.size).toBe(2);
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 4, pausedCount: 2, openLineCount: 2, restricted: true });
    // Never subscribed then cancelled: shed contracts were never opened at all.
    expect(ib.cancelMktData).not.toHaveBeenCalled();
    expect(subscribedSymbols(ib)).toEqual(["ALPHA:STK", "ALPHA:50"]);
  });

  it("a contract dropped and re-added under the same key while a reconcile is in flight ends up with exactly one line", async () => {
    const pool = await loadPool();
    const unsubscribe = await pool.subscribeToPooledQuote(stock("ALPHA"), () => {});
    await settle();
    harness.reserveDelayMs = 3_000;
    unsubscribe();
    await vi.advanceTimersByTimeAsync(2_000); // grace over: entry deleted, its line cancelled, a reconcile (0 entries) runs
    await settle();
    await pool.subscribeToPooledQuote(stock("ALPHA"), () => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(lines.open.size).toBe(1);
    expect(pool.marketDataPoolSnapshot()).toMatchObject({ contractCount: 1, openLineCount: 1, pausedCount: 0 });
    expect(lines.worstExcess).toBe(0);
  });

  it("a long burst with slow reservations: every contract ends subscribed once, with the last reservation sized for all", async () => {
    const pool = await loadPool();
    harness.reserveDelayMs = 30;
    const contracts = Array.from({ length: 12 }, (_, index) => option(40 + index));
    for (const contract of contracts) {
      await pool.subscribeToPooledQuote(contract, () => {});
      await vi.advanceTimersByTimeAsync(7);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(ib.reqMktData).toHaveBeenCalledTimes(12);
    expect(new Set(subscribedSymbols(ib)).size).toBe(12);
    expect(ib.cancelMktData).not.toHaveBeenCalled();
    expect(harness.reserveCalls.at(-1)).toBe(12);
    expect(lines.worstExcess).toBe(0);
  });
});
