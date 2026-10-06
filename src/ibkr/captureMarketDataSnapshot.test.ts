import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const budgetMocks = vi.hoisted(() => ({
  reserveMarketDataLines: vi.fn(),
  releaseMarketDataLines: vi.fn(),
  describeMarketDataLineShortage: vi.fn(),
}));
vi.mock("./marketDataLineBudget.js", () => budgetMocks);

const { captureMarketDataSnapshot } = await import("./captureMarketDataSnapshot.js");
import type { IbkrConnection } from "./connectIbkr.js";

const impliedVolatilityTick = 24;
const averageOptionVolumeTick = 87;

function createConnection() {
  const emitter = new EventEmitter();
  const ib = Object.assign(emitter, { reqMktData: vi.fn(), cancelMktData: vi.fn() });
  return { connection: { ib, disconnect: vi.fn() } as unknown as IbkrConnection, ib };
}

beforeEach(() => {
  vi.useFakeTimers();
  budgetMocks.reserveMarketDataLines.mockReset().mockResolvedValue({ ok: true, availableLines: 80, priorityLinesHeld: 0 });
  budgetMocks.releaseMarketDataLines.mockReset().mockResolvedValue(undefined);
  budgetMocks.describeMarketDataLineShortage.mockReset().mockReturnValue("no lines available");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("captureMarketDataSnapshot", () => {
  it("reserves one line under a per-symbol holder with a ttl of the timeout plus 5 s", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI");
    await vi.advanceTimersByTimeAsync(0);
    const [holder, lines, ttlSeconds] = budgetMocks.reserveMarketDataLines.mock.calls[0]!;
    expect(holder).toMatch(/^snapshot:marketData:AAOI:[0-9a-f-]{36}$/);
    expect([lines, ttlSeconds]).toEqual([1, 20]);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, 0.5);
    ib.emit(EventName.tickSize, 7, averageOptionVolumeTick, 1_000);
    await result;
  });

  it("rounds the reservation ttl up for a timeout that is not a whole number of seconds", async () => {
    const { connection } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI", 2_500);
    await vi.advanceTimersByTimeAsync(2_500);
    await result;
    expect(budgetMocks.reserveMarketDataLines.mock.calls[0]![2]).toBe(8);
  });

  it("throws the shortage description and requests no data when the budget refuses the line", async () => {
    const refusal = { ok: false, availableLines: 0, priorityLinesHeld: 50 };
    budgetMocks.reserveMarketDataLines.mockResolvedValue(refusal);
    const { connection, ib } = createConnection();
    await expect(captureMarketDataSnapshot(connection, 7, "AAOI")).rejects.toThrow("no lines available");
    expect(budgetMocks.describeMarketDataLineShortage).toHaveBeenCalledWith(refusal, "AAOI market data", 1);
    expect(ib.reqMktData).not.toHaveBeenCalled();
    expect(budgetMocks.releaseMarketDataLines).not.toHaveBeenCalled();
  });

  it("subscribes with generic ticks 105 and 106 as a stream, not a snapshot", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    const [reqId, contract, genericTicks, snapshot, regulatorySnapshot] = ib.reqMktData.mock.calls[0]!;
    expect(reqId).toBe(7);
    expect(contract).toMatchObject({ symbol: "AAOI", secType: "STK", exchange: "SMART", currency: "USD" });
    expect([genericTicks, snapshot, regulatorySnapshot]).toEqual(["105,106", false, false]);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
  });

  it("resolves as soon as both values arrived and cancels the stream and removes its listeners", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, 0.55);
    ib.emit(EventName.tickSize, 7, averageOptionVolumeTick, 4_200);
    await expect(result).resolves.toEqual({ impliedVolatility: 0.55, avgOptionVolume: 4_200 });
    expect(ib.cancelMktData).toHaveBeenCalledWith(7);
    expect(ib.listenerCount(EventName.tickGeneric)).toBe(0);
    expect(ib.listenerCount(EventName.tickSize)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives volume only a 500 ms grace once implied volatility is in", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, 0.55);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ impliedVolatility: 0.55, avgOptionVolume: null });
    expect(ib.cancelMktData).toHaveBeenCalledWith(7);
  });

  it("still picks up volume that arrives inside the grace window", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, 0.55);
    await vi.advanceTimersByTimeAsync(300);
    ib.emit(EventName.tickSize, 7, averageOptionVolumeTick, 900);
    await expect(result).resolves.toEqual({ impliedVolatility: 0.55, avgOptionVolume: 900 });
  });

  it("does not start the grace for volume alone, and waits out the full timeout, resolving with what arrived", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI", 4_000);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickSize, 7, averageOptionVolumeTick, 900);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(ib.cancelMktData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ impliedVolatility: null, avgOptionVolume: 900 });
  });

  it("resolves with nulls at the timeout when nothing arrives", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI", 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(result).resolves.toEqual({ impliedVolatility: null, avgOptionVolume: null });
    expect(ib.cancelMktData).toHaveBeenCalledWith(7);
  });

  it("ignores ticks for other request ids, other fields and undefined values", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI", 1_000);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickGeneric, 8, impliedVolatilityTick, 0.9);
    ib.emit(EventName.tickGeneric, 7, 23, 0.9);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, undefined);
    ib.emit(EventName.tickSize, 7, averageOptionVolumeTick, undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({ impliedVolatility: null, avgOptionVolume: null });
  });

  it("keeps the first resolved snapshot when ticks keep arriving after it settled", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, 0.55);
    ib.emit(EventName.tickSize, 7, averageOptionVolumeTick, 4_200);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, 0.99);
    await expect(result).resolves.toEqual({ impliedVolatility: 0.55, avgOptionVolume: 4_200 });
  });

  it("releases the reservation after completing", async () => {
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, 0.5);
    ib.emit(EventName.tickSize, 7, averageOptionVolumeTick, 1);
    await result;
    const reservedHolder = budgetMocks.reserveMarketDataLines.mock.calls[0]![0];
    expect(budgetMocks.releaseMarketDataLines).toHaveBeenCalledWith(reservedHolder);
  });

  it("warns instead of failing the capture when releasing the reservation fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    budgetMocks.releaseMarketDataLines.mockRejectedValue(new Error("db down"));
    const { connection, ib } = createConnection();
    const result = captureMarketDataSnapshot(connection, 7, "AAOI");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.tickGeneric, 7, impliedVolatilityTick, 0.5);
    ib.emit(EventName.tickSize, 7, averageOptionVolumeTick, 1);
    await expect(result).resolves.toEqual({ impliedVolatility: 0.5, avgOptionVolume: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Failed to release IBKR market data line reservation snapshot:marketData:AAOI:"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("db down"));
  });

  it("uses a distinct reservation holder for every capture of the same symbol", async () => {
    const first = createConnection();
    const second = createConnection();
    const firstResult = captureMarketDataSnapshot(first.connection, 1, "AAOI", 1_000);
    const secondResult = captureMarketDataSnapshot(second.connection, 2, "AAOI", 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([firstResult, secondResult]);
    const holders = budgetMocks.reserveMarketDataLines.mock.calls.map((call) => call[0]);
    expect(new Set(holders).size).toBe(2);
  });
});
