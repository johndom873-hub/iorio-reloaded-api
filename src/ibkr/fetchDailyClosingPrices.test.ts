import { EventEmitter } from "node:events";
import { BarSizeSetting, EventName, WhatToShow, type Contract } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeIbApi extends EventEmitter {
  historicalRequests: { reqId: number; contract: Contract; args: unknown[] }[] = [];
  reqHistoricalData = vi.fn((reqId: number, contract: Contract, ...args: unknown[]) => {
    this.historicalRequests.push({ reqId, contract, args });
    this.onHistoricalRequest?.(reqId, contract);
  });
  reqAccountUpdates = vi.fn((subscribe: boolean, _account: string) => {
    if (subscribe) this.onAccountSubscribe?.();
  });
  onHistoricalRequest: ((reqId: number, contract: Contract) => void) | null = null;
  onAccountSubscribe: (() => void) | null = null;
}

const connection = vi.hoisted(() => ({ ib: null as unknown, disconnect: null as unknown as () => void }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: vi.fn(async () => ({ ib: connection.ib, disconnect: connection.disconnect })) }));
const recordedPrices = vi.hoisted(() => [] as unknown[]);
vi.mock("../lib/priceService.js", () => ({ recordStockPrices: vi.fn(async (entries: unknown) => void recordedPrices.push(entries)) }));

import { fetchDailyClosingPrices } from "./fetchDailyClosingPrices.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import type { PriceContract } from "./fetchLivePrices.js";

let ib: FakeIbApi;
const sessionDate = "2026-10-06";

function emitBars(reqId: number, bars: [string, number][]): void {
  for (const [date, close] of bars) ib.emit(EventName.historicalData, reqId, date, close - 1, close + 1, close - 2, close, 1000, 10, close, false);
  ib.emit(EventName.historicalData, reqId, "finished-20261004  20261006", -1, -1, -1, -1, -1, -1, -1, false);
}

function optionRow(overrides: Partial<Contract> = {}, position = 1, marketPrice = 1.25, account = "U21518308"): void {
  const contract: Contract = { secType: "OPT" as Contract["secType"], symbol: "AAPL", lastTradeDateOrContractMonth: "20261016", strike: 200, right: "C" as Contract["right"], ...overrides };
  ib.emit(EventName.updatePortfolio, contract, position, marketPrice, position * marketPrice * 100, 1, 0, 0, account);
}

const stock = (key: string, symbol: string): PriceContract => ({ key, legType: "stock", symbol });
const option = (key: string, overrides: Partial<PriceContract> = {}): PriceContract => ({ key, legType: "option", symbol: "AAPL", expiry: "20261016", strike: 200, right: "C" as PriceContract["right"], ...overrides });

