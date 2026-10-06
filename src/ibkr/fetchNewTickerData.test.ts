import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tickerRow: undefined as Record<string, unknown> | undefined,
  tickerQueries: [] as unknown[],
  tickerUpdates: [] as { where: unknown; update: unknown }[],
  borrowOrConnect: vi.fn(),
  disconnect: vi.fn(),
  realtimeRequests: [] as unknown[],
  captureSnapshot: vi.fn(),
  nextRequestId: 700,
}));
vi.mock("../db/connection.js", () => ({
  db: (table: string) => {
    expect(table).toBe("tickers");
    return {
      where: (condition: unknown) => {
        mocks.tickerQueries.push(condition);
        return {
          first: async () => mocks.tickerRow,
          update: async (update: unknown) => void mocks.tickerUpdates.push({ where: condition, update }),
        };
      },
    };
  },
}));
vi.mock("./sharedReadConnection.js", () => ({
  borrowSharedConnectionOrConnect: mocks.borrowOrConnect,
  nextReqIdFor: (_ib: unknown, fallback: () => number) => (mocks.nextRequestId > 0 ? mocks.nextRequestId++ : fallback()),
  sharedReadConnection: { label: "shared-read" },
}));
vi.mock("./requestMarketData.js", () => ({ requestRealtimeMarketData: (ib: unknown) => void mocks.realtimeRequests.push(ib) }));
vi.mock("./captureMarketDataSnapshot.js", () => ({ captureMarketDataSnapshot: mocks.captureSnapshot }));

import { fetchNewTickerData, getCachedContractDetails, lookupContractDetails } from "./fetchNewTickerData.js";

class FakeIbApi extends EventEmitter {
  reqContractDetails = vi.fn();
}
const asConnection = (ib: FakeIbApi) => ({ ib, disconnect: vi.fn() }) as unknown as Parameters<typeof lookupContractDetails>[0];

beforeEach(() => {
  vi.useFakeTimers();
  mocks.tickerRow = undefined;
  mocks.tickerQueries.length = 0;
  mocks.tickerUpdates.length = 0;
  mocks.realtimeRequests.length = 0;
  mocks.nextRequestId = 700;
  for (const mock of [mocks.borrowOrConnect, mocks.disconnect, mocks.captureSnapshot]) mock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("lookupContractDetails", () => {
  const detailsEvent = (ib: FakeIbApi, reqId: number, details: Record<string, unknown>) => ib.emit(EventName.contractDetails, reqId, details);

  it("resolves with the company, sector, contract id and primary exchange from the first details", async () => {
    const ib = new FakeIbApi();
    const result = lookupContractDetails(asConnection(ib), 5);
    detailsEvent(ib, 5, { longName: "APPLE INC", industry: "Computers", contract: { conId: 265598, primaryExch: "NASDAQ" } });
    expect(await result).toEqual({ companyName: "APPLE INC", sector: "Computers", conId: 265598, primaryExchange: "NASDAQ" });
  });

  it("uses nulls for blank names and a missing contract id or exchange", async () => {
    const ib = new FakeIbApi();
    const result = lookupContractDetails(asConnection(ib), 5);
    detailsEvent(ib, 5, { longName: "", contract: { primaryExch: "" } });
    expect(await result).toEqual({ companyName: null, sector: null, conId: null, primaryExchange: null });
  });

  describe("sector resolution", () => {
    const sectorFor = async (details: Record<string, unknown>) => {
      const ib = new FakeIbApi();
      const result = lookupContractDetails(asConnection(ib), 5);
      detailsEvent(ib, 5, { longName: "X", contract: { conId: 1 }, ...details });
      return (await result).sector;
    };

    it("prefers the industry", async () => {
      expect(await sectorFor({ industry: "Semiconductors", category: "Chips", stockType: "COMMON" })).toBe("Semiconductors");
    });

    it("falls back to the category (what IBKR gives funds) when the industry is blank", async () => {
      expect(await sectorFor({ industry: "", category: "InvestmentSvc", stockType: "ETF" })).toBe("InvestmentSvc");
    });

    it("falls back to the literal ETF for an ETF with neither", async () => {
      expect(await sectorFor({ industry: "", category: "", stockType: "ETF" })).toBe("ETF");
    });

    it("is null for a common stock with neither industry nor category", async () => {
      expect(await sectorFor({ stockType: "COMMON" })).toBeNull();
      expect(await sectorFor({})).toBeNull();
    });
  });

  it("settles once: a second details event for the request changes nothing", async () => {
    const ib = new FakeIbApi();
    const result = lookupContractDetails(asConnection(ib), 5);
    detailsEvent(ib, 5, { longName: "FIRST", contract: { conId: 1 } });
    detailsEvent(ib, 5, { longName: "SECOND", contract: { conId: 2 } });
    expect((await result).companyName).toBe("FIRST");
  });

  it("ignores details, ends and errors for other requests", async () => {
    const ib = new FakeIbApi();
    const result = lookupContractDetails(asConnection(ib), 5);
    detailsEvent(ib, 6, { longName: "OTHER", contract: { conId: 9 } });
    ib.emit(EventName.contractDetailsEnd, 6);
    ib.emit(EventName.error, new Error("other"), 200, 6);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    detailsEvent(ib, 5, { longName: "MINE", contract: { conId: 1 } });
    expect((await result).companyName).toBe("MINE");
  });

  it("resolves empty on the end of the list with no details, and on an error for the request", async () => {
    const empty = { companyName: null, sector: null, conId: null, primaryExchange: null };
    let ib = new FakeIbApi();
    let result = lookupContractDetails(asConnection(ib), 5);
    ib.emit(EventName.contractDetailsEnd, 5);
    expect(await result).toEqual(empty);

    ib = new FakeIbApi();
    result = lookupContractDetails(asConnection(ib), 5);
    ib.emit(EventName.error, new Error("No security definition has been found"), 200, 5);
    expect(await result).toEqual(empty);
  });

  it("resolves empty after 10 s of silence and removes its listeners", async () => {
    const ib = new FakeIbApi();
    const result = lookupContractDetails(asConnection(ib), 5);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ib.listenerCount(EventName.contractDetails)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ companyName: null, sector: null, conId: null, primaryExchange: null });
    for (const eventName of [EventName.contractDetails, EventName.contractDetailsEnd, EventName.error]) expect(ib.listenerCount(eventName)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses request id 1 by default", async () => {
    const ib = new FakeIbApi();
    const result = lookupContractDetails(asConnection(ib));
    detailsEvent(ib, 1, { longName: "X", contract: { conId: 3 } });
    expect((await result).conId).toBe(3);
  });
});

describe("getCachedContractDetails", () => {
  it("answers from the stored ticker row without asking IBKR", async () => {
    mocks.tickerRow = { symbol: "AAPL", ibkr_contract_id: 265598, company_name: "APPLE INC", sector: "Computers", primary_exchange: "NASDAQ" };
    const ib = new FakeIbApi();
    expect(await getCachedContractDetails(asConnection(ib), "AAPL")).toEqual({ companyName: "APPLE INC", sector: "Computers", conId: 265598, primaryExchange: "NASDAQ" });
    expect(ib.reqContractDetails).not.toHaveBeenCalled();
    expect(mocks.tickerQueries).toEqual([{ symbol: "AAPL" }]);
  });

  it("maps blank stored names to null on a cache hit", async () => {
    mocks.tickerRow = { ibkr_contract_id: 1, company_name: "", sector: null, primary_exchange: "" };
    expect(await getCachedContractDetails(asConnection(new FakeIbApi()), "AAPL")).toEqual({ companyName: null, sector: null, conId: 1, primaryExchange: null });
  });

  it("misses the cache when the stored contract id is null, asks IBKR for the stock and stores the result", async () => {
    mocks.tickerRow = { symbol: "AAPL", ibkr_contract_id: null };
    const ib = new FakeIbApi();
    const result = getCachedContractDetails(asConnection(ib), "AAPL", 9);
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqContractDetails).toHaveBeenCalledWith(9, expect.objectContaining({ symbol: "AAPL", secType: "STK", exchange: "SMART", currency: "USD" }));
    ib.emit(EventName.contractDetails, 9, { longName: "APPLE INC", industry: "Computers", contract: { conId: 265598, primaryExch: "NASDAQ" } });
    expect(await result).toEqual({ companyName: "APPLE INC", sector: "Computers", conId: 265598, primaryExchange: "NASDAQ" });
    expect(mocks.tickerUpdates).toEqual([{ where: { symbol: "AAPL" }, update: { ibkr_contract_id: 265598, company_name: "APPLE INC", sector: "Computers", primary_exchange: "NASDAQ" } }]);
  });

  it("returns live details without persisting when the symbol has no ticker row (it never inserts one)", async () => {
    const ib = new FakeIbApi();
    const result = getCachedContractDetails(asConnection(ib), "ZZZZ", 9);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.contractDetails, 9, { longName: "ZZ CORP", contract: { conId: 5 } });
    expect((await result).conId).toBe(5);
    expect(mocks.tickerUpdates).toEqual([]);
  });

  it("does not persist a failed lookup (no contract id), so the next call asks again", async () => {
    mocks.tickerRow = { symbol: "AAPL", ibkr_contract_id: null };
    const ib = new FakeIbApi();
    const result = getCachedContractDetails(asConnection(ib), "AAPL", 9);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("No security definition"), 200, 9);
    expect(await result).toEqual({ companyName: null, sector: null, conId: null, primaryExchange: null });
    expect(mocks.tickerUpdates).toEqual([]);
  });
});

