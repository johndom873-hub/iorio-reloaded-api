import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real shortlistRouter on a small express app against the test database. Every IBKR / network boundary the router and the helpers
// it calls reach is mocked (symbol search, new-ticker lookup, the backfill pipeline, the shared read connection, daily-bar and
// option-chain fetches, earnings capture); tickers, shortlist entries, backfill runs and positions are real rows.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run shortlist route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 6 } }) };
});

const searchTickersMock = vi.fn();
vi.mock("../ibkr/searchTickers.js", () => ({ searchTickers: (...args: unknown[]) => searchTickersMock(...args) }));

const fetchNewTickerDataMock = vi.fn();
vi.mock("../ibkr/fetchNewTickerData.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/fetchNewTickerData.js")>("../ibkr/fetchNewTickerData.js");
  return { ...actual, fetchNewTickerData: (...args: unknown[]) => fetchNewTickerDataMock(...args) };
});

const recordPlutoEventMock = vi.fn();
vi.mock("../pluto/ledger.js", async () => {
  const actual = await vi.importActual<typeof import("../pluto/ledger.js")>("../pluto/ledger.js");
  return { ...actual, recordPlutoEvent: (...args: unknown[]) => recordPlutoEventMock(...args) };
});

const startTickerBackfillMock = vi.fn();
const fetchAndStoreFiveYearHistoryMock = vi.fn();
vi.mock("../ibkr/tickerBackfillPipeline.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/tickerBackfillPipeline.js")>("../ibkr/tickerBackfillPipeline.js");
  return {
    ...actual,
    startTickerBackfill: (...args: unknown[]) => startTickerBackfillMock(...args),
    fetchAndStoreFiveYearHistory: (...args: unknown[]) => fetchAndStoreFiveYearHistoryMock(...args),
  };
});

const topUpDailyBarsMock = vi.fn();
vi.mock("../ibkr/priceBarCache.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/priceBarCache.js")>("../ibkr/priceBarCache.js");
  return { ...actual, topUpDailyBars: (...args: unknown[]) => topUpDailyBarsMock(...args) };
});

const borrowSharedConnectionOrConnectMock = vi.fn();
const nextReqIdForMock = vi.fn();
const fakeSharedReadConnection = { label: "shared-read-connection" };
vi.mock("../ibkr/sharedReadConnection.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/sharedReadConnection.js")>("../ibkr/sharedReadConnection.js");
  return {
    ...actual,
    sharedReadConnection: fakeSharedReadConnection,
    borrowSharedConnectionOrConnect: (...args: unknown[]) => borrowSharedConnectionOrConnectMock(...args),
    nextReqIdFor: (...args: unknown[]) => nextReqIdForMock(...args),
  };
});

const refreshStoredOptionChainMock = vi.fn();
vi.mock("../ibkr/fetchOptionChain.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/fetchOptionChain.js")>("../ibkr/fetchOptionChain.js");
  return { ...actual, refreshStoredOptionChain: (...args: unknown[]) => refreshStoredOptionChainMock(...args) };
});

const captureHistoricalEarningsMock = vi.fn();
vi.mock("../lib/apiNinjasEarningsService.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiNinjasEarningsService.js")>("../lib/apiNinjasEarningsService.js");
  return { ...actual, captureHistoricalEarnings: (...args: unknown[]) => captureHistoricalEarningsMock(...args) };
});

const invalidatePricePerformanceSnapshotMock = vi.fn();
vi.mock("../lib/pricePerformanceSnapshot.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/pricePerformanceSnapshot.js")>("../lib/pricePerformanceSnapshot.js");
  return { ...actual, invalidatePricePerformanceSnapshot: () => invalidatePricePerformanceSnapshotMock() };
});

// Passes through to the real status query unless a test sets a plan.
const loadDailyBarsStatusMock = vi.fn();
const { loadDailyBarsStatus: actualLoadDailyBarsStatus } = await vi.importActual<typeof import("../lib/dailyBarsStatus.js")>("../lib/dailyBarsStatus.js");
vi.mock("../lib/dailyBarsStatus.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/dailyBarsStatus.js")>("../lib/dailyBarsStatus.js");
  return { ...actual, loadDailyBarsStatus: (...args: unknown[]) => loadDailyBarsStatusMock(...args) };
});

