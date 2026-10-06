import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceBar } from "./fetchTickerOverview.js";
import type { PooledQuote } from "./marketDataPool.js";

const mocks = vi.hoisted(() => ({
  borrowLive: vi.fn(),
  connect: vi.fn(),
  releaseLive: vi.fn(),
  disconnectOneShot: vi.fn(),
  realtimeRequests: [] as unknown[],
  nextRequestId: 0,
  contractDetails: vi.fn(),
  isShortlistedRow: undefined as unknown,
  shortlistQueries: [] as unknown[][],
  quoteSubscriptions: [] as { contract: unknown; push: (quote: PooledQuote) => void; unsubscribe: ReturnType<typeof import("vitest").vi.fn> }[],
  spotStreams: [] as { contracts: unknown[]; push: (prices: Record<string, number | null>) => void; signal: AbortSignal; fail: (error: Error) => void }[],
  chartRequests: [] as { symbol: string; range: string; reqId: number }[],
  chartBarsByRange: {} as Record<string, PriceBar[] | Error>,
  technicalsCalls: [] as { name: string; args: unknown[] }[],
}));

vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: mocks.connect }));
vi.mock("./requestMarketData.js", () => ({ requestRealtimeMarketData: (ib: unknown) => void mocks.realtimeRequests.push(ib) }));
vi.mock("./sharedReadConnection.js", () => ({
  sharedLiveConnection: { borrow: mocks.borrowLive },
  nextReqIdFor: (_ib: unknown, fallback: () => number) => {
    mocks.nextRequestId += 1;
    void fallback;
    return 1000 + mocks.nextRequestId;
  },
}));
// A derived promise, not the mock's own: vitest attaches a handler to every promise a mock returns, which would hide an unhandled rejection.
vi.mock("./fetchNewTickerData.js", () => ({ getCachedContractDetails: (...args: unknown[]) => Promise.resolve(mocks.contractDetails(...args)).then((value) => value) }));
vi.mock("./marketDataPool.js", () => ({
  subscribeToPooledQuote: async (contract: unknown, push: (quote: PooledQuote) => void) => {
    const unsubscribe = vi.fn();
    mocks.quoteSubscriptions.push({ contract, push, unsubscribe });
    return unsubscribe;
  },
}));
vi.mock("./pricePool.js", () => ({
  streamPooledPrices: (contracts: unknown[], push: (prices: Record<string, number | null>) => void, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      mocks.spotStreams.push({ contracts, push, signal, fail: reject });
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
}));
vi.mock("./priceBarCache.js", () => ({
  getCachedChartBars: async (_connection: unknown, symbol: string, range: string, reqId: number) => {
    mocks.chartRequests.push({ symbol, range, reqId });
    const bars = mocks.chartBarsByRange[range];
    if (bars instanceof Error) throw bars;
    return bars ?? [];
  },
}));
vi.mock("../db/connection.js", () => {
  const builder: Record<string, unknown> = {};
  for (const operation of ["join", "where", "whereNull"]) {
    builder[operation] = (...args: unknown[]) => {
      mocks.shortlistQueries.push([operation, ...args]);
      return builder;
    };
  }
  builder.first = () => Promise.resolve(mocks.isShortlistedRow);
  return { db: () => builder };
});
vi.mock("../lib/technicalIndicators.js", () => ({
  computeMovingAverages: (...args: unknown[]) => (mocks.technicalsCalls.push({ name: "computeMovingAverages", args }), { ma7: 1, ma25: 2, ma99: 3 }),
  computeRsi: (...args: unknown[]) => (mocks.technicalsCalls.push({ name: "computeRsi", args }), 55),
  computeMacd: (...args: unknown[]) => (mocks.technicalsCalls.push({ name: "computeMacd", args }), "Bullish"),
  computeSupportResistance: (...args: unknown[]) => (mocks.technicalsCalls.push({ name: "computeSupportResistance", args }), { support: [], resistance: [] }),
}));

import { streamTickerDetail, type TickerDetailStreamEvent } from "./streamTickerDetail.js";

const fakeIb = { id: "fake-ib" };
const quote = (overrides: Partial<PooledQuote> = {}): PooledQuote => ({
  last: 190, bid: 189.9, ask: 190.1, delta: null, gamma: null, vega: null, theta: null, impliedVolatility: null, underlyingPrice: null, open: 188, high: 191, low: 187, previousClose: 186, volume: 1_000_000, ...overrides,
});
const bar = (time: number, close: number): PriceBar => ({ time, open: close, high: close, low: close, close, volume: 1 });
const nowSeconds = () => Date.now() / 1000;

let events: TickerDetailStreamEvent[];
let controller: AbortController;
const typesOf = () => events.map((event) => (event.type === "error" ? `error:${event.section}` : event.type));

function startStream(sections?: Parameters<typeof streamTickerDetail>[3]) {
  controller = new AbortController();
  let finished = false;
  const promise = streamTickerDetail("AAPL", (event) => events.push(event), controller.signal, sections).then(() => (finished = true));
  return { promise, isFinished: () => finished };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  events = [];
  mocks.nextRequestId = 0;
  for (const mock of [mocks.borrowLive, mocks.connect, mocks.releaseLive, mocks.disconnectOneShot, mocks.contractDetails]) mock.mockReset();
  mocks.borrowLive.mockResolvedValue({ ib: fakeIb, release: mocks.releaseLive });
  mocks.contractDetails.mockResolvedValue({ companyName: "APPLE INC", sector: "Computers", conId: 265598, primaryExchange: "NASDAQ" });
  mocks.isShortlistedRow = undefined;
  mocks.shortlistQueries.length = 0;
  mocks.realtimeRequests.length = 0;
  mocks.quoteSubscriptions.length = 0;
  mocks.spotStreams.length = 0;
  mocks.chartRequests.length = 0;
  mocks.chartBarsByRange = {};
  mocks.technicalsCalls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  controller?.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("streamTickerDetail connections", () => {
  it("uses the shared live connection, requests real-time data once and releases it only after the abort", async () => {
    const { promise, isFinished } = startStream(["spot"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.realtimeRequests).toEqual([fakeIb]);
    expect(mocks.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(isFinished()).toBe(false);
    expect(mocks.releaseLive).not.toHaveBeenCalled();
    controller.abort();
    await promise;
    expect(mocks.releaseLive).toHaveBeenCalledTimes(1);
  });

  it("falls back to a one-shot connection and disconnects it at the end", async () => {
    mocks.borrowLive.mockRejectedValue(new Error("not connected"));
    mocks.connect.mockResolvedValue({ ib: fakeIb, disconnect: mocks.disconnectOneShot });
    const { promise } = startStream(["spot"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(console.log).toHaveBeenCalledWith("streamTickerDetail: shared live connection unavailable (not connected), falling back to a one-shot connection.");
    controller.abort();
    await promise;
    expect(mocks.disconnectOneShot).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLive).not.toHaveBeenCalled();
  });

  it("returns at once when the signal is already aborted after the work finished", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await streamTickerDetail("AAPL", (event) => events.push(event), aborted.signal, []);
    expect(mocks.releaseLive).toHaveBeenCalledTimes(1);
  });
});

describe("streamTickerDetail overview", () => {
  it("sends the company, sector, mapped pricing and shortlist flag for each pooled quote, and waits on the first price", async () => {
    mocks.isShortlistedRow = { id: "x" };
    startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.quoteSubscriptions[0]!.contract).toEqual({ key: "AAPL", legType: "stock", symbol: "AAPL" });
    mocks.quoteSubscriptions[0]!.push(quote());
    expect(events).toEqual([
      { type: "overview", data: { companyName: "APPLE INC", sector: "Computers", pricing: { last: 190, bid: 189.9, ask: 190.1, open: 188, high: 191, low: 187, previousClose: 186, volume: 1_000_000 }, isShortlisted: true } },
    ]);
  });

  it("reports isShortlisted false without a shortlist row, and queries the active entry of the symbol", async () => {
    startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(0);
    mocks.quoteSubscriptions[0]!.push(quote());
    expect((events[0] as { data: { isShortlisted: boolean } }).data.isShortlisted).toBe(false);
    expect(mocks.shortlistQueries).toContainEqual(["where", { "t.symbol": "AAPL" }]);
    expect(mocks.shortlistQueries).toContainEqual(["whereNull", "se.removed_at"]);
  });

  it("maps a pooled quote's missing fields to null pricing", async () => {
    startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(0);
    mocks.quoteSubscriptions[0]!.push(quote({ last: null, bid: null, ask: null, open: null, high: null, low: null, previousClose: null, volume: null }));
    expect((events[0] as { data: { pricing: unknown } }).data.pricing).toEqual({ last: null, bid: null, ask: null, open: null, high: null, low: null, previousClose: null, volume: null });
  });

  it("does not request chart bars or the spot stream for an overview-only stream", async () => {
    startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.chartRequests).toEqual([]);
    expect(mocks.spotStreams).toEqual([]);
  });

  it("reports an overview error event when the contract details fail, using the error message", async () => {
    mocks.contractDetails.mockRejectedValue(new Error("pacing violation"));
    startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: "error", section: "overview", message: "pacing violation" }]);
  });

  it("stringifies a non-Error rejection", async () => {
    mocks.contractDetails.mockRejectedValue("plain failure");
    startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: "error", section: "overview", message: "plain failure" }]);
  });

  it("unsubscribes the pooled quote when the signal aborts", async () => {
    const { promise } = startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(0);
    mocks.quoteSubscriptions[0]!.push(quote());
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await promise;
    expect(mocks.quoteSubscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is ready after 5 s even when no price ever arrives, and the stream still stays open", async () => {
    const { isFinished } = startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(isFinished()).toBe(false);
  });
});

