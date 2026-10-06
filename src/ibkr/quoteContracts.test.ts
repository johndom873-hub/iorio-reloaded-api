import { OptionType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedOptionQuote } from "./captureOptionQuoteBatch.js";
import type { PooledQuote } from "./marketDataPool.js";

const mocks = vi.hoisted(() => ({
  pool: new Map<string, unknown>(),
  peekCalls: [] as unknown[],
  reserveResults: [] as { ok: boolean; availableLines: number; priorityLinesHeld: number; disabled?: boolean }[],
  reserveCalls: [] as { holder: string; lines: number; ttlSeconds: number }[],
  renewCalls: [] as { holder: string; ttlSeconds: number }[],
  renewError: null as Error | null,
  releaseCalls: [] as string[],
  releaseError: null as Error | null,
  windowOptions: null as null | { concurrency: number; timeoutMs: number; isSettled: (quote: unknown) => boolean },
  captureCalls: [] as { symbol: string; contracts: unknown[] }[],
  captureResult: [] as unknown[],
  captureError: null as Error | null,
  captureGate: null as Promise<void> | null,
  windowClosed: 0,
}));

vi.mock("./marketDataPool.js", () => ({
  peekPooledQuote: (contract: { key: string }) => {
    mocks.peekCalls.push(contract);
    return mocks.pool.get(contract.key) ?? null;
  },
}));
vi.mock("./marketDataLineBudget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./marketDataLineBudget.js")>()),
  reserveMarketDataLines: async (holder: string, lines: number, ttlSeconds: number) => {
    mocks.reserveCalls.push({ holder, lines, ttlSeconds });
    return mocks.reserveResults.shift() ?? { ok: true, availableLines: 90, priorityLinesHeld: 0 };
  },
  renewMarketDataLineReservation: async (holder: string, ttlSeconds: number) => {
    mocks.renewCalls.push({ holder, ttlSeconds });
    if (mocks.renewError) throw mocks.renewError;
  },
  releaseMarketDataLines: async (holder: string) => {
    mocks.releaseCalls.push(holder);
    if (mocks.releaseError) throw mocks.releaseError;
  },
}));
vi.mock("./captureOptionQuoteBatch.js", () => ({
  openCaptureQuoteWindow: (_ib: unknown, options: typeof mocks.windowOptions) => {
    mocks.windowOptions = options;
    return {
      capture: async (symbol: string, contracts: unknown[]) => {
        mocks.captureCalls.push({ symbol, contracts });
        if (mocks.captureGate) await mocks.captureGate;
        if (mocks.captureError) throw mocks.captureError;
        return mocks.captureResult;
      },
      close: () => void mocks.windowClosed++,
    };
  },
}));

import { hasPriceAndDelta, quoteContracts } from "./quoteContracts.js";

const ib = {} as never;
const pooledQuote = (overrides: Partial<PooledQuote> = {}): PooledQuote => ({
  last: 1.1, bid: 1.0, ask: 1.2, delta: 0.25, gamma: 0.02, vega: 0.1, theta: -0.05, impliedVolatility: 0.4, underlyingPrice: 100, open: null, high: null, low: null, previousClose: null, volume: null, ...overrides,
});
const capturedQuote = (overrides: Partial<CapturedOptionQuote> = {}): CapturedOptionQuote =>
  ({
    expiry: "20261016", strike: 105, right: "C", bid: 2, ask: 2.2, last: 2.1, bidSize: 5, askSize: 6, impliedVolatility: 0.45, delta: 0.3, gamma: 0.03, vega: 0.2, theta: -0.07, modelOptionPrice: 2.1, underlyingPrice: 100, openInterest: 10, volume: 20, receivedAnyTick: true, sawRealTimeTicks: true, sawDelayedTicks: false, errorCode: null, ...overrides,
  }) as CapturedOptionQuote;

