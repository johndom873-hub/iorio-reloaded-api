import { EventEmitter } from "node:events";
import { EventName, MarketDataType, OptionType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserveResult: { ok: true, availableLines: 90, priorityLinesHeld: 0 } as { ok: boolean; availableLines: number; priorityLinesHeld: number; disabled?: boolean },
  reservations: [] as { holder: string; lines: number; ttlSeconds: number }[],
  releases: [] as string[],
  releaseError: null as Error | null,
  borrow: vi.fn(),
  allocateReqId: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("./marketDataLineBudget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./marketDataLineBudget.js")>()),
  reserveMarketDataLines: async (holder: string, lines: number, ttlSeconds: number) => {
    mocks.reservations.push({ holder, lines, ttlSeconds });
    return mocks.reserveResult;
  },
  releaseMarketDataLines: async (holder: string) => {
    mocks.releases.push(holder);
    if (mocks.releaseError) throw mocks.releaseError;
  },
}));
vi.mock("./sharedReadConnection.js", () => ({ sharedReadConnection: { borrow: mocks.borrow, allocateReqId: mocks.allocateReqId } }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: mocks.connect }));

import { fetchLiveGreeks, type GreeksContract } from "./fetchLiveGreeks.js";

class FakeIbApi extends EventEmitter {
  reqMarketDataType = vi.fn();
  reqMktData = vi.fn();
  cancelMktData = vi.fn();
}

const contract = (key: string, strike = 200, right: OptionType = OptionType.Call): GreeksContract => ({ key, symbol: "AAPL", expiry: "20261016", strike, right });

let ib: FakeIbApi;
let nextReqId: number;

/** Emits a model-computation tick: (reqId, tickType, tickAttrib, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, underlyingPrice). */
const computation = (reqId: number, tickType: number, fields: { iv?: number; delta?: number; gamma?: number; vega?: number; theta?: number; underlying?: number }) =>
  ib.emit(EventName.tickOptionComputation, reqId, tickType, 0, fields.iv, fields.delta, undefined, undefined, fields.gamma, fields.vega, fields.theta, fields.underlying);