const { db } = await import("../db/connection.js");
const { shortlistRouter } = await import("./shortlist.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
let secondUserId: string;
const createdSymbols: string[] = [];
const createdPositionIds: string[] = [];
let symbolCounter = Date.now() % 100_000;

beforeAll(async () => {
  const label = `shortlist-route-${Date.now()}`;
  const [user, secondUser] = await testDb("users")
    .insert([
      { username: `${label}-1`, display_name: "Shortlist Tester One", password_hash: "not-a-real-hash" },
      { username: `${label}-2`, display_name: "Shortlist Tester Two", password_hash: "not-a-real-hash" },
    ])
    .returning("id");
  userId = user.id;
  secondUserId = secondUser.id;

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/shortlist", shortlistRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  searchTickersMock.mockReset().mockResolvedValue([]);
  fetchNewTickerDataMock.mockReset();
  recordPlutoEventMock.mockReset().mockResolvedValue(undefined);
  startTickerBackfillMock.mockReset().mockImplementation(async (tickerId: string) => fakeBackfillRun(tickerId));
  fetchAndStoreFiveYearHistoryMock.mockReset();
  topUpDailyBarsMock.mockReset();
  borrowSharedConnectionOrConnectMock.mockReset();
  nextReqIdForMock.mockReset().mockReturnValue(7);
  refreshStoredOptionChainMock.mockReset();
  captureHistoricalEarningsMock.mockReset();
  invalidatePricePerformanceSnapshotMock.mockReset();
  loadDailyBarsStatusMock.mockReset().mockImplementation(actualLoadDailyBarsStatus);
});

afterEach(async () => {
  vi.restoreAllMocks();
  const tickerIds = (await testDb("tickers").whereIn("symbol", createdSymbols).select("id")).map((row) => row.id);
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("daily_price_bars").whereIn("ticker_id", tickerIds).del();
  await testDb("market_data_snapshots").whereIn("ticker_id", tickerIds).del();
  await testDb("ticker_backfill_runs").whereIn("ticker_id", tickerIds).del();
  await testDb("shortlist_entries").whereIn("ticker_id", tickerIds).del();
  await testDb("tickers").whereIn("id", tickerIds).del();
  createdPositionIds.length = 0;
  createdSymbols.length = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("users").whereIn("id", [userId, secondUserId]).del();
  await testDb.destroy();
});

function fakeBackfillRun(tickerId: string) {
  return { id: "fake-run-id", tickerId, status: "running", steps: [], progressPercent: 0, startedAt: "2030-01-02T03:04:05.000Z", finishedAt: null };
}

// Third character is the ordering key: symbols sort by it regardless of the database's collation.
function newSymbol(orderingLetter = "A"): string {
  symbolCounter += 1;
  const symbol = `SL${orderingLetter}${symbolCounter}`;
  createdSymbols.push(symbol);
  return symbol;
}

async function insertTicker(overrides: Record<string, unknown> = {}): Promise<{ id: string; symbol: string }> {
  const symbol = (overrides.symbol as string | undefined) ?? newSymbol();
  const [ticker] = await testDb("tickers")
    .insert({ company_name: "Shortlist Test Co", sector: "Technology", ibkr_contract_id: 424242, primary_exchange: "NYSE", ...overrides, symbol })
    .returning(["id", "symbol"]);
  return ticker;
}

async function insertEntry(tickerId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const [entry] = await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: userId, ...overrides }).returning("id");
  return entry.id;
}

const completedSteps = [
  { key: "history", label: "History", status: "done", message: null },
  { key: "calendar", label: "Calendar", status: "done", message: null },
];

async function insertBackfillRun(tickerId: string, status: string, startedAt: Date, progressPercent = 0): Promise<string> {
  const [run] = await testDb("ticker_backfill_runs")
    .insert({ ticker_id: tickerId, status, steps: JSON.stringify(completedSteps), progress_percent: progressPercent, started_at: startedAt, finished_at: status === "running" ? null : startedAt })
    .returning("id");
  return run.id;
}

// Inserted as closed and flipped to open once its leg exists: another test file's reconciliation sweep closes any open position that has no open leg.
async function insertOpenPosition(tickerId: string): Promise<string> {
  const [position] = await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning("id");
  createdPositionIds.push(position.id);
  await testDb("position_legs").insert({ position_id: position.id, leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 10, entry_at: new Date(Date.now() - 86_400_000) });
  await testDb("positions").where({ id: position.id }).update({ status: "open", closed_at: null });
  return position.id;
}

