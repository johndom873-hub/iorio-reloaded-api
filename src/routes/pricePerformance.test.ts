import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real pricePerformanceRouter on a small express app against the test database. The snapshot computation (covered by its own tests)
// and the pooled price stream are mocked; the live-price stream's shortlist query runs for real against rows this file creates.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run price performance route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
const getPricePerformanceSnapshotMock = vi.fn();
vi.mock("../lib/pricePerformanceSnapshot.js", () => ({ getPricePerformanceSnapshot: (...args: unknown[]) => getPricePerformanceSnapshotMock(...args) }));
const streamPooledStockPricesMock = vi.fn();
vi.mock("../ibkr/pricePool.js", () => ({ streamPooledStockPrices: (...args: unknown[]) => streamPooledStockPricesMock(...args) }));

const { db } = await import("../db/connection.js");
const { pricePerformanceRouter } = await import("./pricePerformance.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
const createdTickerIds: string[] = [];
const createdShortlistEntryIds: string[] = [];
const symbolSuffix = String(Date.now() % 1_000_000);

beforeAll(async () => {
  vi.stubEnv("PASSKEY_LOGIN", "off");
  const [user] = await testDb("users").insert({ username: `price-perf-route-${Date.now()}`, display_name: "Price Performance Route Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;

  const app = express();
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/price-performance", pricePerformanceRouter);
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
  await testDb("shortlist_entries").whereIn("id", createdShortlistEntryIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  getPricePerformanceSnapshotMock.mockReset();
  streamPooledStockPricesMock.mockReset().mockResolvedValue(undefined);
});

const signedIn = () => ({ "x-test-user-id": userId });

async function createTicker(symbol: string): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Price Performance Route Test Co" }).returning("id");
  createdTickerIds.push(ticker.id);
  return ticker.id;
}

async function shortlist(tickerId: string, removedAt: Date | null): Promise<void> {
  const [entry] = await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: userId, removed_at: removedAt }).returning("id");
  createdShortlistEntryIds.push(entry.id);
}

async function readEventStream(path: string, headers: Record<string, string> = signedIn()) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  const blocks = text.split("\n\n").filter((block) => block.length > 0);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    frames: blocks.filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice("data: ".length))),
  };
}

// fetch() adds its own Cache-Control request header to a conditional request, which defeats Express's freshness check; a raw
// request sends exactly the headers a revalidating browser would.
function getWithRawHeaders(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const rawRequest = httpRequest(`${baseUrl}${path}`, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    rawRequest.on("error", reject);
    rawRequest.end();
  });
}

describe("GET /price-performance", () => {
  const snapshot = {
    tickers: [{ symbol: "AAA", latestClose: "10.5000", change24h: 1.25, isBehind: false }],
    meta: { completedThroughDate: "2026-10-02", expectedSessionDate: "2026-10-02", isDataCurrent: true, behindSymbols: [] },
    ignoredExtraField: "must not be sent",
  };

  it("answers the snapshot's tickers and meta only, with a private no-cache header and an ETag", async () => {
    getPricePerformanceSnapshotMock.mockResolvedValue(snapshot);

    const response = await fetch(`${baseUrl}/price-performance`, { headers: signedIn() });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBeTruthy();
    expect(await response.json()).toEqual({ tickers: snapshot.tickers, meta: snapshot.meta });
  });

  it("answers 304 with no body when the browser repeats the request with the ETag of unchanged data", async () => {
    getPricePerformanceSnapshotMock.mockResolvedValue(snapshot);
    const first = await fetch(`${baseUrl}/price-performance`, { headers: signedIn() });
    const etag = first.headers.get("etag")!;
    await first.arrayBuffer();

    const repeat = await getWithRawHeaders("/price-performance", { ...signedIn(), "if-none-match": etag });

    expect(repeat).toEqual({ status: 304, body: "" });
  });

  it("answers a fresh 200 when the ETag no longer matches", async () => {
    getPricePerformanceSnapshotMock.mockResolvedValue(snapshot);
    const response = await getWithRawHeaders("/price-performance", { ...signedIn(), "if-none-match": 'W/"stale"' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ tickers: snapshot.tickers, meta: snapshot.meta });
  });

  it("answers an empty shortlist as empty tickers", async () => {
    getPricePerformanceSnapshotMock.mockResolvedValue({ tickers: [], meta: snapshot.meta });
    const response = await fetch(`${baseUrl}/price-performance`, { headers: signedIn() });
    expect(await response.json()).toEqual({ tickers: [], meta: snapshot.meta });
  });

  it("answers 500 when the snapshot cannot be computed", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getPricePerformanceSnapshotMock.mockRejectedValue(new Error("database down"));
    const response = await fetch(`${baseUrl}/price-performance`, { headers: signedIn() });
    expect(response.status).toBe(500);
    await response.arrayBuffer();
    consoleErrorSpy.mockRestore();
  });

  it("is refused without a session and never computes the snapshot", async () => {
    const response = await fetch(`${baseUrl}/price-performance`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not logged in." });
    expect(getPricePerformanceSnapshotMock).not.toHaveBeenCalled();
  });
});