beforeEach(() => {
  vi.useFakeTimers();
  ib = new FakeIbApi();
  nextReqId = 100;
  Object.assign(mocks, { reserveResult: { ok: true, availableLines: 90, priorityLinesHeld: 0 }, releaseError: null });
  mocks.reservations.length = 0;
  mocks.releases.length = 0;
  for (const mock of [mocks.release, mocks.disconnect, mocks.connect, mocks.borrow, mocks.allocateReqId]) mock.mockReset();
  mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
  mocks.allocateReqId.mockImplementation(() => nextReqId++);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const start = async (contracts: GreeksContract[], source?: "realtime" | "lastClose") => {
  const result = fetchLiveGreeks(contracts, source);
  await vi.advanceTimersByTimeAsync(0);
  return result;
};

describe("fetchLiveGreeks", () => {
  it("returns an empty map for no contracts without reserving lines", async () => {
    expect(await fetchLiveGreeks([])).toEqual({});
    expect(mocks.reservations).toEqual([]);
  });

  it("reserves one line per contract for 15 s, subscribes to a snapshot of each option and releases the line", async () => {
    const result = start([contract("a", 200, OptionType.Call), contract("b", 195, OptionType.Put)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reservations[0]).toMatchObject({ lines: 2, ttlSeconds: 15 });
    expect(mocks.reservations[0]!.holder).toMatch(/^snapshot:greeks:[0-9a-f-]{36}$/);
    expect(ib.reqMktData).toHaveBeenCalledTimes(2);
    expect(ib.reqMktData.mock.calls[0]![0]).toBe(100);
    expect(ib.reqMktData.mock.calls[0]![1]).toMatchObject({ symbol: "AAPL", secType: "OPT", lastTradeDateOrContractMonth: "20261016", strike: 200, right: OptionType.Call, exchange: "SMART" });
    expect(ib.reqMktData.mock.calls[1]![1]).toMatchObject({ strike: 195, right: OptionType.Put });
    expect(ib.reqMktData.mock.calls[0]!.slice(2)).toEqual(["", true, false]);
    ib.emit(EventName.tickSnapshotEnd, 100);
    ib.emit(EventName.tickSnapshotEnd, 101);
    await result;
    expect(mocks.releases).toEqual([mocks.reservations[0]!.holder]);
  });

  it("fails with the shortage message when the lines are not available", async () => {
    mocks.reserveResult = { ok: false, availableLines: 0, priorityLinesHeld: 0, disabled: true };
    await expect(fetchLiveGreeks([contract("a")])).rejects.toThrow("IBKR market-data lines are disabled in this environment (IBKR_MARKET_DATA_LINES_ENABLED=false) — a 1-contract greeks snapshot needs 1 lines.");
    expect(mocks.borrow).not.toHaveBeenCalled();
  });

  it("requests real-time data for the realtime source and FROZEN data for lastClose", async () => {
    let result = start([contract("a")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqMarketDataType).toHaveBeenLastCalledWith(MarketDataType.REALTIME);
    ib.emit(EventName.tickSnapshotEnd, 100);
    await result;

    result = start([contract("a")], "lastClose");
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqMarketDataType).toHaveBeenLastCalledWith(MarketDataType.FROZEN);
    ib.emit(EventName.tickSnapshotEnd, 101);
    await result;
  });

  describe("model computation ticks", () => {
    it("collects delta, gamma, vega, theta, implied volatility and underlying price from a real-time model tick (13)", async () => {
      const result = start([contract("a")]);
      await vi.advanceTimersByTimeAsync(0);
      computation(100, 13, { iv: 0.42, delta: 0.31, gamma: 0.02, vega: 0.11, theta: -0.05, underlying: 198.5 });
      expect(await result).toEqual({ a: { delta: 0.31, gamma: 0.02, vega: 0.11, theta: -0.05, impliedVolatility: 0.42, underlyingPrice: 198.5 } });
    });

    it("accepts the delayed model tick (83) too", async () => {
      const result = start([contract("a")]);
      await vi.advanceTimersByTimeAsync(0);
      computation(100, 83, { delta: -0.4 });
      expect(await result).toMatchObject({ a: { delta: -0.4 } });
    });

    it("ignores the bid (10), ask (11) and last (12) computation ticks and their delayed twins", async () => {
      const result = start([contract("a")]);
      await vi.advanceTimersByTimeAsync(0);
      for (const tickType of [10, 11, 12, 80, 81, 82]) computation(100, tickType, { delta: 0.99 });
      ib.emit(EventName.tickSnapshotEnd, 100);
      expect(await result).toEqual({ a: { delta: null, gamma: null, vega: null, theta: null } });
    });

    it("merges a partial tick into the previous reading instead of wiping known fields", async () => {
      const result = start([contract("a"), contract("b")]);
      await vi.advanceTimersByTimeAsync(0);
      computation(100, 13, { iv: 0.4, delta: 0.3, gamma: 0.02, vega: 0.1, theta: -0.05, underlying: 200 });
      computation(100, 13, { theta: -0.06 });
      ib.emit(EventName.tickSnapshotEnd, 101);
      expect(await result).toEqual({
        a: { delta: 0.3, gamma: 0.02, vega: 0.1, theta: -0.06, impliedVolatility: 0.4, underlyingPrice: 200 },
        b: { delta: null, gamma: null, vega: null, theta: null },
      });
    });

    it("keeps a delta of exactly 0 (a real value) and does not treat it as missing", async () => {
      const result = start([contract("a")]);
      await vi.advanceTimersByTimeAsync(0);
      computation(100, 13, { delta: 0.3 });
      computation(100, 13, { delta: 0 });
      expect(await result).toMatchObject({ a: { delta: 0 } });
    });

    it("gives the implied volatility and underlying price null when the first tick lacks them", async () => {
      const result = start([contract("a")]);
      await vi.advanceTimersByTimeAsync(0);
      computation(100, 13, { delta: 0.3 });
      expect(await result).toEqual({ a: { delta: 0.3, gamma: null, vega: null, theta: null, impliedVolatility: null, underlyingPrice: null } });
    });

    it("ignores ticks for unknown request ids", async () => {
      const result = start([contract("a")]);
      await vi.advanceTimersByTimeAsync(0);
      computation(999, 13, { delta: 0.9 });
      ib.emit(EventName.tickSnapshotEnd, 100);
      expect(await result).toEqual({ a: { delta: null, gamma: null, vega: null, theta: null } });
    });
  });

  describe("completion", () => {
    it("waits until every contract has greeks or a snapshot end", async () => {
      const result = start([contract("a"), contract("b")]);
      await vi.advanceTimersByTimeAsync(0);
      computation(100, 13, { delta: 0.3 });
      let settled = false;
      void result.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      ib.emit(EventName.tickSnapshotEnd, 101);
      expect(await result).toMatchObject({ a: { delta: 0.3 }, b: { delta: null } });
    });

    it("returns what arrived after the 6 s ceiling", async () => {
      const result = start([contract("a"), contract("b")]);
      await vi.advanceTimersByTimeAsync(0);
      computation(100, 13, { delta: 0.3 });
      await vi.advanceTimersByTimeAsync(5_999);
      let settled = false;
      void result.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ a: { delta: 0.3 }, b: { delta: null } });
    });

    it("cancels every subscription and removes its listeners afterwards", async () => {
      const result = start([contract("a"), contract("b")]);
      await vi.advanceTimersByTimeAsync(0);
      ib.emit(EventName.tickSnapshotEnd, 100);
      ib.emit(EventName.tickSnapshotEnd, 101);
      await result;
      expect(ib.cancelMktData.mock.calls.map((call) => call[0])).toEqual([100, 101]);
      for (const eventName of [EventName.tickOptionComputation, EventName.tickSnapshotEnd, EventName.error]) expect(ib.listenerCount(eventName)).toBe(0);
    });
  });

  describe("errors", () => {
    it("logs a real error for its contract with the contract spelled out, and nothing for delayed-data notices or other requests", async () => {
      const result = start([contract("a", 200, OptionType.Call)]);
      await vi.advanceTimersByTimeAsync(0);
      ib.emit(EventName.error, new Error("delayed"), 10089, 100);
      ib.emit(EventName.error, new Error("other"), 200, 999);
      expect(console.error).not.toHaveBeenCalled();
      ib.emit(EventName.error, new Error("No market data permissions"), 354, 100);
      expect(console.error).toHaveBeenCalledWith("Live greeks error for AAPL 20261016 200C (code 354): No market data permissions");
      ib.emit(EventName.tickSnapshotEnd, 100);
      await result;
    });
  });

  describe("connections", () => {
    it("releases the shared connection after the snapshot", async () => {
      const result = start([contract("a")]);
      await vi.advanceTimersByTimeAsync(0);
      ib.emit(EventName.tickSnapshotEnd, 100);
      await result;
      expect(mocks.release).toHaveBeenCalledTimes(1);
      expect(mocks.connect).not.toHaveBeenCalled();
    });

    it("falls back to a one-shot connection numbering requests from 20000 and disconnects", async () => {
      mocks.borrow.mockRejectedValue(new Error("not connected"));
      mocks.connect.mockResolvedValue({ ib, disconnect: mocks.disconnect });
      const result = start([contract("a"), contract("b")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(ib.reqMktData.mock.calls.map((call) => call[0])).toEqual([20_000, 20_001]);
      ib.emit(EventName.tickSnapshotEnd, 20_000);
      ib.emit(EventName.tickSnapshotEnd, 20_001);
      await result;
      expect(mocks.disconnect).toHaveBeenCalledTimes(1);
      expect(console.log).toHaveBeenCalledWith("fetchLiveGreeks: shared read connection unavailable (not connected), falling back to a one-shot connection.");
    });

    it("releases the reserved lines even when the connection fails", async () => {
      mocks.borrow.mockRejectedValue(new Error("not connected"));
      mocks.connect.mockRejectedValue(new Error("tunnel down"));
      const captured = fetchLiveGreeks([contract("a")]).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(((await captured) as Error).message).toBe("tunnel down");
      expect(mocks.releases).toHaveLength(1);
    });

    it("does not fail when releasing the lines fails; it only warns", async () => {
      mocks.releaseError = new Error("db down");
      const result = start([contract("a")]);
      await vi.advanceTimersByTimeAsync(0);
      ib.emit(EventName.tickSnapshotEnd, 100);
      await expect(result).resolves.toBeDefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to release IBKR market data line reservation snapshot:greeks:"));
    });
  });
});
