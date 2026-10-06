import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The real tickerDetailRouter on a small express app. Everything network-bound it delegates to (the detail stream producer, the pooled
// price stream, the price/IV bar cache and the one-shot quote lookup) is mocked, so these tests pin the route's own behaviour: auth,
// validation, headers, SSE framing, section parsing and how producer results and failures reach the client.
const streamTickerDetailMock = vi.fn();
vi.mock("../ibkr/streamTickerDetail.js", () => ({
  allTickerDetailStreamSections: ["overview", "spot", "chart", "technicals"],
  streamTickerDetail: (...args: unknown[]) => streamTickerDetailMock(...args),
}));
const streamPooledStockPricesMock = vi.fn();
vi.mock("../ibkr/pricePool.js", () => ({ streamPooledStockPrices: (...args: unknown[]) => streamPooledStockPricesMock(...args) }));
const fetchCachedPriceBarsMock = vi.fn();
const fetchCachedIvBarsMock = vi.fn();
vi.mock("../ibkr/priceBarCache.js", () => ({
  fetchCachedPriceBars: (...args: unknown[]) => fetchCachedPriceBarsMock(...args),
  fetchCachedIvBars: (...args: unknown[]) => fetchCachedIvBarsMock(...args),
}));
const fetchTickerQuoteSnapshotMock = vi.fn();
vi.mock("../ibkr/fetchTickerQuoteSnapshot.js", () => ({ fetchTickerQuoteSnapshot: (...args: unknown[]) => fetchTickerQuoteSnapshotMock(...args) }));

const { tickerDetailRouter } = await import("./tickerDetail.js");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  vi.stubEnv("PASSKEY_LOGIN", "off");
  const app = express();
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/tickers", tickerDetailRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  vi.unstubAllEnvs();
});

beforeEach(() => {
  streamTickerDetailMock.mockReset().mockResolvedValue(undefined);
  streamPooledStockPricesMock.mockReset().mockResolvedValue(undefined);
  fetchCachedPriceBarsMock.mockReset();
  fetchCachedIvBarsMock.mockReset();
  fetchTickerQuoteSnapshotMock.mockReset();
});

const signedIn = { "x-test-user-id": "route-test-user" };

/** Reads an event stream to its end and returns the headers plus every `data:` frame parsed and every comment line. */
async function readEventStream(path: string, headers: Record<string, string> = signedIn) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  const blocks = text.split("\n\n").filter((block) => block.length > 0);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    frames: blocks.filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice("data: ".length))),
    comments: blocks.filter((block) => block.startsWith(":")),
  };
}

async function getJson(path: string, headers: Record<string, string> = signedIn) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { status: response.status, json: (await response.json()) as any };
}

describe("authentication", () => {
  it.each([
    "/tickers/current-prices/stream?symbols=AAPL",
    "/tickers/AAPL/detail/stream",
    "/tickers/AAPL/quote",
    "/tickers/AAPL/chart?range=1M",
    "/tickers/AAPL/iv-chart?range=1Y",
  ])("refuses %s without a session and calls no producer", async (path) => {
    expect(await getJson(path, {})).toEqual({ status: 401, json: { error: "Not logged in." } });
    expect(streamTickerDetailMock).not.toHaveBeenCalled();
    expect(streamPooledStockPricesMock).not.toHaveBeenCalled();
    expect(fetchCachedPriceBarsMock).not.toHaveBeenCalled();
    expect(fetchCachedIvBarsMock).not.toHaveBeenCalled();
    expect(fetchTickerQuoteSnapshotMock).not.toHaveBeenCalled();
  });
});

