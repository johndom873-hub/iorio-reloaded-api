import { EventEmitter } from "node:events";
import { EventName, Instrument, LocationCode, ScanCode, type ContractDetails } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScannerSubscription } from "./fetchScannerCandidates.js";
import type { IbkrConnection } from "./connectIbkr.js";

function createConnection() {
  const emitter = new EventEmitter();
  const ib = Object.assign(emitter, { reqScannerSubscription: vi.fn(), cancelScannerSubscription: vi.fn() });
  return { connection: { ib, disconnect: vi.fn() } as unknown as IbkrConnection, ib };
}

function scannerRow(symbol: string | undefined, conId?: number): ContractDetails {
  return { contract: { symbol, conId } } as ContractDetails;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runScannerSubscription", () => {
  it("requests a US stock and ETF scan with the market-cap floor sent as the raw millions filter tag", () => {
    const { connection, ib } = createConnection();
    void runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    expect(ib.reqScannerSubscription).toHaveBeenCalledWith(
      31,
      { numberOfRows: 50, instrument: Instrument.STK, locationCode: LocationCode.STK_US, scanCode: ScanCode.TOP_PERC_GAIN, stockTypeFilter: "CORP,ETF" },
      [],
      [{ tag: "marketCapAbove1e6", value: "1000" }],
    );
  });

  it("honours custom row count, market cap and price floor, and converts the market cap to millions", () => {
    const { connection, ib } = createConnection();
    void runScannerSubscription(connection, ScanCode.MOST_ACTIVE, 31, { numberOfRows: 25, marketCapAboveUsd: 2_500_000_000, abovePriceUsd: 5 });
    const [, subscription, , filters] = ib.reqScannerSubscription.mock.calls[0]!;
    expect(subscription).toMatchObject({ numberOfRows: 25, abovePrice: 5 });
    expect(filters).toEqual([{ tag: "marketCapAbove1e6", value: "2500" }]);
  });

  it("omits the price floor when none is given", () => {
    const { connection, ib } = createConnection();
    void runScannerSubscription(connection, ScanCode.MOST_ACTIVE, 31);
    expect(ib.reqScannerSubscription.mock.calls[0]![1]).not.toHaveProperty("abovePrice");
  });

  it("collects the rows of its own request in order with symbol, conId, rank and scan code, then resolves on the end marker", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.scannerData, 31, 0, scannerRow("AAOI", 111));
    ib.emit(EventName.scannerData, 31, 1, scannerRow("MU", 222));
    ib.emit(EventName.scannerDataEnd, 31);
    await expect(result).resolves.toEqual([
      { symbol: "AAOI", conId: 111, rank: 0, scanCode: ScanCode.TOP_PERC_GAIN },
      { symbol: "MU", conId: 222, rank: 1, scanCode: ScanCode.TOP_PERC_GAIN },
    ]);
  });

  it("ignores rows for other request ids and rows without a symbol, and nulls a missing conId", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.scannerData, 99, 0, scannerRow("OTHER", 1));
    ib.emit(EventName.scannerData, 31, 0, scannerRow(undefined, 5));
    ib.emit(EventName.scannerData, 31, 1, scannerRow("NOID"));
    ib.emit(EventName.scannerDataEnd, 31);
    await expect(result).resolves.toEqual([{ symbol: "NOID", conId: null, rank: 1, scanCode: ScanCode.TOP_PERC_GAIN }]);
  });

  it("is not ended by another request's end marker arriving before its own", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.scannerDataEnd, 99);
    ib.emit(EventName.scannerData, 31, 0, scannerRow("AAOI", 111));
    ib.emit(EventName.scannerDataEnd, 31);
    let resolved = false;
    void result.then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolved).toBe(true);
  });

  it("cancels the subscription and removes every listener when it finishes", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.scannerDataEnd, 31);
    await result;
    expect(ib.cancelScannerSubscription).toHaveBeenCalledWith(31);
    expect(ib.listenerCount(EventName.scannerData)).toBe(0);
    expect(ib.listenerCount(EventName.scannerDataEnd)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves with the partial rows when its own request errors, instead of failing the job", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.scannerData, 31, 0, scannerRow("AAOI", 111));
    ib.emit(EventName.error, new Error("No scanner subscription results"), 162, 31);
    await expect(result).resolves.toEqual([{ symbol: "AAOI", conId: 111, rank: 0, scanCode: ScanCode.TOP_PERC_GAIN }]);
    expect(ib.cancelScannerSubscription).toHaveBeenCalledWith(31);
  });

  it("is not ended by an error that belongs to another request", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.error, new Error("unrelated"), 200, 5);
    expect(ib.cancelScannerSubscription).not.toHaveBeenCalled();
    ib.emit(EventName.scannerDataEnd, 31);
    await result;
  });

  it("resolves with whatever arrived after 20 s when the scan never ends, and not earlier", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.scannerData, 31, 0, scannerRow("AAOI", 111));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(ib.cancelScannerSubscription).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toHaveLength(1);
    expect(ib.cancelScannerSubscription).toHaveBeenCalledTimes(1);
  });

  it("resolves with an empty list when nothing came back", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.scannerDataEnd, 31);
    await expect(result).resolves.toEqual([]);
  });

  it("settles once: rows and a second end marker after finishing change nothing", async () => {
    const { connection, ib } = createConnection();
    const result = runScannerSubscription(connection, ScanCode.TOP_PERC_GAIN, 31);
    ib.emit(EventName.scannerDataEnd, 31);
    ib.emit(EventName.scannerData, 31, 0, scannerRow("LATE", 9));
    ib.emit(EventName.scannerDataEnd, 31);
    await expect(result).resolves.toEqual([]);
    expect(ib.cancelScannerSubscription).toHaveBeenCalledTimes(1);
  });
});