beforeEach(() => {
  ib = new FakeIbApi();
  connection.ib = ib;
  connection.disconnect = vi.fn();
  recordedPrices.length = 0;
  vi.mocked(connectToIbkrGateway).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("fetchDailyClosingPrices without work", () => {
  it("returns an empty map and never connects for no contracts", async () => {
    expect(await fetchDailyClosingPrices([], sessionDate)).toEqual({});
    expect(connectToIbkrGateway).not.toHaveBeenCalled();
  });
});

describe("fetchDailyClosingPrices stocks", () => {
  it("uses the close of the last bar when its date equals the session date", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261005", 100], ["20261006", 101.5]]);
    expect(await fetchDailyClosingPrices([stock("AAPL-stock", "AAPL")], sessionDate)).toEqual({ "AAPL-stock": 101.5 });
  });

  it("requests a 2-day daily TRADES bar with after-hours included, as a SMART/USD stock, from reqId 7000", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261006", 101.5]]);
    await fetchDailyClosingPrices([stock("a", "AAPL"), stock("m", "MSFT")], sessionDate);
    expect(ib.historicalRequests.map((request) => request.reqId)).toEqual([7000, 7001]);
    expect(ib.historicalRequests[0]!.contract).toMatchObject({ symbol: "AAPL", secType: "STK", exchange: "SMART", currency: "USD" });
    expect(ib.historicalRequests[1]!.contract).toMatchObject({ symbol: "MSFT" });
    // endDateTime "", duration "2 D", bar size 1 day, TRADES, useRTH 0, formatDate 2, no keep-up-to-date.
    expect(ib.historicalRequests[0]!.args).toEqual(["", "2 D", BarSizeSetting.DAYS_ONE, WhatToShow.TRADES, 0, 2, false]);
  });

  it("never returns a stale bar as the session's price: null, with the dates in the log", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261002", 99], ["20261005", 100]]);
    expect(await fetchDailyClosingPrices([stock("a", "AAPL")], sessionDate)).toEqual({ a: null });
    expect(console.error).toHaveBeenCalledWith("fetchDailyClosingPrices: latest daily bar for AAPL is 20261005, expected 20261006 — not using it.");
    expect(recordedPrices).toEqual([[]]);
  });

  it("takes only the LAST bar's date into account: an older matching bar followed by a newer mismatching one is null", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261006", 101], ["20261007", 102]]);
    expect(await fetchDailyClosingPrices([stock("a", "AAPL")], sessionDate)).toEqual({ a: null });
  });

  it("is null when IBKR sends no bars at all", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, []);
    expect(await fetchDailyClosingPrices([stock("a", "AAPL")], sessionDate)).toEqual({ a: null });
  });

  it("completes a request on an error for it (such as code 162) and logs it, leaving only that symbol null", async () => {
    ib.onHistoricalRequest = (reqId, contract) => {
      if (contract.symbol === "BAD") ib.emit(EventName.error, new Error("HMDS query returned no data"), 162, reqId);
      else emitBars(reqId, [["20261006", 55]]);
    };
    expect(await fetchDailyClosingPrices([stock("b", "BAD"), stock("g", "GOOD")], sessionDate)).toEqual({ b: null, g: 55 });
    expect(console.error).toHaveBeenCalledWith("fetchDailyClosingPrices: no daily bar for BAD (code 162): HMDS query returned no data");
  });

  it("ignores errors and bars for request ids that are not its own", async () => {
    ib.onHistoricalRequest = (reqId) => {
      ib.emit(EventName.error, new Error("unrelated"), 200, 123);
      ib.emit(EventName.historicalData, 5, "20261006", 1, 1, 1, 999, 1, 1, 1, false);
      emitBars(reqId, [["20261006", 101]]);
    };
    expect(await fetchDailyClosingPrices([stock("a", "AAPL")], sessionDate)).toEqual({ a: 101 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("requests each symbol once and prices every leg of it", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261006", 101]]);
    expect(await fetchDailyClosingPrices([stock("first", "AAPL"), stock("second", "AAPL")], sessionDate)).toEqual({ first: 101, second: 101 });
    expect(ib.reqHistoricalData).toHaveBeenCalledTimes(1);
  });

  it("waits for every symbol's bars before returning", async () => {
    const pendingReqIds: number[] = [];
    ib.onHistoricalRequest = (reqId) => pendingReqIds.push(reqId);
    let settled = false;
    const result = fetchDailyClosingPrices([stock("a", "AAPL"), stock("m", "MSFT")], sessionDate).then((value) => ((settled = true), value));
    await vi.waitFor(() => expect(pendingReqIds).toHaveLength(2));
    emitBars(pendingReqIds[0]!, [["20261006", 101]]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    emitBars(pendingReqIds[1]!, [["20261006", 410]]);
    expect(await result).toEqual({ a: 101, m: 410 });
  });

  it("records the session closes as the shared last-known prices, skipping symbols without a usable bar", async () => {
    ib.onHistoricalRequest = (reqId, contract) => (contract.symbol === "STALE" ? emitBars(reqId, [["20261001", 1]]) : emitBars(reqId, [["20261006", 101]]));
    await fetchDailyClosingPrices([stock("a", "AAPL"), stock("s", "STALE")], sessionDate);
    expect(recordedPrices).toEqual([[{ symbol: "AAPL", price: 101, source: "daily_close" }]]);
  });

  it("does not subscribe to account updates when there are only stocks", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261006", 101]]);
    await fetchDailyClosingPrices([stock("a", "AAPL")], sessionDate);
    expect(ib.reqAccountUpdates).not.toHaveBeenCalled();
  });
});

describe("fetchDailyClosingPrices option marks", () => {
  beforeEach(() => {
    ib.onAccountSubscribe = () => undefined;
  });

  const run = async (contracts: PriceContract[], rows: () => void) => {
    ib.onAccountSubscribe = () => {
      rows();
      ib.emit(EventName.accountDownloadEnd, "U21518308");
    };
    return fetchDailyClosingPrices(contracts, sessionDate);
  };

  it("uses the portfolio mark of a held contract and makes no historical request for options alone", async () => {
    expect(await run([option("opt")], () => optionRow({}, -1, 1.25))).toEqual({ opt: 1.25 });
    expect(ib.reqHistoricalData).not.toHaveBeenCalled();
    expect(ib.reqAccountUpdates).toHaveBeenCalledWith(true, "");
  });

  it("uses the mark of a short (negative) position too", async () => {
    expect(await run([option("opt")], () => optionRow({}, -3, 2.5))).toEqual({ opt: 2.5 });
  });

  it("returns null for a contract the account no longer holds (position 0 keeps a stale mark)", async () => {
    expect(await run([option("opt")], () => optionRow({}, 0, 9.99))).toEqual({ opt: null });
  });

  it("skips a stale zero-position row and takes the held one for the same contract", async () => {
    expect(
      await run([option("opt")], () => {
        optionRow({}, 0, 9.99);
        optionRow({}, 1, 0.8);
      }),
    ).toEqual({ opt: 0.8 });
  });

  it("returns null for a missing contract and for a non-positive mark", async () => {
    expect(await run([option("missing"), option("zero", { strike: 205 })], () => optionRow({ strike: 205 }, 1, 0))).toEqual({ missing: null, zero: null });
    expect(await run([option("negative")], () => optionRow({}, 1, -1))).toEqual({ negative: null });
  });

  it("matches on symbol, expiry, strike and right, all four", async () => {
    const rows = () => {
      optionRow({ symbol: "MSFT" }, 1, 1);
      optionRow({ lastTradeDateOrContractMonth: "20261023" }, 1, 2);
      optionRow({ strike: 202.5 }, 1, 3);
      optionRow({ right: "P" as Contract["right"] }, 1, 4);
      optionRow({ secType: "STK" as Contract["secType"] }, 1, 5);
      optionRow({}, 1, 6);
    };
    expect(await run([option("opt")], rows)).toEqual({ opt: 6 });
  });

  it("compares the right by its first letter, case-insensitively (C, CALL, call)", async () => {
    expect(await run([option("opt", { right: "C" as PriceContract["right"] })], () => optionRow({ right: "CALL" as Contract["right"] }, 1, 7))).toEqual({ opt: 7 });
    expect(await run([option("opt", { right: "P" as PriceContract["right"] })], () => optionRow({ right: "put" as Contract["right"] }, 1, 8))).toEqual({ opt: 8 });
  });

  it("does not match a contract without a right against a call row", async () => {
    expect(await run([option("opt", { right: undefined })], () => optionRow({ right: "C" as Contract["right"] }, 1, 7))).toEqual({ opt: null });
  });

  it("does not match an option contract that has no expiry or no strike", async () => {
    expect(await run([option("noExpiry", { expiry: undefined }), option("noStrike", { strike: undefined })], () => optionRow({}, 1, 6))).toEqual({ noExpiry: null, noStrike: null });
  });

  it("prices several options from one subscription, each against its own row", async () => {
    const rows = () => {
      optionRow({ strike: 200 }, -1, 1.1);
      optionRow({ strike: 210 }, -2, 2.2);
    };
    expect(await run([option("a", { strike: 200 }), option("b", { strike: 210 }), option("c", { strike: 220 })], rows)).toEqual({ a: 1.1, b: 2.2, c: null });
    expect(ib.reqAccountUpdates).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes from account updates using the account name the rows carried", async () => {
    await run([option("opt")], () => optionRow({}, 1, 1, "U21518308"));
    expect(ib.reqAccountUpdates).toHaveBeenLastCalledWith(false, "U21518308");
  });

  it("does not unsubscribe when no row ever named the account", async () => {
    await run([option("opt")], () => undefined);
    expect(ib.reqAccountUpdates).toHaveBeenCalledTimes(1);
  });

  it("prices stocks and options together, waiting for both completion signals", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261006", 101]]);
    expect(await run([stock("s", "AAPL"), option("o")], () => optionRow({}, 1, 3.3))).toEqual({ s: 101, o: 3.3 });
  });

  it("keeps waiting for the account download after the bars are in", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261006", 101]]);
    ib.onAccountSubscribe = () => undefined;
    let settled = false;
    const result = fetchDailyClosingPrices([stock("s", "AAPL"), option("o")], sessionDate).then((value) => ((settled = true), value));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    optionRow({}, 1, 3.3);
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toEqual({ s: 101, o: 3.3 });
  });
});

