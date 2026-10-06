import { EventEmitter } from "node:events";
import { EventName, SecType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  borrow: vi.fn(),
  allocateReqId: vi.fn(() => 4242),
  release: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("./sharedReadConnection.js", () => ({ sharedReadConnection: { borrow: mocks.borrow, allocateReqId: mocks.allocateReqId } }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: mocks.connect }));

import { searchTickers } from "./searchTickers.js";

class FakeIbApi extends EventEmitter {
  reqMatchingSymbols = vi.fn();
}

const description = (symbol: string | undefined, overrides: { secType?: string; currency?: string; description?: string; derivativeSecTypes?: string[] | undefined; noContract?: boolean } = {}) => ({
  contract: overrides.noContract ? undefined : { symbol, secType: overrides.secType ?? SecType.STK, currency: overrides.currency ?? "USD", description: overrides.description },
  derivativeSecTypes: "derivativeSecTypes" in overrides ? overrides.derivativeSecTypes : [SecType.OPT],
});

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of [mocks.borrow, mocks.release, mocks.connect, mocks.disconnect]) mock.mockReset();
  mocks.allocateReqId.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function searchOnSharedConnection(matches: unknown[]) {
  const ib = new FakeIbApi();
  mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
  const result = searchTickers("app");
  await vi.advanceTimersByTimeAsync(0);
  ib.emit(EventName.symbolSamples, 4242, matches);
  return { ib, result };
}

describe("searchTickers result filtering", () => {
  it("keeps US-listed stocks that have options, with the company description", async () => {
    const { result } = await searchOnSharedConnection([description("AAPL", { description: "APPLE INC" }), description("APLE", { description: "APPLE HOSPITALITY REIT" })]);
    expect(await result).toEqual([
      { symbol: "AAPL", companyName: "APPLE INC" },
      { symbol: "APLE", companyName: "APPLE HOSPITALITY REIT" },
    ]);
  });

  it("uses a null company name when IBKR gives no description", async () => {
    const { result } = await searchOnSharedConnection([description("AAPL")]);
    expect(await result).toEqual([{ symbol: "AAPL", companyName: null }]);
  });

  it("drops non-stocks, non-USD listings, stocks without options and matches without a symbol or contract", async () => {
    const { result } = await searchOnSharedConnection([
      description("FUT", { secType: SecType.FUT }),
      description("ETF", { secType: SecType.CFD }),
      description("EURO", { currency: "EUR" }),
      description("NOOPT", { derivativeSecTypes: [SecType.WAR] }),
      description("NODERIV", { derivativeSecTypes: undefined }),
      description("EMPTY", { derivativeSecTypes: [] }),
      description(undefined),
      description("", {}),
      description("X", { noContract: true }),
      description("KEEP"),
    ]);
    expect((await result).map((entry) => entry.symbol)).toEqual(["KEEP"]);
  });

  it("keeps the first listing of a symbol and drops later duplicates", async () => {
    const { result } = await searchOnSharedConnection([description("AAPL", { description: "first" }), description("AAPL", { description: "second" })]);
    expect(await result).toEqual([{ symbol: "AAPL", companyName: "first" }]);
  });

  it("keeps IBKR's order", async () => {
    const { result } = await searchOnSharedConnection([description("ZZZ"), description("AAA"), description("MMM")]);
    expect((await result).map((entry) => entry.symbol)).toEqual(["ZZZ", "AAA", "MMM"]);
  });
});

describe("searchTickers on the shared read connection", () => {
  it("sends the query under a connection-allocated request id and releases the connection", async () => {
    const { ib, result } = await searchOnSharedConnection([]);
    await result;
    expect(ib.reqMatchingSymbols).toHaveBeenCalledWith(4242, "app");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("ignores answers for other requests", async () => {
    const ib = new FakeIbApi();
    mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
    const result = searchTickers("app");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.symbolSamples, 1, [description("OTHER")]);
    ib.emit(EventName.symbolSamples, 4242, [description("AAPL")]);
    expect((await result).map((entry) => entry.symbol)).toEqual(["AAPL"]);
  });

  it("returns no results, not an error, when IBKR reports an error for the request", async () => {
    const ib = new FakeIbApi();
    mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
    const result = searchTickers("app");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("boom"), 321, 4242);
    expect(await result).toEqual([]);
    expect(ib.listenerCount(EventName.symbolSamples)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
  });

  it("ignores an error of another request", async () => {
    const ib = new FakeIbApi();
    mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
    const result = searchTickers("app");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("boom"), 321, 7);
    ib.emit(EventName.symbolSamples, 4242, [description("AAPL")]);
    expect(await result).toHaveLength(1);
  });

  it("returns no results after 8 seconds of silence, and still releases the connection", async () => {
    const ib = new FakeIbApi();
    mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
    const result = searchTickers("app");
    await vi.advanceTimersByTimeAsync(7_999);
    expect(mocks.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual([]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("settles once: an answer after the timeout changes nothing", async () => {
    const ib = new FakeIbApi();
    mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
    const result = searchTickers("app");
    await vi.advanceTimersByTimeAsync(8_000);
    ib.emit(EventName.symbolSamples, 4242, [description("AAPL")]);
    expect(await result).toEqual([]);
  });
});

describe("searchTickers falling back to a one-shot connection", () => {
  it("connects once, uses request id 1, and disconnects, when the shared connection is unavailable", async () => {
    mocks.borrow.mockRejectedValue(new Error("not connected"));
    const ib = new FakeIbApi();
    mocks.connect.mockResolvedValue({ ib, disconnect: mocks.disconnect });
    const result = searchTickers("app");
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqMatchingSymbols).toHaveBeenCalledWith(1, "app");
    ib.emit(EventName.symbolSamples, 1, [description("AAPL", { description: "APPLE INC" })]);
    expect(await result).toEqual([{ symbol: "AAPL", companyName: "APPLE INC" }]);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("searchTickers: shared read connection unavailable (not connected), falling back to a one-shot connection.");
  });

  it("propagates a connection failure of the fallback", async () => {
    mocks.borrow.mockRejectedValue(new Error("not connected"));
    mocks.connect.mockRejectedValue(new Error("tunnel down"));
    await expect(searchTickers("app")).rejects.toThrow("tunnel down");
  });
});