describe("GET /price-performance/current-prices/stream", () => {
  it("streams prices for the actively shortlisted symbols in symbol order, leaving out removed entries and unshortlisted tickers", async () => {
    const activeFirstSymbol = `PPR${symbolSuffix}A`;
    const activeSecondSymbol = `PPR${symbolSuffix}B`;
    const removedSymbol = `PPR${symbolSuffix}C`;
    const neverShortlistedSymbol = `PPR${symbolSuffix}D`;
    // Inserted out of order so the ordering comes from the query, not from insertion.
    await shortlist(await createTicker(activeSecondSymbol), null);
    await shortlist(await createTicker(activeFirstSymbol), null);
    await shortlist(await createTicker(removedSymbol), new Date());
    await createTicker(neverShortlistedSymbol);
    streamPooledStockPricesMock.mockImplementation(async (_symbols: string[], onPrices: (prices: unknown) => void) => {
      onPrices({ [activeFirstSymbol]: 11.5 });
      onPrices({ [activeFirstSymbol]: 11.75, [activeSecondSymbol]: 22 });
    });

    const stream = await readEventStream("/price-performance/current-prices/stream");

    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("text/event-stream");
    expect(stream.cacheControl).toBe("no-cache");
    expect(stream.frames).toEqual([{ [activeFirstSymbol]: 11.5 }, { [activeFirstSymbol]: 11.75, [activeSecondSymbol]: 22 }]);
    expect(streamPooledStockPricesMock).toHaveBeenCalledTimes(1);
    const [symbols, , signal] = streamPooledStockPricesMock.mock.calls[0]!;
    expect(symbols).toContain(activeFirstSymbol);
    expect(symbols).toContain(activeSecondSymbol);
    expect(symbols).not.toContain(removedSymbol);
    expect(symbols).not.toContain(neverShortlistedSymbol);
    expect(symbols.indexOf(activeFirstSymbol)).toBeLessThan(symbols.indexOf(activeSecondSymbol));
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("lists a ticker that was removed and later shortlisted again once", async () => {
    const symbol = `PPR${symbolSuffix}E`;
    const tickerId = await createTicker(symbol);
    await shortlist(tickerId, new Date());
    await shortlist(tickerId, null);

    await readEventStream("/price-performance/current-prices/stream");

    const symbols: string[] = streamPooledStockPricesMock.mock.calls[0]![0];
    expect(symbols.filter((candidate) => candidate === symbol)).toEqual([symbol]);
  });

  it("ends the stream without an error frame when the pooled producer fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await shortlist(await createTicker(`PPR${symbolSuffix}F`), null);
    streamPooledStockPricesMock.mockImplementation(async (_symbols: string[], onPrices: (prices: unknown) => void) => {
      onPrices({ one: 1 });
      throw new Error("pool exploded");
    });

    const stream = await readEventStream("/price-performance/current-prices/stream");

    expect(stream.status).toBe(200);
    expect(stream.frames).toEqual([{ one: 1 }]);
    expect(consoleErrorSpy).toHaveBeenCalledWith("price-performance/current-prices/stream: streamPooledStockPrices failed", expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  it("aborts the producer's signal when the client disconnects", async () => {
    await shortlist(await createTicker(`PPR${symbolSuffix}G`), null);
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
    const response = await fetch(`${baseUrl}/price-performance/current-prices/stream`, { headers: signedIn(), signal: clientAbort.signal });
    await started;
    expect(producerSignal?.aborted).toBe(false);
    clientAbort.abort();
    await response.body?.cancel().catch(() => {});
    await producerFinished;
    expect(producerSignal?.aborted).toBe(true);
  });

  it("is refused without a session before any query or subscription", async () => {
    const response = await fetch(`${baseUrl}/price-performance/current-prices/stream`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not logged in." });
    expect(streamPooledStockPricesMock).not.toHaveBeenCalled();
  });
});