describe("streamTickerDetail spot", () => {
  it("subscribes the symbol as a stock and sends a spot event per price, skipping null and missing prices", async () => {
    startStream(["spot"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spotStreams[0]!.contracts).toEqual([{ key: "AAPL", legType: "stock", symbol: "AAPL" }]);
    mocks.spotStreams[0]!.push({ AAPL: null });
    mocks.spotStreams[0]!.push({});
    mocks.spotStreams[0]!.push({ AAPL: 190.5 });
    mocks.spotStreams[0]!.push({ AAPL: 190.75 });
    expect(events).toEqual([{ type: "spot", data: { last: 190.5 } }, { type: "spot", data: { last: 190.75 } }]);
  });

  it("passes the stream's abort signal to the price stream", async () => {
    startStream(["spot"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spotStreams[0]!.signal).toBe(controller.signal);
  });

  it("logs a failed price stream without failing the stream", async () => {
    const { isFinished } = startStream(["spot"]);
    await vi.advanceTimersByTimeAsync(0);
    mocks.spotStreams[0]!.fail(new Error("pool down"));
    await vi.advanceTimersByTimeAsync(0);
    expect(console.error).toHaveBeenCalledWith("streamTickerDetail: spot price stream failed for AAPL", expect.any(Error));
    expect(isFinished()).toBe(false);
  });

  it("sends nothing and opens no price stream when spot is not requested", async () => {
    startStream(["chart"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spotStreams).toEqual([]);
  });
});

describe("streamTickerDetail chart", () => {
  it("fetches the 3M bars and sends them", async () => {
    mocks.chartBarsByRange["3M"] = [bar(1, 100), bar(2, 101)];
    startStream(["chart"]);
    await vi.advanceTimersByTimeAsync(0);
    // The contract-details request takes the connection's first id even for a chart-only stream; the chart gets the next one.
    expect(mocks.chartRequests).toEqual([{ symbol: "AAPL", range: "3M", reqId: 1002 }]);
    expect(events).toEqual([{ type: "chart", data: [bar(1, 100), bar(2, 101)] }]);
  });

  it("sends a chart error with the message when the bars fail", async () => {
    mocks.chartBarsByRange["3M"] = new Error("Historical data timeout for AAPL");
    startStream(["chart"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: "error", section: "chart", message: "Historical data timeout for AAPL" }]);
  });
});

describe("streamTickerDetail work that only the overview awaits", () => {
  it("leaves no unhandled rejection when contract details fail on a stream that does not include the overview", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      mocks.contractDetails.mockRejectedValue(new Error("contract details failed"));
      mocks.chartBarsByRange["3M"] = [bar(1, 100)];
      startStream(["chart"]);
      await vi.advanceTimersByTimeAsync(0);
      // Node reports an unhandled rejection only after a full turn of the real event loop.
      vi.useRealTimers();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(events).toEqual([{ type: "chart", data: [bar(1, 100)] }]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("still reports the failure to the overview section when it is requested", async () => {
    mocks.contractDetails.mockRejectedValue(new Error("contract details failed"));
    startStream(["overview"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: "error", section: "overview", message: "contract details failed" }]);
  });
});

describe("streamTickerDetail technicals", () => {
  const hourlyBars = (lastBarAgeSeconds: number) => [bar(nowSeconds() - lastBarAgeSeconds - 3600, 99), bar(nowSeconds() - lastBarAgeSeconds, 100)];
  const dailyBars = [bar(1, 10), bar(2, 20), bar(3, 30)];

  it("fetches 3M hourly and 1Y daily bars without a chart event when only technicals are requested", async () => {
    mocks.chartBarsByRange["3M"] = hourlyBars(7200);
    mocks.chartBarsByRange["1Y"] = dailyBars;
    startStream(["technicals"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.chartRequests.map((request) => request.range).sort()).toEqual(["1Y", "3M"]);
    expect(typesOf()).toEqual(["technicals"]);
  });

  it("computes the moving averages, RSI and MACD from the daily closes and the support/resistance from the hourly bars", async () => {
    const hourly = hourlyBars(7200);
    mocks.chartBarsByRange["3M"] = hourly;
    mocks.chartBarsByRange["1Y"] = dailyBars;
    startStream(["technicals"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events[0]).toEqual({ type: "technicals", data: { movingAverages: { ma7: 1, ma25: 2, ma99: 3 }, rsi: 55, macdSignal: "Bullish", supportResistance: { support: [], resistance: [] } } });
    const callArgs = (name: string) => mocks.technicalsCalls.find((call) => call.name === name)!.args;
    expect(callArgs("computeRsi")).toEqual([[10, 20, 30]]);
    expect(callArgs("computeMacd")).toEqual([[10, 20, 30]]);
    expect(callArgs("computeMovingAverages")).toEqual([[10, 20, 30]]);
    expect(callArgs("computeSupportResistance")[0]).toBe(hourly);
  });

  it("scores against the first spot price when the spot stream delivers one", async () => {
    mocks.chartBarsByRange["3M"] = hourlyBars(7200);
    mocks.chartBarsByRange["1Y"] = dailyBars;
    startStream(["spot", "technicals"]);
    await vi.advanceTimersByTimeAsync(0);
    mocks.spotStreams[0]!.push({ AAPL: 191.25 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.technicalsCalls.find((call) => call.name === "computeSupportResistance")!.args[1]).toBe(191.25);
  });

  it("falls back to the daily close when neither a spot nor a pooled price is available (after the 5 s spot wait)", async () => {
    mocks.chartBarsByRange["3M"] = hourlyBars(7200);
    mocks.chartBarsByRange["1Y"] = dailyBars;
    startStream(["spot", "technicals"]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events.filter((event) => event.type === "technicals")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.technicalsCalls.find((call) => call.name === "computeSupportResistance")!.args[1]).toBe(30);
  });

  it("marks the current hourly candle open only when the last bar started less than an hour ago", async () => {
    mocks.chartBarsByRange["3M"] = hourlyBars(3599);
    mocks.chartBarsByRange["1Y"] = dailyBars;
    startStream(["technicals"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.technicalsCalls.find((call) => call.name === "computeSupportResistance")!.args[2]).toBe(true);

    mocks.technicalsCalls.length = 0;
    controller.abort();
    mocks.chartBarsByRange["3M"] = hourlyBars(3600);
    startStream(["technicals"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.technicalsCalls.find((call) => call.name === "computeSupportResistance")!.args[2]).toBe(false);
  });

  it("reports a technicals error, not an exception, when there are no hourly bars", async () => {
    mocks.chartBarsByRange["3M"] = [];
    mocks.chartBarsByRange["1Y"] = dailyBars;
    startStream(["technicals"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toEqual([{ type: "error", section: "technicals", message: "No market data available to compute technicals." }]);
  });

  it("reports a technicals error when there is no price at all (no spot, no pooled price, no daily bars)", async () => {
    mocks.chartBarsByRange["3M"] = hourlyBars(7200);
    mocks.chartBarsByRange["1Y"] = [];
    startStream(["technicals"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toEqual([{ type: "error", section: "technicals", message: "No market data available to compute technicals." }]);
  });

  it("reports a technicals error when the daily bars fail, and no chart error when only technicals were requested", async () => {
    mocks.chartBarsByRange["3M"] = hourlyBars(7200);
    mocks.chartBarsByRange["1Y"] = new Error("daily bars timed out");
    startStream(["technicals"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events).toEqual([{ type: "error", section: "technicals", message: "daily bars timed out" }]);
  });

  it("does not send a chart error for failed hourly bars when only technicals were requested, but does when chart is requested", async () => {
    mocks.chartBarsByRange["3M"] = new Error("hourly timeout");
    mocks.chartBarsByRange["1Y"] = dailyBars;
    startStream(["chart", "technicals"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(typesOf().sort()).toEqual(["error:chart", "error:technicals"]);
  });
});

describe("streamTickerDetail all sections", () => {
  it("requests every section by default, in the order overview, chart, technicals and spot events arriving as they are ready", async () => {
    mocks.chartBarsByRange["3M"] = [bar(nowSeconds() - 7200, 100)];
    mocks.chartBarsByRange["1Y"] = [bar(1, 100)];
    const { promise } = startStream();
    await vi.advanceTimersByTimeAsync(0);
    mocks.quoteSubscriptions[0]!.push(quote());
    mocks.spotStreams[0]!.push({ AAPL: 190.5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(typesOf().sort()).toEqual(["chart", "overview", "spot", "technicals"]);
    controller.abort();
    await promise;
  });
});