const readEntries = (tickerId: string) => testDb("shortlist_entries").where({ ticker_id: tickerId }).orderBy("added_at");

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? userId : options.asUser;
  const response = await fetch(`${baseUrl}/shortlist${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(asUser ? { "x-test-user-id": asUser } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text, json: parseJsonOrNull(text) };
}

// Express's default error handler answers a 500 with HTML, and streamed routes answer event frames; neither is a JSON body.
function parseJsonOrNull(text: string): any {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function parseEventFrames(text: string): any[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice("data: ".length)));
}

async function callStreamed(path: string) {
  const response = await call("POST", path);
  expect(response.status).toBe(200);
  expect(response.contentType).toContain("text/event-stream");
  const frames = parseEventFrames(response.text);
  expect(frames).toHaveLength(1);
  return frames[0] as { status: number; body: any };
}

const unknownId = "00000000-0000-4000-8000-000000000000";

function fakeConnection() {
  const disconnect = vi.fn();
  const connection = { ib: { marker: "fake-ib" }, disconnect };
  borrowSharedConnectionOrConnectMock.mockResolvedValue(connection);
  return connection;
}

describe("authentication", () => {
  const routes: [string, string][] = [
    ["GET", "/search?q=a"],
    ["GET", "/"],
    ["POST", "/"],
    ["PATCH", `/${unknownId}`],
    ["DELETE", `/${unknownId}`],
    ["POST", `/${unknownId}/populate-earnings`],
    ["POST", `/${unknownId}/populate-daily-bars`],
    ["POST", `/${unknownId}/populate-option-chain`],
    ["GET", `/${unknownId}/backfill`],
    ["POST", `/${unknownId}/backfill`],
    ["GET", `/${unknownId}/backfill/stream`],
  ];

  it.each(routes)("%s %s is refused without a session", async (method, path) => {
    const response = await call(method as "GET", path, method === "POST" || method === "PATCH" ? {} : undefined, { asUser: null });
    expect(response.status).toBe(401);
    expect(response.json).toEqual({ error: "Not logged in." });
  });

  it("changes nothing for an unauthenticated add", async () => {
    const ticker = await insertTicker();
    await call("POST", "/", { symbol: ticker.symbol }, { asUser: null });
    expect(await readEntries(ticker.id)).toHaveLength(0);
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });
});

describe("GET /shortlist/search", () => {
  it("returns the matches for a trimmed query", async () => {
    const matches = [{ symbol: "AAPL", companyName: "Apple Inc." }, { symbol: "AAP", companyName: null }];
    searchTickersMock.mockResolvedValue(matches);

    const response = await call("GET", "/search?q=%20aap%20");
    expect(response).toMatchObject({ status: 200, json: matches });
    expect(searchTickersMock).toHaveBeenCalledWith("aap");
  });

  it.each([["no query", ""], ["an empty query", "?q="], ["a blank query", "?q=%20%20"]])("answers an empty list for %s without searching", async (_label, queryString) => {
    const response = await call("GET", `/search${queryString}`);
    expect(response).toMatchObject({ status: 200, json: [] });
    expect(searchTickersMock).not.toHaveBeenCalled();
  });
});

describe("GET /shortlist", () => {
  it("lists active entries with ticker details, ordered by symbol, and leaves out removed ones", async () => {
    const second = await insertTicker({ symbol: newSymbol("C"), company_name: "Second Co", sector: "Energy" });
    const first = await insertTicker({ symbol: newSymbol("B"), company_name: "First Co", sector: "Technology" });
    const removed = await insertTicker({ symbol: newSymbol("D") });
    const unlisted = await insertTicker({ symbol: newSymbol("E") });
    const firstEntryId = await insertEntry(first.id, { signals_enabled: true, bot_enabled: true });
    const secondEntryId = await insertEntry(second.id);
    await insertEntry(removed.id, { removed_at: new Date() });

    const { status, json } = await call("GET", "/");
    expect(status).toBe(200);
    const mine = (json as { symbol: string }[]).filter((row) => createdSymbols.includes(row.symbol));
    expect(mine.map((row) => row.symbol)).toEqual([first.symbol, second.symbol]);
    expect(mine[0]).toMatchObject({
      id: firstEntryId,
      addedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      signalsEnabled: true,
      botEnabled: true,
      tickerId: first.id,
      symbol: first.symbol,
      companyName: "First Co",
      sector: "Technology",
      backfillStatus: null,
      backfillProgressPercent: null,
      backfillNeedsRetry: false,
      openPositionCount: 0,
    });
    expect(mine[1]).toMatchObject({ id: secondEntryId, signalsEnabled: false, botEnabled: false, sector: "Energy" });
    expect(mine[0]).not.toHaveProperty("notes");
    expect((json as { symbol: string }[]).map((row) => row.symbol)).not.toContain(unlisted.symbol);
  });

  it("carries the data-readiness facts Signals reads", async () => {
    const ticker = await insertTicker({ sector: "ETF" });
    await insertEntry(ticker.id);
    await testDb("daily_price_bars").insert([
      { ticker_id: ticker.id, trading_date: "2024-01-02", close_price: 10 },
      { ticker_id: ticker.id, trading_date: "2024-01-03", close_price: 11 },
      { ticker_id: ticker.id, trading_date: "2024-01-04", close_price: 12 },
    ]);

    const row = ((await call("GET", "/")).json as any[]).find((entry) => entry.symbol === ticker.symbol);
    expect(row).toMatchObject({
      isEtf: true,
      dailyBarCount: 3,
      historyStartDate: "2024-01-02",
      latestDailyBarDate: "2024-01-04",
      dailyBarsPlan: "full",
      earningsCount: 0,
      nextEarningsDateIso: null,
      dividendHistoryCount: 0,
      chainSnapshotCount: 0,
      latestFittedSliceCount: null,
      latestTotalSliceCount: null,
      optionChainExpiries: [],
    });
    expect(row.lastCompletedSessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reports a blank sector as null and a non-ETF as not an ETF", async () => {
    const ticker = await insertTicker({ sector: "" });
    await insertEntry(ticker.id);

    const row = ((await call("GET", "/")).json as any[]).find((entry) => entry.symbol === ticker.symbol);
    expect(row).toMatchObject({ sector: null, isEtf: false });
  });

  it("counts only open positions on the ticker", async () => {
    const ticker = await insertTicker();
    await insertEntry(ticker.id);
    await insertOpenPosition(ticker.id);
    await insertOpenPosition(ticker.id);
    const [closedPosition] = await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "closed", closed_at: new Date() }).returning("id");
    createdPositionIds.push(closedPosition.id);

    const row = ((await call("GET", "/")).json as any[]).find((entry) => entry.symbol === ticker.symbol);
    expect(row.openPositionCount).toBe(2);
    expect(typeof row.openPositionCount).toBe("number");
  });

  it("shows a fresh running backfill as preparing with its progress", async () => {
    const ticker = await insertTicker();
    await insertEntry(ticker.id);
    await insertBackfillRun(ticker.id, "running", new Date(Date.now() - 60_000), 50);

    const row = ((await call("GET", "/")).json as any[]).find((entry) => entry.symbol === ticker.symbol);
    expect(row).toMatchObject({ backfillStatus: "preparing", backfillProgressPercent: 50, backfillNeedsRetry: false });
  });

  it("does not call a running backfill older than the stale window preparing", async () => {
    const ticker = await insertTicker();
    await insertEntry(ticker.id);
    await insertBackfillRun(ticker.id, "running", new Date(Date.now() - 31 * 60_000), 25);

    const row = ((await call("GET", "/")).json as any[]).find((entry) => entry.symbol === ticker.symbol);
    expect(row).toMatchObject({ backfillStatus: null, backfillProgressPercent: 25, backfillNeedsRetry: false });
  });

  it("offers a retry after a partial run and none after a complete one", async () => {
    const partial = await insertTicker();
    const complete = await insertTicker();
    await insertEntry(partial.id);
    await insertEntry(complete.id);
    await insertBackfillRun(partial.id, "partial", new Date(Date.now() - 3600_000), 75);
    await insertBackfillRun(complete.id, "complete", new Date(Date.now() - 3600_000), 100);

    const rows = (await call("GET", "/")).json as any[];
    expect(rows.find((entry) => entry.symbol === partial.symbol)).toMatchObject({ backfillNeedsRetry: true, backfillStatus: null });
    expect(rows.find((entry) => entry.symbol === complete.symbol)).toMatchObject({ backfillNeedsRetry: false, backfillProgressPercent: 100 });
  });

  it("looks only at the latest backfill run", async () => {
    const ticker = await insertTicker();
    await insertEntry(ticker.id);
    await insertBackfillRun(ticker.id, "partial", new Date(Date.now() - 7200_000), 40);
    await insertBackfillRun(ticker.id, "complete", new Date(Date.now() - 3600_000), 100);

    const row = ((await call("GET", "/")).json as any[]).find((entry) => entry.symbol === ticker.symbol);
    expect(row).toMatchObject({ backfillNeedsRetry: false, backfillProgressPercent: 100 });
  });
});

describe("POST /shortlist", () => {
  it("adds an existing ticker, records who added it, starts the backfill and answers 201 with the row", async () => {
    const ticker = await insertTicker({ company_name: "Existing Co", sector: "Technology" });

    const { status, json } = await call("POST", "/", { symbol: ticker.symbol });
    expect(status).toBe(201);
    expect(json).toMatchObject({
      id: expect.any(String),
      addedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      signalsEnabled: false,
      botEnabled: false,
      backfillRun: fakeBackfillRun(ticker.id),
      tickerId: ticker.id,
      symbol: ticker.symbol,
      companyName: "Existing Co",
      sector: "Technology",
      openPositionCount: 0,
      dailyBarCount: 0,
      isEtf: false,
      optionChainExpiries: [],
    });
    const entries = await readEntries(ticker.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: json.id, added_by_user_id: userId, signals_enabled: false, bot_enabled: false, removed_at: null });
    expect(startTickerBackfillMock).toHaveBeenCalledTimes(1);
    expect(startTickerBackfillMock).toHaveBeenCalledWith(ticker.id, ticker.symbol);
    expect(invalidatePricePerformanceSnapshotMock).toHaveBeenCalled();
    expect(fetchNewTickerDataMock).not.toHaveBeenCalled();
  });

  it("records the session user as the one who added it", async () => {
    const ticker = await insertTicker();
    await call("POST", "/", { symbol: ticker.symbol }, { asUser: secondUserId });
    expect((await readEntries(ticker.id))[0]).toMatchObject({ added_by_user_id: secondUserId });
  });

  it("trims and upper-cases the symbol before looking it up", async () => {
    const ticker = await insertTicker();
    const { status, json } = await call("POST", "/", { symbol: `  ${ticker.symbol.toLowerCase()}  ` });
    expect(status).toBe(201);
    expect(json.symbol).toBe(ticker.symbol);
    expect(json.tickerId).toBe(ticker.id);
  });

  it.each([["no body fields", {}], ["an empty symbol", { symbol: "" }], ["a blank symbol", { symbol: "   " }]])("refuses %s with a 400 and starts nothing", async (_label, body) => {
    const response = await call("POST", "/", body);
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: "Symbol is required." });
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
    expect(fetchNewTickerDataMock).not.toHaveBeenCalled();
  });

  it("adds with Signals on when asked", async () => {
    const ticker = await insertTicker();

    expect((await call("POST", "/", { symbol: ticker.symbol, signalsEnabled: true })).json).toMatchObject({ signalsEnabled: true, botEnabled: false });
    expect((await readEntries(ticker.id))[0]).toMatchObject({ signals_enabled: true });
  });

  it.each([["a string", "yes"], ["a number", 1], ["null", null]])("refuses signalsEnabled as %s with a 400 and stores nothing", async (_label, signalsEnabled) => {
    const ticker = await insertTicker();

    expect(await call("POST", "/", { symbol: ticker.symbol, signalsEnabled })).toMatchObject({ status: 400, json: { error: "signalsEnabled must be true or false." } });
    expect(await readEntries(ticker.id)).toHaveLength(0);
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });

  it("reports a ticker with no sector as null and an ETF as an ETF", async () => {
    const noSector = await insertTicker({ sector: "" });
    const etf = await insertTicker({ sector: "ETF" });

    expect((await call("POST", "/", { symbol: noSector.symbol })).json).toMatchObject({ sector: null, isEtf: false });
    expect((await call("POST", "/", { symbol: etf.symbol })).json).toMatchObject({ sector: "ETF", isEtf: true });
  });

  it("reports the ticker's open position count", async () => {
    const ticker = await insertTicker();
    await insertOpenPosition(ticker.id);

    expect((await call("POST", "/", { symbol: ticker.symbol })).json.openPositionCount).toBe(1);
  });

  it("creates an unknown ticker from IBKR's contract data, with today's first market-data snapshot", async () => {
    const symbol = newSymbol();
    fetchNewTickerDataMock.mockResolvedValue({ companyName: "Brand New Inc.", sector: "Healthcare", conId: 987654, primaryExchange: "NASDAQ", impliedVolatility: 0.31, avgOptionVolume: 1234 });

    const { status, json } = await call("POST", "/", { symbol: symbol.toLowerCase() });
    expect(status).toBe(201);
    expect(fetchNewTickerDataMock).toHaveBeenCalledWith(symbol);
    expect(json).toMatchObject({ symbol, companyName: "Brand New Inc.", sector: "Healthcare" });

    const ticker = await testDb("tickers").where({ symbol }).first();
    expect(ticker).toMatchObject({ company_name: "Brand New Inc.", sector: "Healthcare", ibkr_contract_id: 987654, primary_exchange: "NASDAQ" });
    expect(json.tickerId).toBe(ticker.id);
    const snapshots = await testDb("market_data_snapshots").where({ ticker_id: ticker.id });
    expect(snapshots).toHaveLength(1);
    expect(Number(snapshots[0].implied_volatility)).toBeCloseTo(0.31);
    expect(Number(snapshots[0].avg_option_volume)).toBe(1234);
    expect(await readEntries(ticker.id)).toHaveLength(1);
    expect(startTickerBackfillMock).toHaveBeenCalledWith(ticker.id, symbol);
  });

  it("answers 422 for a symbol IBKR does not recognise and stores nothing", async () => {
    const symbol = newSymbol();
    fetchNewTickerDataMock.mockResolvedValue({ companyName: null, sector: null, conId: null, primaryExchange: null, impliedVolatility: null, avgOptionVolume: null });

    const { status, json } = await call("POST", "/", { symbol });
    expect(status).toBe(422);
    expect(json).toEqual({ error: `${symbol} is not a symbol IBKR recognises — check the spelling (or IBKR did not answer in time; try again).` });
    expect(await testDb("tickers").where({ symbol })).toHaveLength(0);
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });

  it("answers 500 and stores nothing when the IBKR lookup itself fails", async () => {
    const symbol = newSymbol();
    fetchNewTickerDataMock.mockRejectedValue(new Error("gateway timeout"));

    expect((await call("POST", "/", { symbol })).status).toBe(500);
    expect(await testDb("tickers").where({ symbol })).toHaveLength(0);
  });

  it("answers 409 for a ticker that is already being monitored and keeps the original entry", async () => {
    const ticker = await insertTicker();
    const originalEntryId = await insertEntry(ticker.id, { signals_enabled: true });

    const { status, json } = await call("POST", "/", { symbol: ticker.symbol });
    expect(status).toBe(409);
    expect(json).toEqual({ error: `${ticker.symbol} is already being monitored.` });
    const entries = await readEntries(ticker.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: originalEntryId, signals_enabled: true });
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });

  it("lets only one of two simultaneous adds of the same ticker through", async () => {
    const ticker = await insertTicker();

    const responses = await Promise.all([call("POST", "/", { symbol: ticker.symbol }), call("POST", "/", { symbol: ticker.symbol })]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await readEntries(ticker.id)).filter((entry) => entry.removed_at === null)).toHaveLength(1);
  });

  it("still answers 201 with a null backfill run when the backfill cannot start", async () => {
    const ticker = await insertTicker();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startTickerBackfillMock.mockRejectedValue(new Error("queue unavailable"));

    const { status, json } = await call("POST", "/", { symbol: ticker.symbol });
    expect(status).toBe(201);
    expect(json.backfillRun).toBeNull();
    expect(await readEntries(ticker.id)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`backfill for ${ticker.symbol} could not start`));
  });

  it("can add a ticker again after it was removed, as a new entry that keeps the old one", async () => {
    const ticker = await insertTicker();
    const first = await call("POST", "/", { symbol: ticker.symbol, signalsEnabled: true });
    expect((await call("DELETE", `/${first.json.id}`)).status).toBe(204);

    const second = await call("POST", "/", { symbol: ticker.symbol }, { asUser: secondUserId });
    expect(second.status).toBe(201);
    expect(second.json.id).not.toBe(first.json.id);
    expect(second.json.signalsEnabled).toBe(false);

    const entries = await readEntries(ticker.id);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: first.json.id, added_by_user_id: userId, signals_enabled: true });
    expect(entries[0]?.removed_at).not.toBeNull();
    expect(entries[1]).toMatchObject({ id: second.json.id, added_by_user_id: secondUserId, signals_enabled: false, removed_at: null });
    expect(startTickerBackfillMock).toHaveBeenCalledTimes(2);
  });

  it("then lists the re-added ticker once", async () => {
    const ticker = await insertTicker();
    const first = await call("POST", "/", { symbol: ticker.symbol });
    await call("DELETE", `/${first.json.id}`);
    await call("POST", "/", { symbol: ticker.symbol });

    const rows = ((await call("GET", "/")).json as any[]).filter((row) => row.symbol === ticker.symbol);
    expect(rows).toHaveLength(1);
  });
});

describe("PATCH /shortlist/:id/signals-enabled", () => {
  it("turns Signals on and starts only the option-chain setup", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);

    expect(await call("PATCH", `/${entryId}/signals-enabled`, { enabled: true })).toMatchObject({ status: 200, json: { signalsEnabled: true, botEnabled: false, backfillRun: fakeBackfillRun(ticker.id) } });
    expect((await readEntries(ticker.id))[0]).toMatchObject({ signals_enabled: true, bot_enabled: false });
    expect(startTickerBackfillMock).toHaveBeenCalledTimes(1);
    expect(startTickerBackfillMock).toHaveBeenCalledWith(ticker.id, ticker.symbol, undefined, "option_chain");
  });

  it("starts no setup when Signals was already on, and keeps Pluto as it was", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id, { signals_enabled: true, bot_enabled: true });

    expect(await call("PATCH", `/${entryId}/signals-enabled`, { enabled: true })).toMatchObject({ status: 200, json: { signalsEnabled: true, botEnabled: true, backfillRun: null } });
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });

  it("turning Signals off also turns Pluto off, records who did it, and logs the Pluto change", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id, { signals_enabled: true, bot_enabled: true });

    expect(await call("PATCH", `/${entryId}/signals-enabled`, { enabled: false }, { asUser: secondUserId })).toMatchObject({ status: 200, json: { signalsEnabled: false, botEnabled: false, backfillRun: null } });
    const entry = (await readEntries(ticker.id))[0];
    expect(entry).toMatchObject({ signals_enabled: false, bot_enabled: false, bot_enabled_changed_by_user_id: secondUserId });
    expect(entry?.bot_enabled_changed_at).not.toBeNull();
    expect(recordPlutoEventMock).toHaveBeenCalledWith("ticker_disabled", { symbol: ticker.symbol, by: "Shortlist Tester Two (turned Signals off)" });
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });

  it("turning Signals off with Pluto already off logs no Pluto change and leaves its audit alone", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id, { signals_enabled: true });

    expect((await call("PATCH", `/${entryId}/signals-enabled`, { enabled: false })).json).toMatchObject({ signalsEnabled: false, botEnabled: false });
    expect((await readEntries(ticker.id))[0]).toMatchObject({ signals_enabled: false, bot_enabled_changed_by_user_id: null, bot_enabled_changed_at: null });
    expect(recordPlutoEventMock).not.toHaveBeenCalled();
  });

  it("still answers 200 with a null run when the option-chain setup cannot start", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    startTickerBackfillMock.mockRejectedValue(new Error("queue unavailable"));

    expect(await call("PATCH", `/${entryId}/signals-enabled`, { enabled: true })).toMatchObject({ status: 200, json: { signalsEnabled: true, backfillRun: null } });
    expect((await readEntries(ticker.id))[0]).toMatchObject({ signals_enabled: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`option-chain setup for ${ticker.symbol} could not start`));
  });

  it.each([["no body", undefined], ["a string", { enabled: "true" }], ["null", { enabled: null }]])("refuses %s with a 400", async (_label, body) => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);

    expect(await call("PATCH", `/${entryId}/signals-enabled`, body)).toMatchObject({ status: 400, json: { error: "enabled must be true or false." } });
    expect((await readEntries(ticker.id))[0]).toMatchObject({ signals_enabled: false });
  });

  it("answers 404 for an unknown or removed entry and changes nothing", async () => {
    const ticker = await insertTicker();
    const removedEntryId = await insertEntry(ticker.id, { removed_at: new Date() });

    expect(await call("PATCH", `/${unknownId}/signals-enabled`, { enabled: true })).toMatchObject({ status: 404, json: { error: "Entry not found or already removed." } });
    expect((await call("PATCH", `/${removedEntryId}/signals-enabled`, { enabled: true })).status).toBe(404);
    expect((await readEntries(ticker.id))[0]).toMatchObject({ signals_enabled: false });
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });

  it("the notes route is gone", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);

    expect((await call("PATCH", `/${entryId}`, { notes: "x" })).status).toBe(404);
  });
});

describe("PATCH /shortlist/:id/bot-enabled", () => {
  it("refuses to turn Pluto on while Signals is off, and changes nothing", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);

    expect(await call("PATCH", `/${entryId}/bot-enabled`, { enabled: true })).toMatchObject({
      status: 409,
      json: { error: `Turn Signals on for ${ticker.symbol} first: Pluto only trades Signals tickers.` },
    });
    expect((await readEntries(ticker.id))[0]).toMatchObject({ bot_enabled: false });
    expect(recordPlutoEventMock).not.toHaveBeenCalled();
  });

  it("turns Pluto on for a Signals ticker", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id, { signals_enabled: true });

    expect(await call("PATCH", `/${entryId}/bot-enabled`, { enabled: true })).toMatchObject({ status: 200, json: { botEnabled: true } });
    expect((await readEntries(ticker.id))[0]).toMatchObject({ bot_enabled: true });
  });
});

describe("DELETE /shortlist/:id", () => {
  it("soft-removes the entry, keeps the row, and refreshes the price-performance cache", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);

    const response = await call("DELETE", `/${entryId}`);
    expect(response.status).toBe(204);
    expect(response.text).toBe("");
    const entries = await readEntries(ticker.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.removed_at).toBeInstanceOf(Date);
    expect(invalidatePricePerformanceSnapshotMock).toHaveBeenCalledTimes(1);
    expect(((await call("GET", "/")).json as any[]).map((row) => row.symbol)).not.toContain(ticker.symbol);
  });

  it("answers 404 for an unknown entry", async () => {
    expect(await call("DELETE", `/${unknownId}`)).toMatchObject({ status: 404, json: { error: "Entry not found or already removed." } });
    expect(invalidatePricePerformanceSnapshotMock).not.toHaveBeenCalled();
  });

  it("answers 404 when the entry was already removed and keeps its original removal time", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);
    await call("DELETE", `/${entryId}`);
    const removedAt = (await readEntries(ticker.id))[0]?.removed_at;
    invalidatePricePerformanceSnapshotMock.mockClear();

    expect((await call("DELETE", `/${entryId}`)).status).toBe(404);
    expect((await readEntries(ticker.id))[0]?.removed_at).toEqual(removedAt);
    expect(invalidatePricePerformanceSnapshotMock).not.toHaveBeenCalled();
  });

  it("refuses with a 409 while the ticker has one open position and keeps the entry", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);
    await insertOpenPosition(ticker.id);

    const { status, json } = await call("DELETE", `/${entryId}`);
    expect(status).toBe(409);
    expect(json).toEqual({ error: "1 open position on this ticker. Close it before removing." });
    expect((await readEntries(ticker.id))[0]?.removed_at).toBeNull();
    expect(invalidatePricePerformanceSnapshotMock).not.toHaveBeenCalled();
  });

  it("names the count when several positions are open", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);
    await insertOpenPosition(ticker.id);
    await insertOpenPosition(ticker.id);

    expect((await call("DELETE", `/${entryId}`)).json).toEqual({ error: "2 open positions on this ticker. Close them before removing." });
  });

  it("is not blocked by a closed position", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);
    const [closedPosition] = await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "closed", closed_at: new Date() }).returning("id");
    createdPositionIds.push(closedPosition.id);

    expect((await call("DELETE", `/${entryId}`)).status).toBe(204);
  });

  it("can be removed once the open position is closed", async () => {
    const ticker = await insertTicker();
    const entryId = await insertEntry(ticker.id);
    const positionId = await insertOpenPosition(ticker.id);
    expect((await call("DELETE", `/${entryId}`)).status).toBe(409);

    await testDb("positions").where({ id: positionId }).update({ status: "closed", closed_at: new Date() });
    expect((await call("DELETE", `/${entryId}`)).status).toBe(204);
  });
});

describe("POST /shortlist/:tickerId/populate-earnings", () => {
  it("captures the earnings history for the ticker and passes the result through", async () => {
    const ticker = await insertTicker();
    captureHistoricalEarningsMock.mockResolvedValue({ written: 12, skippedEtf: false });

    expect(await call("POST", `/${ticker.id}/populate-earnings`)).toMatchObject({ status: 200, json: { written: 12, skippedEtf: false } });
    expect(captureHistoricalEarningsMock).toHaveBeenCalledWith(ticker.id, ticker.symbol);
  });

  it("passes an ETF's no-op result through", async () => {
    const ticker = await insertTicker({ sector: "ETF" });
    captureHistoricalEarningsMock.mockResolvedValue({ written: 0, skippedEtf: true });

    expect((await call("POST", `/${ticker.id}/populate-earnings`)).json).toEqual({ written: 0, skippedEtf: true });
  });

  it("answers 404 for an unknown ticker without capturing anything", async () => {
    expect(await call("POST", `/${unknownId}/populate-earnings`)).toMatchObject({ status: 404, json: { error: "Ticker not found." } });
    expect(captureHistoricalEarningsMock).not.toHaveBeenCalled();
  });

  it("answers 500 when the capture fails", async () => {
    const ticker = await insertTicker();
    captureHistoricalEarningsMock.mockRejectedValue(new Error("api-ninjas down"));
    expect((await call("POST", `/${ticker.id}/populate-earnings`)).status).toBe(500);
  });
});

describe("POST /shortlist/:tickerId/populate-daily-bars", () => {
  it("answers 404 as a plain response for an unknown ticker", async () => {
    const response = await call("POST", `/${unknownId}/populate-daily-bars`);
    expect(response).toMatchObject({ status: 404, json: { error: "Ticker not found." } });
    expect(response.contentType).toContain("application/json");
    expect(borrowSharedConnectionOrConnectMock).not.toHaveBeenCalled();
  });

  it("does nothing when the stored bars are current", async () => {
    const ticker = await insertTicker();
    loadDailyBarsStatusMock.mockResolvedValue({ dailyBarsPlan: "none" });

    expect(await callStreamed(`/${ticker.id}/populate-daily-bars`)).toEqual({ status: 200, body: { plan: "none" } });
    expect(loadDailyBarsStatusMock).toHaveBeenCalledWith(ticker.id);
    expect(borrowSharedConnectionOrConnectMock).not.toHaveBeenCalled();
    expect(invalidatePricePerformanceSnapshotMock).not.toHaveBeenCalled();
  });

  it("fetches the full five years when the plan says full, then releases the connection and refreshes the cache", async () => {
    const ticker = await insertTicker();
    const connection = fakeConnection();
    loadDailyBarsStatusMock.mockResolvedValue({ dailyBarsPlan: "full" });
    fetchAndStoreFiveYearHistoryMock.mockResolvedValue({ barCount: 1250, ivPointCount: 1200 });

    expect(await callStreamed(`/${ticker.id}/populate-daily-bars`)).toEqual({ status: 200, body: { plan: "full", barCount: 1250, ivPointCount: 1200 } });
    expect(borrowSharedConnectionOrConnectMock).toHaveBeenCalledWith(fakeSharedReadConnection, "populate-daily-bars");
    expect(fetchAndStoreFiveYearHistoryMock).toHaveBeenCalledWith(connection, ticker.id, ticker.symbol, { reqId: 7 });
    expect(topUpDailyBarsMock).not.toHaveBeenCalled();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(invalidatePricePerformanceSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("fetches only the missing sessions when the plan says top up", async () => {
    const ticker = await insertTicker();
    const connection = fakeConnection();
    loadDailyBarsStatusMock.mockResolvedValue({ dailyBarsPlan: "topUp" });
    topUpDailyBarsMock.mockResolvedValue({ barsFetched: 3 });

    expect(await callStreamed(`/${ticker.id}/populate-daily-bars`)).toEqual({ status: 200, body: { plan: "topUp", barsFetched: 3 } });
    expect(topUpDailyBarsMock).toHaveBeenCalledWith(connection, ticker.id, ticker.symbol, 7);
    expect(fetchAndStoreFiveYearHistoryMock).not.toHaveBeenCalled();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it("decides the plan from the stored data: a ticker with no bars gets the full fetch", async () => {
    const ticker = await insertTicker();
    fakeConnection();
    fetchAndStoreFiveYearHistoryMock.mockResolvedValue({ barCount: 0 });

    expect((await callStreamed(`/${ticker.id}/populate-daily-bars`)).body.plan).toBe("full");
  });

  it("answers a 500 frame and still releases the connection when the fetch fails", async () => {
    const ticker = await insertTicker();
    const connection = fakeConnection();
    loadDailyBarsStatusMock.mockResolvedValue({ dailyBarsPlan: "full" });
    fetchAndStoreFiveYearHistoryMock.mockRejectedValue(new Error("pacing violation"));

    expect(await callStreamed(`/${ticker.id}/populate-daily-bars`)).toEqual({ status: 500, body: { error: "pacing violation" } });
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(invalidatePricePerformanceSnapshotMock).not.toHaveBeenCalled();
  });

  it("answers a 500 frame when no connection can be borrowed", async () => {
    const ticker = await insertTicker();
    loadDailyBarsStatusMock.mockResolvedValue({ dailyBarsPlan: "topUp" });
    borrowSharedConnectionOrConnectMock.mockRejectedValue(new Error("Gateway unreachable"));

    expect(await callStreamed(`/${ticker.id}/populate-daily-bars`)).toEqual({ status: 500, body: { error: "Gateway unreachable" } });
  });
});

describe("POST /shortlist/:tickerId/populate-option-chain", () => {
  it("answers 404 as a plain response for an unknown ticker", async () => {
    expect(await call("POST", `/${unknownId}/populate-option-chain`)).toMatchObject({ status: 404, json: { error: "Ticker not found." } });
  });

  it("answers 400 as a plain response for a ticker with no IBKR contract id", async () => {
    const ticker = await insertTicker({ ibkr_contract_id: null });

    const response = await call("POST", `/${ticker.id}/populate-option-chain`);
    expect(response).toMatchObject({ status: 400, json: { error: "Ticker has no IBKR contract id stored." } });
    expect(response.contentType).toContain("application/json");
    expect(borrowSharedConnectionOrConnectMock).not.toHaveBeenCalled();
  });

  it("refreshes the stored chain for the ticker and answers the per-expiry strike counts sorted by expiry", async () => {
    const ticker = await insertTicker({ ibkr_contract_id: 555111 });
    const connection = fakeConnection();
    refreshStoredOptionChainMock.mockResolvedValue({
      strikesByExpiry: new Map([
        ["2030-03-15", [100, 105, 110]],
        ["2030-02-15", [100, 105]],
        ["2030-04-19", []],
      ]),
    });

    expect(await callStreamed(`/${ticker.id}/populate-option-chain`)).toEqual({
      status: 200,
      body: {
        optionChainExpiries: [
          { expiry: "2030-02-15", strikeCount: 2 },
          { expiry: "2030-03-15", strikeCount: 3 },
          { expiry: "2030-04-19", strikeCount: 0 },
        ],
      },
    });
    expect(borrowSharedConnectionOrConnectMock).toHaveBeenCalledWith(fakeSharedReadConnection, "populate-option-chain");
    expect(refreshStoredOptionChainMock).toHaveBeenCalledWith(connection.ib, { tickerId: ticker.id, symbol: ticker.symbol, contractId: 555111 }, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it("answers an empty list when nothing is in the capture window", async () => {
    const ticker = await insertTicker();
    fakeConnection();
    refreshStoredOptionChainMock.mockResolvedValue({ strikesByExpiry: new Map() });

    expect((await callStreamed(`/${ticker.id}/populate-option-chain`)).body).toEqual({ optionChainExpiries: [] });
  });

  it("answers a 500 frame and still releases the connection when the refresh fails", async () => {
    const ticker = await insertTicker();
    const connection = fakeConnection();
    refreshStoredOptionChainMock.mockRejectedValue(new Error("contract details timed out"));

    expect(await callStreamed(`/${ticker.id}/populate-option-chain`)).toEqual({ status: 500, body: { error: "contract details timed out" } });
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("backfill progress routes", () => {
  it("GET answers null for a ticker that never had a run", async () => {
    const ticker = await insertTicker();
    expect(await call("GET", `/${ticker.id}/backfill`)).toMatchObject({ status: 200, json: null });
  });

  it("GET answers the latest run", async () => {
    const ticker = await insertTicker();
    await insertBackfillRun(ticker.id, "partial", new Date("2030-01-01T00:00:00.000Z"), 25);
    const latestId = await insertBackfillRun(ticker.id, "complete", new Date("2030-01-02T03:04:05.000Z"), 100);

    expect((await call("GET", `/${ticker.id}/backfill`)).json).toEqual({
      id: latestId,
      tickerId: ticker.id,
      status: "complete",
      steps: completedSteps,
      progressPercent: 100,
      startedAt: "2030-01-02T03:04:05.000Z",
      finishedAt: "2030-01-02T03:04:05.000Z",
    });
  });

  it("GET reports a running run that is long dead as partial", async () => {
    const ticker = await insertTicker();
    await insertBackfillRun(ticker.id, "running", new Date(Date.now() - 45 * 60_000), 25);

    expect((await call("GET", `/${ticker.id}/backfill`)).json).toMatchObject({ status: "partial", finishedAt: null });
  });

  it("POST answers 202 with the started (or joined) run", async () => {
    const ticker = await insertTicker();

    expect(await call("POST", `/${ticker.id}/backfill`)).toMatchObject({ status: 202, json: fakeBackfillRun(ticker.id) });
    expect(startTickerBackfillMock).toHaveBeenCalledWith(ticker.id, ticker.symbol);
  });

  it("POST answers 404 for an unknown ticker and starts nothing", async () => {
    expect(await call("POST", `/${unknownId}/backfill`)).toMatchObject({ status: 404, json: { error: "Ticker not found." } });
    expect(startTickerBackfillMock).not.toHaveBeenCalled();
  });

  it("the stream sends null once for a ticker without a run and ends", async () => {
    const ticker = await insertTicker();

    const response = await call("GET", `/${ticker.id}/backfill/stream`);
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/event-stream");
    expect(parseEventFrames(response.text)).toEqual([null]);
  });

  it("the stream sends a finished run once and ends", async () => {
    const ticker = await insertTicker();
    const runId = await insertBackfillRun(ticker.id, "complete", new Date("2030-01-02T03:04:05.000Z"), 100);

    const frames = parseEventFrames((await call("GET", `/${ticker.id}/backfill/stream`)).text);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: runId, status: "complete", progressPercent: 100 });
  });

  it("the stream follows a running run and ends with the finished state", async () => {
    const ticker = await insertTicker();
    const runId = await insertBackfillRun(ticker.id, "running", new Date(), 50);
    setTimeout(async () => {
      await testDb("ticker_backfill_runs").where({ id: runId }).update({ status: "complete", progress_percent: 100, finished_at: new Date() });
    }, 300);

    const frames = parseEventFrames((await call("GET", `/${ticker.id}/backfill/stream`)).text);
    expect(frames.map((frame) => [frame.status, frame.progressPercent])).toEqual([["running", 50], ["complete", 100]]);
  });
});