describe("GET /tickers/current-prices/stream", () => {
  it("sends SSE headers, normalises the symbol list (trim, upper-case, de-duplicate, drop blanks) and forwards each price frame", async () => {
    streamPooledStockPricesMock.mockImplementation(async (_symbols: string[], onPrices: (prices: unknown) => void) => {
      onPrices({ AAPL: 190.25 });
      onPrices({ AAPL: 190.5, MSFT: 410 });
    });

    const stream = await readEventStream("/tickers/current-prices/stream?symbols=aapl, MSFT,,aapl , msft");

    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("text/event-stream");
    expect(stream.cacheControl).toBe("no-cache");
    expect(streamPooledStockPricesMock).toHaveBeenCalledTimes(1);
    expect(streamPooledStockPricesMock.mock.calls[0]?.[0]).toEqual(["AAPL", "MSFT"]);
    expect(stream.frames).toEqual([{ AAPL: 190.25 }, { AAPL: 190.5, MSFT: 410 }]);
  });

  it.each([
    ["no symbols parameter", "/tickers/current-prices/stream"],
    ["an empty symbols parameter", "/tickers/current-prices/stream?symbols="],
    ["only commas and blanks", "/tickers/current-prices/stream?symbols=,%20,"],
  ])("answers %s with one empty frame, ends the stream and subscribes to nothing", async (_label, path) => {
    const stream = await readEventStream(path);
    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("text/event-stream");
    expect(stream.frames).toEqual([{}]);
    expect(streamPooledStockPricesMock).not.toHaveBeenCalled();
  });

  it("treats a repeated symbols parameter (an array, not text) as no symbols", async () => {
    const stream = await readEventStream("/tickers/current-prices/stream?symbols=AAPL&symbols=MSFT");
    expect(stream.frames).toEqual([{}]);
    expect(streamPooledStockPricesMock).not.toHaveBeenCalled();
  });

  it("ends the stream without an error frame when the pooled producer fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    streamPooledStockPricesMock.mockImplementation(async (_symbols: string[], onPrices: (prices: unknown) => void) => {
      onPrices({ AAPL: 1 });
      throw new Error("pool exploded");
    });

    const stream = await readEventStream("/tickers/current-prices/stream?symbols=AAPL");

    expect(stream.status).toBe(200);
    expect(stream.frames).toEqual([{ AAPL: 1 }]);
    expect(consoleErrorSpy).toHaveBeenCalledWith("tickers/current-prices/stream: streamPooledStockPrices failed", expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  it("aborts the producer's signal when the client disconnects", async () => {
    let producerSignal: AbortSignal | undefined;
    let producerStarted!: () => void;
    const started = new Promise<void>((resolve) => (producerStarted = resolve));
    const producerFinished = new Promise<void>((resolveFinished) => {
      streamPooledStockPricesMock.mockImplementation(async (_symbols: string[], _onPrices: unknown, signal: AbortSignal) => {
        producerSignal = signal;
        producerStarted();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        resolveFinished();
      });
    });

    const clientAbort = new AbortController();
    const response = await fetch(`${baseUrl}/tickers/current-prices/stream?symbols=AAPL`, { headers: signedIn, signal: clientAbort.signal });
    await started;
    expect(producerSignal?.aborted).toBe(false);
    clientAbort.abort();
    await response.body?.cancel().catch(() => {});
    await producerFinished;
    expect(producerSignal?.aborted).toBe(true);
  });
});

describe("GET /tickers/:symbol/detail/stream", () => {
  it("upper-cases the symbol, streams the producer's events in order, then a done frame; no sections parameter passes undefined (everything)", async () => {
    streamTickerDetailMock.mockImplementation(async (_symbol: string, send: (data: unknown) => void) => {
      send({ type: "overview", data: { name: "Apple" } });
      send({ type: "spot", data: { price: 190 } });
    });

    const stream = await readEventStream("/tickers/aapl/detail/stream");

    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("text/event-stream");
    expect(stream.cacheControl).toBe("no-cache");
    expect(stream.frames).toEqual([{ type: "overview", data: { name: "Apple" } }, { type: "spot", data: { price: 190 } }, { type: "done" }]);
    expect(streamTickerDetailMock).toHaveBeenCalledTimes(1);
    const [symbol, , signal, sections] = streamTickerDetailMock.mock.calls[0]!;
    expect(symbol).toBe("AAPL");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(sections).toBeUndefined();
  });

  it("passes the requested sections trimmed, in the given order, with blank entries dropped", async () => {
    await readEventStream("/tickers/AAPL/detail/stream?sections=technicals,%20overview%20,,chart");
    expect(streamTickerDetailMock.mock.calls[0]?.[3]).toEqual(["technicals", "overview", "chart"]);
  });

  it("accepts every known section", async () => {
    const stream = await readEventStream("/tickers/AAPL/detail/stream?sections=overview,spot,chart,technicals");
    expect(streamTickerDetailMock.mock.calls[0]?.[3]).toEqual(["overview", "spot", "chart", "technicals"]);
    expect(stream.frames).toEqual([{ type: "done" }]);
  });

  it("passes an empty sections parameter through as an empty list (not as everything)", async () => {
    await readEventStream("/tickers/AAPL/detail/stream?sections=");
    expect(streamTickerDetailMock.mock.calls[0]?.[3]).toEqual([]);
  });

  it("rejects an unknown section with one streamError frame naming the first unknown one and never starts the producer", async () => {
    const stream = await readEventStream("/tickers/AAPL/detail/stream?sections=overview,bogus,other");
    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("text/event-stream");
    expect(stream.frames).toEqual([{ type: "streamError", message: 'Unknown section "bogus".' }]);
    expect(streamTickerDetailMock).not.toHaveBeenCalled();
  });

  it("matches section names case-sensitively", async () => {
    const stream = await readEventStream("/tickers/AAPL/detail/stream?sections=Overview");
    expect(stream.frames).toEqual([{ type: "streamError", message: 'Unknown section "Overview".' }]);
  });

  it("turns a producer Error into a streamError frame after the events already sent, with no done frame", async () => {
    streamTickerDetailMock.mockImplementation(async (_symbol: string, send: (data: unknown) => void) => {
      send({ type: "overview", data: {} });
      throw new Error("IBKR is unavailable");
    });
    const stream = await readEventStream("/tickers/AAPL/detail/stream");
    expect(stream.frames).toEqual([{ type: "overview", data: {} }, { type: "streamError", message: "IBKR is unavailable" }]);
  });

  it("stringifies a non-Error producer failure", async () => {
    streamTickerDetailMock.mockRejectedValue("plain text failure");
    const stream = await readEventStream("/tickers/AAPL/detail/stream");
    expect(stream.frames).toEqual([{ type: "streamError", message: "plain text failure" }]);
  });

  it("aborts the producer's signal when the client disconnects", async () => {
    let producerSignal: AbortSignal | undefined;
    let producerStarted!: () => void;
    const started = new Promise<void>((resolve) => (producerStarted = resolve));
    const producerFinished = new Promise<void>((resolveFinished) => {
      streamTickerDetailMock.mockImplementation(async (_symbol: string, _send: unknown, signal: AbortSignal) => {
        producerSignal = signal;
        producerStarted();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        resolveFinished();
      });
    });

    const clientAbort = new AbortController();
    const response = await fetch(`${baseUrl}/tickers/AAPL/detail/stream`, { headers: signedIn, signal: clientAbort.signal });
    await started;
    expect(producerSignal?.aborted).toBe(false);
    clientAbort.abort();
    await response.body?.cancel().catch(() => {});
    await producerFinished;
    expect(producerSignal?.aborted).toBe(true);
  });
});