beforeEach(() => {
  mocks.pool.clear();
  mocks.peekCalls.length = 0;
  mocks.reserveResults.length = 0;
  mocks.reserveCalls.length = 0;
  mocks.renewCalls.length = 0;
  mocks.releaseCalls.length = 0;
  mocks.renewError = null;
  mocks.releaseError = null;
  mocks.windowOptions = null;
  mocks.captureCalls.length = 0;
  mocks.captureResult = [];
  mocks.captureError = null;
  mocks.captureGate = null;
  mocks.windowClosed = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("hasPriceAndDelta", () => {
  const quote = (bid: number | null, ask: number | null, last: number | null, delta: number | null) => ({ bid, ask, last, delta });

  it("is true with a two-sided price and a delta", () => {
    expect(hasPriceAndDelta(quote(1, 1.2, null, 0.3))).toBe(true);
  });

  it("is true with only a last price and a delta", () => {
    expect(hasPriceAndDelta(quote(null, null, 1.1, 0.3))).toBe(true);
  });

  it("is false with a one-sided quote and no last price", () => {
    expect(hasPriceAndDelta(quote(1, null, null, 0.3))).toBe(false);
    expect(hasPriceAndDelta(quote(null, 1.2, null, 0.3))).toBe(false);
  });

  it("is false without a delta, even with every price", () => {
    expect(hasPriceAndDelta(quote(1, 1.2, 1.1, null))).toBe(false);
  });

  it("treats a zero price and a zero delta as present values", () => {
    expect(hasPriceAndDelta(quote(0, 0, null, 0))).toBe(true);
    expect(hasPriceAndDelta(quote(null, null, 0, 0))).toBe(true);
  });
});

describe("quoteContracts", () => {
  const call = (strike: number, expiry = "20261016") => ({ expiry, strike, right: OptionType.Call });

  it("returns nothing for no contracts and touches neither the pool nor the budget", async () => {
    expect(await quoteContracts(ib, "AAPL", [])).toEqual([]);
    expect(mocks.peekCalls).toEqual([]);
    expect(mocks.reserveCalls).toEqual([]);
  });

  describe("pool first", () => {
    it("answers fully pooled contracts without a reservation or a capture window, mapping the pooled fields", async () => {
      mocks.pool.set("20261016|105|C", pooledQuote());
      const quotes = await quoteContracts(ib, "AAPL", [call(105)]);
      expect(quotes).toEqual([
        { expiry: "20261016", strike: 105, right: OptionType.Call, bid: 1.0, ask: 1.2, last: 1.1, impliedVolatility: 0.4, delta: 0.25, gamma: 0.02, vega: 0.1, theta: -0.05 },
      ]);
      expect(mocks.reserveCalls).toEqual([]);
      expect(mocks.windowOptions).toBeNull();
    });

    it("looks contracts up in the pool by expiry|strike|right as an option on the symbol", async () => {
      await quoteContracts(ib, "AAPL", [{ expiry: "20261023", strike: 97.5, right: OptionType.Put }]).catch(() => undefined);
      expect(mocks.peekCalls[0]).toEqual({ key: "20261023|97.5|P", legType: "option", symbol: "AAPL", expiry: "20261023", strike: 97.5, right: OptionType.Put });
    });

    it("sends a pooled contract that has no delta yet to the capture window instead", async () => {
      mocks.pool.set("20261016|105|C", pooledQuote({ delta: null }));
      mocks.captureResult = [capturedQuote()];
      await quoteContracts(ib, "AAPL", [call(105)]);
      expect(mocks.captureCalls).toHaveLength(1);
    });

    it("sends a pooled contract that has no price yet to the capture window", async () => {
      mocks.pool.set("20261016|105|C", pooledQuote({ bid: null, ask: null, last: null }));
      mocks.captureResult = [capturedQuote()];
      await quoteContracts(ib, "AAPL", [call(105)]);
      expect(mocks.captureCalls).toHaveLength(1);
    });

    it("captures only the contracts missing from the pool and returns pooled quotes first", async () => {
      mocks.pool.set("20261016|100|C", pooledQuote({ delta: 0.5 }));
      mocks.captureResult = [capturedQuote({ strike: 105 })];
      const quotes = await quoteContracts(ib, "AAPL", [call(105), call(100)]);
      expect(mocks.captureCalls).toEqual([{ symbol: "AAPL", contracts: [{ expiry: "20261016", strike: 105, right: "C" }] }]);
      expect(quotes.map((quote) => [quote.strike, quote.delta])).toEqual([[100, 0.5], [105, 0.3]]);
    });
  });

  describe("capture mapping", () => {
    it("maps a captured call and put to the OptionType enum and copies the greeks", async () => {
      mocks.captureResult = [capturedQuote({ right: "C" }), capturedQuote({ right: "P", strike: 95, bid: null, ask: null, last: 1.5, delta: -0.3 })];
      const quotes = await quoteContracts(ib, "AAPL", [call(105), { expiry: "20261016", strike: 95, right: OptionType.Put }]);
      expect(mocks.captureCalls[0]!.contracts).toEqual([
        { expiry: "20261016", strike: 105, right: "C" },
        { expiry: "20261016", strike: 95, right: "P" },
      ]);
      expect(quotes).toEqual([
        { expiry: "20261016", strike: 105, right: OptionType.Call, bid: 2, ask: 2.2, last: 2.1, impliedVolatility: 0.45, delta: 0.3, gamma: 0.03, vega: 0.2, theta: -0.07 },
        { expiry: "20261016", strike: 95, right: OptionType.Put, bid: null, ask: null, last: 1.5, impliedVolatility: 0.45, delta: -0.3, gamma: 0.03, vega: 0.2, theta: -0.07 },
      ]);
    });

    it("keeps captured contracts that never priced (they are returned, the caller filters)", async () => {
      mocks.captureResult = [capturedQuote({ bid: null, ask: null, last: null, delta: null })];
      const quotes = await quoteContracts(ib, "AAPL", [call(105)]);
      expect(quotes).toHaveLength(1);
      expect(quotes[0]).toMatchObject({ bid: null, delta: null });
    });

    it("logs how many contracts were quoted, how many came with price and delta and how many from the pool", async () => {
      mocks.pool.set("20261016|100|C", pooledQuote());
      mocks.captureResult = [capturedQuote(), capturedQuote({ strike: 110, delta: null })];
      await quoteContracts(ib, "AAPL", [call(100), call(105), call(110)]);
      expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^AAPL: 2 contracts quoted in \d+ms over 2 lines \(1 with price\+delta, 1 from the pool\)$/));
    });
  });

  describe("line reservation", () => {
    it("reserves one line per contract for 30 seconds under a holder naming the symbol", async () => {
      mocks.captureResult = [capturedQuote()];
      await quoteContracts(ib, "AAPL", [call(100), call(105), call(110)]);
      expect(mocks.reserveCalls).toHaveLength(1);
      expect(mocks.reserveCalls[0]).toMatchObject({ lines: 3, ttlSeconds: 30 });
      expect(mocks.reserveCalls[0]!.holder).toMatch(/^optionQuote:AAPL:[0-9a-f-]{36}$/);
      expect(mocks.windowOptions).toMatchObject({ concurrency: 3, timeoutMs: 8_000 });
    });

    it("never asks for more than 40 lines in one batch", async () => {
      await quoteContracts(ib, "AAPL", Array.from({ length: 55 }, (_, index) => call(100 + index)));
      expect(mocks.reserveCalls[0]!.lines).toBe(40);
      expect(mocks.windowOptions!.concurrency).toBe(40);
      expect(mocks.captureCalls[0]!.contracts).toHaveLength(55);
    });

    it("takes what is free when the full window is refused, under the same holder, and runs the window that narrow", async () => {
      mocks.reserveResults.push({ ok: false, availableLines: 12, priorityLinesHeld: 50 }, { ok: true, availableLines: 12, priorityLinesHeld: 50 });
      await quoteContracts(ib, "AAPL", Array.from({ length: 30 }, (_, index) => call(100 + index)));
      expect(mocks.reserveCalls.map((reservation) => reservation.lines)).toEqual([30, 12]);
      expect(mocks.reserveCalls[1]!.holder).toBe(mocks.reserveCalls[0]!.holder);
      expect(mocks.windowOptions!.concurrency).toBe(12);
    });

    it("fails with the shortage message when nothing is free, and opens no window", async () => {
      mocks.reserveResults.push({ ok: false, availableLines: 0, priorityLinesHeld: 50 });
      await expect(quoteContracts(ib, "AAPL", [call(100)])).rejects.toThrow(
        "IBKR market data is restricted while a scheduled scan runs (the 10:00 ET chain capture; 50 lines reserved for it) — AAPL needs 1 lines, 0 available. Try again after.",
      );
      expect(mocks.windowOptions).toBeNull();
      expect(mocks.releaseCalls).toEqual([]);
    });

    it("fails with the shortage message when the second, narrower reservation is refused too", async () => {
      mocks.reserveResults.push({ ok: false, availableLines: 5, priorityLinesHeld: 0 }, { ok: false, availableLines: 3, priorityLinesHeld: 0 });
      await expect(quoteContracts(ib, "AAPL", Array.from({ length: 10 }, (_, index) => call(100 + index)))).rejects.toThrow("only 3 available");
    });

    it("reports a disabled-lines environment", async () => {
      mocks.reserveResults.push({ ok: false, availableLines: 0, priorityLinesHeld: 0, disabled: true });
      await expect(quoteContracts(ib, "AAPL", [call(100)])).rejects.toThrow("IBKR market-data lines are disabled in this environment");
    });

    it("releases the reservation and closes the window after a successful capture", async () => {
      await quoteContracts(ib, "AAPL", [call(100)]);
      expect(mocks.windowClosed).toBe(1);
      expect(mocks.releaseCalls).toEqual([mocks.reserveCalls[0]!.holder]);
    });

    it("releases the reservation and closes the window when the capture fails, rethrowing the failure", async () => {
      mocks.captureError = new Error("socket closed");
      await expect(quoteContracts(ib, "AAPL", [call(100)])).rejects.toThrow("socket closed");
      expect(mocks.windowClosed).toBe(1);
      expect(mocks.releaseCalls).toEqual([mocks.reserveCalls[0]!.holder]);
    });

    it("does not fail the call when releasing the reservation fails; it only warns", async () => {
      mocks.releaseError = new Error("db down");
      await expect(quoteContracts(ib, "AAPL", [call(100)])).resolves.toEqual([]);
      await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to release IBKR market data line reservation optionQuote:AAPL:")));
    });
  });

  describe("renewal while the capture runs", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function holdCaptureOpen(): () => void {
      let open: () => void = () => undefined;
      mocks.captureGate = new Promise<void>((resolve) => (open = resolve));
      return open;
    }

    it("renews the reservation every 10 seconds with the same TTL and stops when the capture ends", async () => {
      const openGate = holdCaptureOpen();
      const result = quoteContracts(ib, "AAPL", [call(100)]);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(mocks.renewCalls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.renewCalls).toEqual([{ holder: mocks.reserveCalls[0]!.holder, ttlSeconds: 30 }]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.renewCalls).toHaveLength(2);
      openGate();
      await result;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.renewCalls).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("warns, without failing the capture, when a renewal fails", async () => {
      mocks.renewError = new Error("db down");
      const openGate = holdCaptureOpen();
      const result = quoteContracts(ib, "AAPL", [call(100)]);
      await vi.advanceTimersByTimeAsync(10_000);
      openGate();
      await expect(result).resolves.toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^Failed to renew IBKR market data line reservation optionQuote:AAPL:.*: db down$/));
    });

    it("stops renewing when the capture fails", async () => {
      mocks.captureError = new Error("socket closed");
      const openGate = holdCaptureOpen();
      const result = quoteContracts(ib, "AAPL", [call(100)]).catch((error: Error) => error);
      openGate();
      await result;
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("settle rule handed to the capture window", () => {
    it("settles a contract on an error code or on price plus delta, and not on a bare tick", async () => {
      await quoteContracts(ib, "AAPL", [call(100)]);
      const isSettled = mocks.windowOptions!.isSettled;
      expect(isSettled({ errorCode: 200, bid: null, ask: null, last: null, delta: null })).toBe(true);
      expect(isSettled({ errorCode: null, bid: 1, ask: 1.2, last: null, delta: 0.3 })).toBe(true);
      expect(isSettled({ errorCode: null, bid: 1, ask: 1.2, last: null, delta: null })).toBe(false);
      expect(isSettled({ errorCode: null, bid: null, ask: null, last: null, delta: null })).toBe(false);
    });
  });
});