describe("fetchDailyClosingPrices connection lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("disconnects after a successful run and removes its listeners", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261006", 101]]);
    await fetchDailyClosingPrices([stock("a", "AAPL")], sessionDate);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(ib.listenerCount(EventName.historicalData)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
    expect(ib.listenerCount(EventName.updatePortfolio)).toBe(0);
    expect(ib.listenerCount(EventName.accountDownloadEnd)).toBe(0);
  });

  it("fails the whole fetch when IBKR is silent for 30 s, and still disconnects and unsubscribes", async () => {
    ib.onAccountSubscribe = () => optionRow({}, 1, 1);
    const captured = fetchDailyClosingPrices([stock("s", "AAPL"), option("o")], sessionDate).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(connection.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(((await captured) as Error).message).toBe("IBKR did not answer within 30000ms.");
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(ib.reqAccountUpdates).toHaveBeenLastCalledWith(false, "U21518308");
    expect(ib.listenerCount(EventName.historicalData)).toBe(0);
    expect(ib.listenerCount(EventName.accountDownloadEnd)).toBe(0);
  });

  it("does not leave the silence timer running after a successful run", async () => {
    ib.onHistoricalRequest = (reqId) => emitBars(reqId, [["20261006", 101]]);
    await fetchDailyClosingPrices([stock("a", "AAPL")], sessionDate);
    expect(vi.getTimerCount()).toBe(0);
  });
});