describe("GET /tickers/:symbol/quote", () => {
  it("answers with the snapshot as JSON and looks the symbol up upper-cased", async () => {
    const snapshot = { symbol: "AAPL", lastPrice: 190.25, source: "live" };
    fetchTickerQuoteSnapshotMock.mockResolvedValue(snapshot);

    expect(await getJson("/tickers/aapl/quote")).toEqual({ status: 200, json: snapshot });
    expect(fetchTickerQuoteSnapshotMock).toHaveBeenCalledWith("AAPL");
  });

  it("answers 500 when the snapshot lookup throws", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchTickerQuoteSnapshotMock.mockRejectedValue(new Error("no such ticker"));
    const response = await fetch(`${baseUrl}/tickers/ZZZZ/quote`, { headers: signedIn });
    expect(response.status).toBe(500);
    consoleErrorSpy.mockRestore();
  });
});

describe("GET /tickers/:symbol/chart", () => {
  it.each([["1D"], ["5D"], ["1M"], ["3M"], ["6M"], ["1Y"], ["5Y"], ["All"]])("range %s: streams the bars as one final 200 frame", async (range) => {
    const bars = [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5 }];
    fetchCachedPriceBarsMock.mockResolvedValue(bars);

    const stream = await readEventStream(`/tickers/aapl/chart?range=${range}`);

    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("text/event-stream");
    expect(stream.frames).toEqual([{ status: 200, body: bars }]);
    expect(fetchCachedPriceBarsMock).toHaveBeenCalledWith("AAPL", range);
  });

  it.each([
    ["no range", "/tickers/AAPL/chart"],
    ["an empty range", "/tickers/AAPL/chart?range="],
    ["an unknown range", "/tickers/AAPL/chart?range=2W"],
    ["a wrongly cased range", "/tickers/AAPL/chart?range=all"],
  ])("refuses %s with a plain 400 JSON (not a stream) and reads no bars", async (_label, path) => {
    const response = await getJson(path);
    expect(response).toEqual({ status: 400, json: { error: "A valid range query parameter is required." } });
    expect(fetchCachedPriceBarsMock).not.toHaveBeenCalled();
  });

  it("turns a bar-cache failure into a status-500 frame inside the stream", async () => {
    fetchCachedPriceBarsMock.mockRejectedValue(new Error("backfill failed"));
    const stream = await readEventStream("/tickers/AAPL/chart?range=1Y");
    expect(stream.status).toBe(200);
    expect(stream.frames).toEqual([{ status: 500, body: { error: "backfill failed" } }]);
  });
});

describe("GET /tickers/:symbol/iv-chart", () => {
  it.each([["1Y"], ["5Y"], ["All"]])("range %s: answers the daily IV points as JSON", async (range) => {
    const points = [{ date: "2026-09-30", impliedVolatility: 0.31 }];
    fetchCachedIvBarsMock.mockResolvedValue(points);

    expect(await getJson(`/tickers/aapl/iv-chart?range=${range}`)).toEqual({ status: 200, json: points });
    expect(fetchCachedIvBarsMock).toHaveBeenCalledWith("AAPL", range);
  });

  it.each([
    ["no range", "/tickers/AAPL/iv-chart"],
    ["an intraday range the price chart accepts", "/tickers/AAPL/iv-chart?range=1M"],
    ["an unknown range", "/tickers/AAPL/iv-chart?range=10Y"],
  ])("refuses %s with a 400 and reads no IV bars", async (_label, path) => {
    expect(await getJson(path)).toEqual({ status: 400, json: { error: "A valid range query parameter (1Y, 5Y, or All) is required." } });
    expect(fetchCachedIvBarsMock).not.toHaveBeenCalled();
  });

  it("answers an empty list as an empty JSON array", async () => {
    fetchCachedIvBarsMock.mockResolvedValue([]);
    expect(await getJson("/tickers/AAPL/iv-chart?range=1Y")).toEqual({ status: 200, json: [] });
  });
});