describe("fetchNewTickerData", () => {
  it("borrows the shared read connection, requests real-time data, runs the contract lookup and the market-data snapshot together, merges them and disconnects", async () => {
    const ib = new FakeIbApi();
    mocks.borrowOrConnect.mockResolvedValue({ ib, disconnect: mocks.disconnect });
    mocks.captureSnapshot.mockResolvedValue({ impliedVolatility: 0.42, avgOptionVolume: 12_345 });
    const result = fetchNewTickerData("AAPL");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.borrowOrConnect).toHaveBeenCalledWith({ label: "shared-read" }, "fetchNewTickerData");
    expect(mocks.realtimeRequests).toEqual([ib]);
    // Contract details used the first allocated request id, the snapshot the second, 5 s interactive timeout.
    expect(ib.reqContractDetails).toHaveBeenCalledWith(700, expect.objectContaining({ symbol: "AAPL" }));
    expect(mocks.captureSnapshot).toHaveBeenCalledWith(expect.objectContaining({ ib }), 701, "AAPL", 5_000);
    ib.emit(EventName.contractDetails, 700, { longName: "APPLE INC", industry: "Computers", contract: { conId: 265598, primaryExch: "NASDAQ" } });
    expect(await result).toEqual({ companyName: "APPLE INC", sector: "Computers", conId: 265598, primaryExchange: "NASDAQ", impliedVolatility: 0.42, avgOptionVolume: 12_345 });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnects and rethrows when the market-data snapshot fails", async () => {
    const ib = new FakeIbApi();
    mocks.borrowOrConnect.mockResolvedValue({ ib, disconnect: mocks.disconnect });
    mocks.captureSnapshot.mockRejectedValue(new Error("snapshot failed"));
    const captured = fetchNewTickerData("AAPL").catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.contractDetailsEnd, 700);
    expect(((await captured) as Error).message).toBe("snapshot failed");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});
