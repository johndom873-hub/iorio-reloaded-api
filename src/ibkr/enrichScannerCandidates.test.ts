import { EventEmitter } from "node:events";
import { EventName, MarketDataType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const budgetMocks = vi.hoisted(() => ({
  reserveMarketDataLines: vi.fn(),
  releaseMarketDataLines: vi.fn(),
  describeMarketDataLineShortage: vi.fn(),
}));
vi.mock("./marketDataLineBudget.js", () => budgetMocks);

const { enrichCandidate } = await import("./enrichScannerCandidates.js");
import type { IbkrConnection } from "./connectIbkr.js";

const ticks = { bid: 1, ask: 2, last: 4, delayedBid: 66, delayedAsk: 67, delayedLast: 68, avgShareVolume: 21, impliedVolatility: 24, callOpenInterest: 27, putOpenInterest: 28, avgOptionVolume: 87 };

function createConnection() {
  const emitter = new EventEmitter();
  const ib = Object.assign(emitter, { reqMktData: vi.fn(), cancelMktData: vi.fn(), reqMarketDataType: vi.fn() });
  return { connection: { ib, disconnect: vi.fn() } as unknown as IbkrConnection, ib };
}

async function startEnrichment(timeoutMs?: number) {
  const { connection, ib } = createConnection();
  const result = enrichCandidate(connection, 9, "AAOI", timeoutMs);
  await vi.advanceTimersByTimeAsync(0);
  return { ib, result };
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

describe("enrichCandidate", () => {
  it("reserves one line under a per-symbol scanner holder with a ttl of the timeout plus 5 s", async () => {
    const { result } = await startEnrichment(15_000);
    const [holder, lines, ttlSeconds] = budgetMocks.reserveMarketDataLines.mock.calls[0]!;
    expect(holder).toMatch(/^snapshot:scanner:AAOI:[0-9a-f-]{36}$/);
    expect([lines, ttlSeconds]).toEqual([1, 20]);
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
  });

  it("throws the shortage description and requests nothing when the budget refuses the line", async () => {
    const refusal = { ok: false, availableLines: 0, priorityLinesHeld: 50 };
    budgetMocks.reserveMarketDataLines.mockResolvedValue(refusal);
    const { connection, ib } = createConnection();
    await expect(enrichCandidate(connection, 9, "AAOI")).rejects.toThrow("no lines available");
    expect(budgetMocks.describeMarketDataLineShortage).toHaveBeenCalledWith(refusal, "AAOI scanner enrichment", 1);
    expect(ib.reqMktData).not.toHaveBeenCalled();
    expect(ib.reqMarketDataType).not.toHaveBeenCalled();
  });

  it("asks for real-time data first and then opens a stream with generic ticks 100, 101, 106 and 165", async () => {
    const { ib, result } = await startEnrichment(1_000);
    expect(ib.reqMarketDataType).toHaveBeenCalledWith(MarketDataType.REALTIME);
    expect(ib.reqMarketDataType.mock.invocationCallOrder[0]!).toBeLessThan(ib.reqMktData.mock.invocationCallOrder[0]!);
    const [reqId, contract, genericTicks, snapshot, regulatorySnapshot] = ib.reqMktData.mock.calls[0]!;
    expect(reqId).toBe(9);
    expect(contract).toMatchObject({ symbol: "AAOI", secType: "STK", exchange: "SMART", currency: "USD" });
    expect([genericTicks, snapshot, regulatorySnapshot]).toEqual(["100,101,106,165", false, false]);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
  });

  it("maps every tracked tick onto its field and computes the bid-ask spread against the midpoint", async () => {
    const { ib, result } = await startEnrichment();
    ib.emit(EventName.tickPrice, 9, ticks.bid, 9.9);
    ib.emit(EventName.tickPrice, 9, ticks.ask, 10.1);
    ib.emit(EventName.tickPrice, 9, ticks.last, 10);
    ib.emit(EventName.tickGeneric, 9, ticks.avgShareVolume, 2_500_000);
    ib.emit(EventName.tickGeneric, 9, ticks.impliedVolatility, 0.61);
    ib.emit(EventName.tickGeneric, 9, ticks.avgOptionVolume, 4_000);
    ib.emit(EventName.tickSize, 9, ticks.callOpenInterest, 1_100);
    ib.emit(EventName.tickSize, 9, ticks.putOpenInterest, 900);
    await vi.advanceTimersByTimeAsync(500);
    const enrichment = await result;
    expect(enrichment).toMatchObject({ lastPrice: 10, avgShareVolume: 2_500_000, avgOptionVolume: 4_000, callOpenInterest: 1_100, putOpenInterest: 900, impliedVolatility: 0.61 });
    expect(enrichment.bidAskSpreadPct).toBeCloseTo(0.02, 10);
  });

  it("accepts the delayed bid, ask and last tick ids as well", async () => {
    const { ib, result } = await startEnrichment(1_000);
    ib.emit(EventName.tickPrice, 9, ticks.delayedBid, 19.8);
    ib.emit(EventName.tickPrice, 9, ticks.delayedAsk, 20.2);
    ib.emit(EventName.tickPrice, 9, ticks.delayedLast, 20);
    await vi.advanceTimersByTimeAsync(1_000);
    const enrichment = await result;
    expect(enrichment.lastPrice).toBe(20);
    expect(enrichment.bidAskSpreadPct).toBeCloseTo(0.4 / 20, 10);
  });

  it("settles 500 ms after every awaited field is in, and not earlier, without waiting for average option volume", async () => {
    const { ib, result } = await startEnrichment(15_000);
    ib.emit(EventName.tickPrice, 9, ticks.bid, 9.9);
    ib.emit(EventName.tickPrice, 9, ticks.ask, 10.1);
    ib.emit(EventName.tickPrice, 9, ticks.last, 10);
    ib.emit(EventName.tickGeneric, 9, ticks.avgShareVolume, 1);
    ib.emit(EventName.tickGeneric, 9, ticks.impliedVolatility, 0.5);
    ib.emit(EventName.tickSize, 9, ticks.callOpenInterest, 1);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    ib.emit(EventName.tickSize, 9, ticks.putOpenInterest, 1);
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect((await result).avgOptionVolume).toBeNull();
  });

  it("resolves with the partial result at the timeout and a null spread when bid or ask never arrived", async () => {
    const { ib, result } = await startEnrichment(3_000);
    ib.emit(EventName.tickPrice, 9, ticks.last, 10);
    ib.emit(EventName.tickPrice, 9, ticks.bid, 9.9);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toEqual({
      lastPrice: 10,
      avgShareVolume: null,
      avgOptionVolume: null,
      callOpenInterest: null,
      putOpenInterest: null,
      bidAskSpreadPct: null,
      impliedVolatility: null,
    });
  });

  it("resolves with all nulls when nothing arrives", async () => {
    const { result } = await startEnrichment(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const enrichment = await result;
    expect(Object.values(enrichment).every((value) => value === null)).toBe(true);
  });

  it("leaves the spread null when the ask is zero or the midpoint is not positive", async () => {
    const zeroAsk = await startEnrichment(500);
    zeroAsk.ib.emit(EventName.tickPrice, 9, ticks.bid, 5);
    zeroAsk.ib.emit(EventName.tickPrice, 9, ticks.ask, 0);
    await vi.advanceTimersByTimeAsync(500);
    expect((await zeroAsk.result).bidAskSpreadPct).toBeNull();

    const crossedToNonPositive = await startEnrichment(500);
    crossedToNonPositive.ib.emit(EventName.tickPrice, 9, ticks.bid, -1);
    crossedToNonPositive.ib.emit(EventName.tickPrice, 9, ticks.ask, 0.5);
    await vi.advanceTimersByTimeAsync(500);
    expect((await crossedToNonPositive.result).bidAskSpreadPct).toBeNull();
  });

  it("does not turn IBKR's -1 no-data bid into a bogus spread when the ask is quoted", async () => {
    const { ib, result } = await startEnrichment(500);
    ib.emit(EventName.tickPrice, 9, ticks.bid, -1);
    ib.emit(EventName.tickPrice, 9, ticks.ask, 10);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).bidAskSpreadPct).toBeNull();
  });

  it("ignores -1 no-data ticks on the ask and last price too, and a real price after a -1 still counts", async () => {
    const { ib, result } = await startEnrichment(500);
    ib.emit(EventName.tickPrice, 9, ticks.last, -1);
    ib.emit(EventName.tickPrice, 9, ticks.ask, -1);
    ib.emit(EventName.tickPrice, 9, ticks.bid, 9.9);
    ib.emit(EventName.tickPrice, 9, ticks.ask, 10.1);
    ib.emit(EventName.tickPrice, 9, ticks.last, 10);
    await vi.advanceTimersByTimeAsync(500);
    const enrichment = await result;
    expect(enrichment.lastPrice).toBe(10);
    expect(enrichment.bidAskSpreadPct).toBeCloseTo(0.2 / 10, 10);
  });

  it("leaves a last price that only ever arrived as -1 empty", async () => {
    const { ib, result } = await startEnrichment(500);
    ib.emit(EventName.tickPrice, 9, ticks.last, -1);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).lastPrice).toBeNull();
  });

  it("ignores ticks for other request ids, untracked fields and undefined values", async () => {
    const { ib, result } = await startEnrichment(500);
    ib.emit(EventName.tickPrice, 10, ticks.last, 99);
    ib.emit(EventName.tickPrice, 9, 99, 99);
    ib.emit(EventName.tickGeneric, 9, ticks.impliedVolatility, undefined);
    ib.emit(EventName.tickSize, 9, 8, 123);
    await vi.advanceTimersByTimeAsync(500);
    const enrichment = await result;
    expect(Object.values(enrichment).every((value) => value === null)).toBe(true);
  });

  it("cancels the stream, removes every listener and leaves no timer behind when it resolves", async () => {
    const { ib, result } = await startEnrichment(500);
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(ib.cancelMktData).toHaveBeenCalledWith(9);
    expect(ib.listenerCount(EventName.tickPrice)).toBe(0);
    expect(ib.listenerCount(EventName.tickSize)).toBe(0);
    expect(ib.listenerCount(EventName.tickGeneric)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the reservation under the same holder it reserved", async () => {
    const { result } = await startEnrichment(500);
    await vi.advanceTimersByTimeAsync(500);
    await result;
    expect(budgetMocks.releaseMarketDataLines).toHaveBeenCalledWith(budgetMocks.reserveMarketDataLines.mock.calls[0]![0]);
  });

  it("warns instead of failing when releasing the reservation fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    budgetMocks.releaseMarketDataLines.mockRejectedValue(new Error("db down"));
    const { result } = await startEnrichment(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("db down"));
  });
});
