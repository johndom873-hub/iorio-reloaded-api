import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";
import { OptionType } from "@stoqey/ib";

// The real positionsRouter on a small express app against the test database, for the read routes (listing, cycles, pulse history), the P&L and
// Greeks routes (REST and SSE) and the quote streams. Every IBKR / pool boundary is mocked: the SSE producers are scripted, so nothing
// network-bound runs and the streams' own first-event, fallback and never-regress rules are what is under test.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run positions read route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 6 } }) };
});

vi.mock("../lib/tradingGate.js", () => ({ fetchTradingBlockedReason: async () => null }));
vi.mock("../lib/deltaBandGate.js", () => ({ evaluateDeltaBandForOrderRequest: async () => null }));
vi.mock("../lib/limitPriceCheckGate.js", () => ({ evaluateLimitPriceCheckForOrderRequest: async () => ({ blocked: false, reasons: [], legs: [] }) }));
vi.mock("../lib/closeGate.js", () => ({ evaluateCloseGateForPosition: async () => ({ blocked: false, reason: null, cycleTotal: 0 }) }));
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: async () => undefined }));

const evaluateOrderLimitsMock = vi.fn();
vi.mock("../lib/orderLimits.js", () => ({ evaluateOrderLimits: (...args: unknown[]) => evaluateOrderLimitsMock(...args) }));

const fetchPricesPoolFirstMock = vi.fn();
const streamPooledPricesMock = vi.fn();
const subscribeToPooledPriceMock = vi.fn();
vi.mock("../ibkr/pricePool.js", () => ({
  fetchPricesPoolFirst: (...args: unknown[]) => fetchPricesPoolFirstMock(...args),
  streamPooledPrices: (...args: unknown[]) => streamPooledPricesMock(...args),
  subscribeToPooledPrice: (...args: unknown[]) => subscribeToPooledPriceMock(...args),
}));

const fetchGreeksPoolFirstMock = vi.fn();
const streamPooledGreeksMock = vi.fn();
vi.mock("../ibkr/greeksPool.js", () => ({
  fetchGreeksPoolFirst: (...args: unknown[]) => fetchGreeksPoolFirstMock(...args),
  streamPooledGreeks: (...args: unknown[]) => streamPooledGreeksMock(...args),
}));

const streamOrderLegQuoteMock = vi.fn();
const checkDeltaComplianceMock = vi.fn();
vi.mock("../ibkr/streamOrderLegQuote.js", () => ({
  streamOrderLegQuote: (...args: unknown[]) => streamOrderLegQuoteMock(...args),
  checkDeltaCompliance: (...args: unknown[]) => checkDeltaComplianceMock(...args),
}));

const evaluateRecoveryPathForPositionMock = vi.fn();
vi.mock("../ibkr/evaluateRecoveryPathForPosition.js", () => ({ evaluateRecoveryPathForPosition: (...args: unknown[]) => evaluateRecoveryPathForPositionMock(...args) }));

const recordUnrealizedPnlSampleMock = vi.fn();
const recordLegDeltaSampleMock = vi.fn();
vi.mock("../lib/pulseChartSampleCollector.js", () => ({
  recordUnrealizedPnlSample: (...args: unknown[]) => recordUnrealizedPnlSampleMock(...args),
  recordLegDeltaSample: (...args: unknown[]) => recordLegDeltaSampleMock(...args),
}));

const getRiskFreeRateMock = vi.fn();
vi.mock("../lib/riskFreeRate.js", () => ({ getRiskFreeRate: (...args: unknown[]) => getRiskFreeRateMock(...args) }));

const computeLegSuccessProbabilitiesMock = vi.fn();
vi.mock("../lib/positionSuccessProbability.js", () => ({ computeLegSuccessProbabilities: (...args: unknown[]) => computeLegSuccessProbabilitiesMock(...args) }));

const loadRecoveryTargetWindowMock = vi.fn();
vi.mock("../lib/recoveryTargetWindow.js", () => ({ loadRecoveryTargetWindow: (...args: unknown[]) => loadRecoveryTargetWindowMock(...args) }));

// The two handlers that live in their own files answer with a marker, to prove the router dispatches to them (and before GET /:id).
vi.mock("./positionCloseLive.js", () => ({ streamCloseLiveHandler: (request: { params: { id: string } }, response: { json: (body: unknown) => void }) => response.json({ handler: "close-live", id: request.params.id }) }));
vi.mock("./positionCycleMarks.js", () => ({ getCycleMarksHandler: (_request: unknown, response: { json: (body: unknown) => void }) => response.json({ handler: "cycle-marks" }) }));

// Cycle and break-even derivation run for real by default; a test swaps in a scripted answer where it needs to control the ledger.
const fetchCyclesForTickersMock = vi.fn();
vi.mock("../lib/cycleQueries.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/cycleQueries.js")>("../lib/cycleQueries.js");
  return { ...actual, fetchCyclesForTickers: (...args: unknown[]) => fetchCyclesForTickersMock(...args) };
});
const fetchBreakEvenByPositionIdMock = vi.fn();
vi.mock("../lib/cycleBreakEvenQueries.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/cycleBreakEvenQueries.js")>("../lib/cycleBreakEvenQueries.js");
  return { ...actual, fetchBreakEvenByPositionId: (...args: unknown[]) => fetchBreakEvenByPositionIdMock(...args) };
});

const { db } = await import("../db/connection.js");
const { positionsRouter } = await import("./positions.js");
const actualCycleQueries = await vi.importActual<typeof import("../lib/cycleQueries.js")>("../lib/cycleQueries.js");
const actualBreakEvenQueries = await vi.importActual<typeof import("../lib/cycleBreakEvenQueries.js")>("../lib/cycleBreakEvenQueries.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
let symbolCounter = Date.now() % 100_000;

const missingId = "00000000-0000-4000-8000-000000000000";
const clearLimits = { blocked: false, reasons: [] as string[] };

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `pos-reads-${Date.now()}`, display_name: "Positions Reads Test", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/positions", positionsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanRows();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function cleanRows(): Promise<void> {
  const legIds = (await testDb("position_legs").whereIn("position_id", createdPositionIds).select("id")).map((row) => row.id);
  await testDb("position_leg_greeks_snapshots").whereIn("position_leg_id", legIds).del();
  await testDb("pulse_leg_delta_samples").whereIn("position_leg_id", legIds).del();
  await testDb("pulse_unrealized_pnl_samples").whereIn("position_id", createdPositionIds).del();
  await testDb("position_pnl_snapshots").whereIn("position_id", createdPositionIds).del();
  await testDb("order_requests").where({ requested_by_user_id: userId }).del();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  createdPositionIds.length = 0;
  createdTickerIds.length = 0;
}

afterEach(cleanRows);

beforeEach(() => {
  evaluateOrderLimitsMock.mockReset().mockResolvedValue(clearLimits);
  fetchPricesPoolFirstMock.mockReset().mockResolvedValue({});
  streamPooledPricesMock.mockReset();
  subscribeToPooledPriceMock.mockReset().mockResolvedValue(() => undefined);
  fetchGreeksPoolFirstMock.mockReset().mockResolvedValue({});
  streamPooledGreeksMock.mockReset();
  streamOrderLegQuoteMock.mockReset();
  checkDeltaComplianceMock.mockReset().mockReturnValue({ compliant: true, reason: null });
  evaluateRecoveryPathForPositionMock.mockReset();
  recordUnrealizedPnlSampleMock.mockReset();
  recordLegDeltaSampleMock.mockReset();
  getRiskFreeRateMock.mockReset().mockResolvedValue(0.04);
  computeLegSuccessProbabilitiesMock.mockReset().mockReturnValue({ probabilityByDelta: 0.7, probabilityByD2: 0.65 });
  loadRecoveryTargetWindowMock.mockReset().mockResolvedValue({ deltaTargetMin: 0.2, deltaTargetMax: 0.3, dteTargetMin: 20, dteTargetMax: 45 });
  fetchCyclesForTickersMock.mockReset().mockImplementation(actualCycleQueries.fetchCyclesForTickers);
  fetchBreakEvenByPositionIdMock.mockReset().mockImplementation(actualBreakEvenQueries.fetchBreakEvenByPositionId);
});

async function call(method: "GET" | "POST", path: string, body?: unknown, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? userId : options.asUser;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(asUser ? { "x-test-user-id": asUser } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

interface OpenServerSentStream {
  status: number;
  headers: Headers;
  /** The next frame as raw text (a "data: ..." frame or a ": ping" comment), or null once the server ended the stream. */
  nextBlock(): Promise<string | null>;
  /** The next data frame, parsed; comment frames are skipped. Null once the server ended the stream. */
  nextEvent(): Promise<any | null>;
  close(): Promise<void>;
}

async function openServerSentStream(path: string): Promise<OpenServerSentStream> {
  const abortController = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user-id": userId }, signal: abortController.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  async function nextBlock(): Promise<string | null> {
    for (;;) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        return block;
      }
      if (ended) return null;
      const { done, value } = await reader.read();
      if (done) ended = true;
      else buffer += decoder.decode(value, { stream: true });
    }
  }
  async function nextEvent(): Promise<any | null> {
    for (;;) {
      const block = await nextBlock();
      if (block === null) return null;
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) return JSON.parse(dataLine.slice("data: ".length));
    }
  }
  async function close(): Promise<void> {
    abortController.abort();
    await reader.cancel().catch(() => undefined);
  }
  return { status: response.status, headers: response.headers, nextBlock, nextEvent, close };
}

/**
 * Reads an SSE response's data frames. Stops once `expectedEvents` have arrived (then closes the connection, as a browser leaving the page
 * would) or when the server ends the stream; with no count it reads to the end.
 */
async function readServerSentEvents(path: string, expectedEvents?: number): Promise<{ status: number; headers: Headers; events: any[] }> {
  const stream = await openServerSentStream(path);
  const events: any[] = [];
  try {
    while (expectedEvents === undefined || events.length < expectedEvents) {
      const event = await stream.nextEvent();
      if (event === null) break;
      events.push(event);
    }
  } finally {
    await stream.close();
  }
  return { status: stream.status, headers: stream.headers, events };
}

/** Lets a scripted stream producer stay open until the client disconnects, like the real pooled streams do. */
function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = `PXR${(symbolCounter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Positions Reads Test Co", sector: "Technology" }).returning(["id", "symbol"]);
  createdTickerIds.push(ticker.id);
  return ticker;
}

interface LegSpec {
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType?: "call" | "put";
  strikePrice?: number;
  multiplier?: number;
  entryPrice?: number;
  exitPrice?: number | null;
  exitAt?: Date | null;
}

/** A position with its legs. Inserted closed and flipped to open only once the legs exist (see positionQueries.test.ts for why). */
async function createPosition(
  strategyKey: string,
  legs: LegSpec[],
  options: { status?: "open" | "closed"; ticker?: { id: string; symbol: string }; openedAt?: Date } = {},
): Promise<{ positionId: string; symbol: string; tickerId: string; legIds: string[] }> {
  const ticker = options.ticker ?? (await createTicker());
  const [position] = await testDb("positions")
    .insert({ strategy_key: strategyKey, ticker_id: ticker.id, status: "closed", closed_at: new Date(), ...(options.openedAt ? { opened_at: options.openedAt } : {}) })
    .returning("id");
  createdPositionIds.push(position.id);
  const legIds: string[] = [];
  for (const spec of legs) {
    const [leg] = await testDb("position_legs")
      .insert({
        position_id: position.id,
        leg_type: spec.legType,
        side: spec.side,
        quantity: spec.quantity,
        option_type: spec.optionType ?? null,
        strike_price: spec.strikePrice ?? null,
        expiry_date: spec.legType === "option" ? "2030-01-18" : null,
        multiplier: spec.multiplier ?? (spec.legType === "option" ? 100 : 1),
        entry_price: spec.entryPrice ?? 2,
        entry_at: new Date(Date.now() - 86_400_000),
        exit_price: spec.exitPrice ?? null,
        exit_at: spec.exitAt ?? null,
      })
      .returning("id");
    legIds.push(leg.id);
  }
  if ((options.status ?? "open") === "open") await testDb("positions").where({ id: position.id }).update({ status: "open", closed_at: null });
  return { positionId: position.id, symbol: ticker.symbol, tickerId: ticker.id, legIds };
}

const shortCall = (quantity: number, overrides: Partial<LegSpec> = {}): LegSpec => ({ legType: "option", side: "short", quantity, optionType: "call", strikePrice: 55, entryPrice: 2, ...overrides });
const shortPut = (quantity: number, overrides: Partial<LegSpec> = {}): LegSpec => ({ legType: "option", side: "short", quantity, optionType: "put", strikePrice: 90, entryPrice: 2, ...overrides });
const longStock = (quantity: number, overrides: Partial<LegSpec> = {}): LegSpec => ({ legType: "stock", side: "long", quantity, entryPrice: 50, ...overrides });

describe("authentication", () => {
  it("refuses every read and stream route without a session", async () => {
    const paths = [
      "/positions",
      "/positions/cycles?symbol=AAA",
      "/positions/cycles/marks",
      "/positions/cycles/scoreboard",
      "/positions/greeks?legIds=x",
      "/positions/greeks/stream?legIds=x",
      "/positions/pnl?positionIds=x",
      "/positions/pnl/stream?positionIds=x",
      "/positions/pulse-chart-history",
      "/positions/quote/stream?symbol=AAA&expiry=20261120&strike=1&right=C",
      `/positions/orders/${missingId}/quote/stream`,
      `/positions/${missingId}/close-live/stream`,
    ];
    for (const path of paths) {
      const response = await call("GET", path, undefined, { asUser: null });
      expect(response.status, path).toBe(401);
    }
    const recovery = await call("POST", `/positions/${missingId}/recovery-path`, {}, { asUser: null });
    expect(recovery.status).toBe(401);
    expect(streamPooledPricesMock).not.toHaveBeenCalled();
    expect(evaluateRecoveryPathForPositionMock).not.toHaveBeenCalled();
  });
});

describe("GET /positions", () => {
  it("lists open positions by default, with legs, realized P&L, capital at risk and the cycle break-even", async () => {
    const ticker = await createTicker();
    // A short put of 2 contracts, one contract-slice already bought back: entry 2.00, exit 0.50 on 1 contract = (2.00 - 0.50) x 1 x 100 = 150 realized.
    const { positionId, symbol } = await createPosition("cash_secured_put", [shortPut(2), shortPut(1, { exitPrice: 0.5, exitAt: new Date() })], { ticker });
    const response = await call("GET", `/positions?symbol=${symbol}`);
    expect(response.status).toBe(200);
    expect(response.json).toHaveLength(1);
    const [row] = response.json;
    expect(row).toMatchObject({ id: positionId, symbol, strategyKey: "cash_secured_put", status: "open", tickerId: ticker.id, companyName: "Positions Reads Test Co", sector: "Technology" });
    expect(row.legs).toHaveLength(2);
    expect(Number(row.realizedPnl)).toBe(150);
    // Open leg: strike 90 x multiplier 100 x 2 contracts.
    expect(Number(row.capitalAtRisk)).toBe(18_000);
    expect(row).toHaveProperty("breakEven");
    expect(row).toHaveProperty("breakEvenUnavailableReason");
  });

  it("derives a put-only cycle's break-even from the real ledger: strike 90 less the 2.00 premium per share = 88", async () => {
    const { positionId, symbol } = await createPosition("cash_secured_put", [shortPut(1, { entryPrice: 2 })]);
    const response = await call("GET", `/positions?symbol=${symbol}`);
    expect(response.json[0]).toMatchObject({ id: positionId, breakEven: 88, breakEvenUnavailableReason: null });
  });

  it("filters by status: open by default, closed, or all, newest opened first", async () => {
    const ticker = await createTicker();
    const olderClosed = await createPosition("cash_secured_put", [shortPut(1, { exitPrice: 0.1, exitAt: new Date() })], { ticker, status: "closed", openedAt: new Date(Date.now() - 10 * 86_400_000) });
    const newerOpen = await createPosition("unstructured", [longStock(100)], { ticker, openedAt: new Date(Date.now() - 86_400_000) });

    const open = await call("GET", `/positions?symbol=${ticker.symbol}`);
    expect(open.json.map((row: { id: string }) => row.id)).toEqual([newerOpen.positionId]);
    const closed = await call("GET", `/positions?symbol=${ticker.symbol}&status=closed`);
    expect(closed.json.map((row: { id: string }) => row.id)).toEqual([olderClosed.positionId]);
    const all = await call("GET", `/positions?symbol=${ticker.symbol}&status=all`);
    expect(all.json.map((row: { id: string }) => row.id)).toEqual([newerOpen.positionId, olderClosed.positionId]);
  });

  it("lists every position, whatever its status, when no filter at all is given", async () => {
    const open = await createPosition("unstructured", [longStock(100)]);
    const closed = await createPosition("cash_secured_put", [shortPut(1, { exitPrice: 0.1, exitAt: new Date() })], { status: "closed" });
    const response = await call("GET", "/positions?status=all");
    expect(response.status).toBe(200);
    const ids: string[] = response.json.map((row: { id: string }) => row.id);
    expect(ids).toContain(open.positionId);
    expect(ids).toContain(closed.positionId);
  });

  it("filters by strategy, accepting the read-only unstructured and hedge keys", async () => {
    const ticker = await createTicker();
    const put = await createPosition("cash_secured_put", [shortPut(1)], { ticker });
    const stock = await createPosition("unstructured", [longStock(100)], { ticker });
    const hedge = await createPosition("hedge", [{ legType: "option", side: "long", quantity: 1, optionType: "call", strikePrice: 100, entryPrice: 3 }], { ticker });
    const idsFor = async (strategy: string) => (await call("GET", `/positions?symbol=${ticker.symbol}&strategy=${strategy}`)).json.map((row: { id: string }) => row.id);
    expect(await idsFor("cash_secured_put")).toEqual([put.positionId]);
    expect(await idsFor("unstructured")).toEqual([stock.positionId]);
    expect(await idsFor("hedge")).toEqual([hedge.positionId]);
    expect(await idsFor("covered_call")).toEqual([]);
  });

  it("matches the symbol case-insensitively and ignoring surrounding spaces", async () => {
    const { positionId, symbol } = await createPosition("unstructured", [longStock(100)]);
    const response = await call("GET", `/positions?symbol=${encodeURIComponent(`  ${symbol.toLowerCase()} `)}`);
    expect(response.json.map((row: { id: string }) => row.id)).toEqual([positionId]);
  });

  it("answers 400 for an unknown status or strategy", async () => {
    const badStatus = await call("GET", "/positions?status=pending");
    expect(badStatus.status).toBe(400);
    expect(badStatus.json).toEqual({ error: "status must be open, closed, or all." });
    const badStrategy = await call("GET", "/positions?strategy=iron_condor");
    expect(badStrategy.status).toBe(400);
    expect(badStrategy.json).toEqual({ error: "Unknown strategy." });
  });

  it("returns an empty list, and asks for no break-even, when nothing matches", async () => {
    const response = await call("GET", "/positions?symbol=NOSUCHSYMBOLQQ");
    expect(response.status).toBe(200);
    expect(response.json).toEqual([]);
    expect(fetchBreakEvenByPositionIdMock).not.toHaveBeenCalled();
  });

  it("asks for the break-even of open positions only, and attaches each one's figure or its unavailable reason", async () => {
    const ticker = await createTicker();
    const openOne = await createPosition("cash_secured_put", [shortPut(1)], { ticker });
    const openTwo = await createPosition("unstructured", [longStock(100)], { ticker });
    const closed = await createPosition("cash_secured_put", [shortPut(1, { exitPrice: 0.1, exitAt: new Date() })], { ticker, status: "closed" });
    fetchBreakEvenByPositionIdMock.mockResolvedValue(
      new Map([
        [openOne.positionId, { breakEven: 88.5, breakEvenUnavailableReason: null, cycleNetPremium: 1, cycleSharesHeld: 0 }],
        [openTwo.positionId, { breakEven: null, breakEvenUnavailableReason: "ledger disagrees", cycleNetPremium: null, cycleSharesHeld: null }],
      ]),
    );
    const response = await call("GET", `/positions?symbol=${ticker.symbol}&status=all`);
    expect(fetchBreakEvenByPositionIdMock).toHaveBeenCalledTimes(1);
    expect(fetchBreakEvenByPositionIdMock.mock.calls[0]![0]).toEqual([ticker.id, ticker.id]);
    const byId = new Map<string, any>(response.json.map((row: { id: string }) => [row.id, row]));
    expect(byId.get(openOne.positionId)).toMatchObject({ breakEven: 88.5, breakEvenUnavailableReason: null });
    expect(byId.get(openTwo.positionId)).toMatchObject({ breakEven: null, breakEvenUnavailableReason: "ledger disagrees" });
    expect(byId.get(closed.positionId)).toMatchObject({ breakEven: null, breakEvenUnavailableReason: null });

    fetchBreakEvenByPositionIdMock.mockClear();
    await call("GET", `/positions?symbol=${ticker.symbol}&status=closed`);
    expect(fetchBreakEvenByPositionIdMock).not.toHaveBeenCalled();
  });

  it("still returns the positions, without a break-even, when the break-even computation fails", async () => {
    const { positionId, symbol } = await createPosition("unstructured", [longStock(100)]);
    fetchBreakEvenByPositionIdMock.mockRejectedValue(new Error("ledger exploded"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await call("GET", `/positions?symbol=${symbol}`);
      expect(response.status).toBe(200);
      expect(response.json).toHaveLength(1);
      expect(response.json[0]).toMatchObject({ id: positionId, breakEven: null, breakEvenUnavailableReason: null });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("GET /positions/cycles, /cycles/marks, /cycles/scoreboard and route dispatch", () => {
  it("requires a symbol", async () => {
    for (const path of ["/positions/cycles", "/positions/cycles?symbol=", "/positions/cycles?symbol=%20%20"]) {
      const response = await call("GET", path);
      expect(response.status, path).toBe(400);
      expect(response.json).toEqual({ error: "symbol is required" });
    }
  });

  it("answers an unknown symbol with no cycles, without deriving anything", async () => {
    const response = await call("GET", "/positions/cycles?symbol=nosuchsymbolqq");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ symbol: "NOSUCHSYMBOLQQ", cycles: [] });
    expect(fetchCyclesForTickersMock).not.toHaveBeenCalled();
  });

  it("lists a symbol's cycles newest first, upper-casing and trimming the symbol", async () => {
    const ticker = await createTicker();
    fetchCyclesForTickersMock.mockResolvedValue([{ symbol: ticker.symbol, tickerId: ticker.id, cycles: [{ id: "oldest" }, { id: "middle" }, { id: "newest" }] }]);
    const response = await call("GET", `/positions/cycles?symbol=${encodeURIComponent(` ${ticker.symbol.toLowerCase()} `)}`);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ symbol: ticker.symbol, cycles: [{ id: "newest" }, { id: "middle" }, { id: "oldest" }] });
    expect(fetchCyclesForTickersMock).toHaveBeenCalledWith([ticker.id]);
  });

  it("answers a known symbol that has no cycles with an empty list", async () => {
    const ticker = await createTicker();
    const response = await call("GET", `/positions/cycles?symbol=${ticker.symbol}`);
    expect(response.json).toEqual({ symbol: ticker.symbol, cycles: [] });
  });

  it("derives the cycles from the real ledger for a symbol with a position", async () => {
    const ticker = await createTicker();
    await createPosition("cash_secured_put", [shortPut(1)], { ticker });
    const response = await call("GET", `/positions/cycles?symbol=${ticker.symbol}`);
    expect(response.status).toBe(200);
    expect(response.json.symbol).toBe(ticker.symbol);
    expect(Array.isArray(response.json.cycles)).toBe(true);
    expect(response.json.cycles).toHaveLength(1);
  });

  it("dispatches /cycles/marks to its own handler, not to GET /:id", async () => {
    const response = await call("GET", "/positions/cycles/marks");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ handler: "cycle-marks" });
  });

  it("dispatches /:id/close-live/stream to its own handler with the id", async () => {
    const response = await call("GET", `/positions/${missingId}/close-live/stream`);
    expect(response.json).toEqual({ handler: "close-live", id: missingId });
  });

  const bucketOf = (premium: number, stock: number, total: number, capital: number) => ({ premium, stock, total, capital });
  const emptyBucket = bucketOf(0, 0, 0, 0);
  const cycleOf = (buckets: Partial<Record<"csp" | "unstructured" | "cc" | "hedge", ReturnType<typeof bucketOf>>>, dataFlags: string[] = []) => ({
    dataFlags,
    buckets: { csp: emptyBucket, unstructured: emptyBucket, cc: emptyBucket, hedge: emptyBucket, ...buckets },
  });

  it("totals the strategy scoreboard across symbols, with the return on capital per bucket", async () => {
    fetchCyclesForTickersMock.mockResolvedValue([
      { symbol: "AAA", tickerId: "t1", cycles: [cycleOf({ csp: bucketOf(200, 0, 200, 9000), cc: bucketOf(100, 50, 150, 5000) }), cycleOf({ csp: bucketOf(100, 0, 100, 1000) })] },
      { symbol: "BBB", tickerId: "t2", cycles: [cycleOf({ cc: bucketOf(40, -10, 30, 5000), hedge: bucketOf(-20, 0, -20, 300) })] },
    ]);
    const response = await call("GET", "/positions/cycles/scoreboard");
    expect(response.status).toBe(200);
    expect(fetchCyclesForTickersMock).toHaveBeenCalledWith("all");
    expect(response.json).toEqual({
      buckets: {
        // 300 total on 10000 capital.
        csp: { premium: 300, stock: 0, total: 300, capital: 10_000, returnOnCapital: 0.03 },
        // No capital: the return is not defined.
        unstructured: { premium: 0, stock: 0, total: 0, capital: 0, returnOnCapital: null },
        // 180 total on 10000 capital.
        cc: { premium: 140, stock: 40, total: 180, capital: 10_000, returnOnCapital: 0.018 },
        hedge: { premium: -20, stock: 0, total: -20, capital: 300, returnOnCapital: -20 / 300 },
      },
      total: 300 + 0 + 180 - 20,
      cyclesIncluded: 3,
      cyclesExcluded: [],
    });
  });

  it("leaves out cycles whose ledger cannot be trusted and counts them, naming the first flag", async () => {
    fetchCyclesForTickersMock.mockResolvedValue([
      { symbol: "AAA", tickerId: "t1", cycles: [cycleOf({ csp: bucketOf(100, 0, 100, 1000) }), cycleOf({ csp: bucketOf(999, 0, 999, 9999) }, ["expiry bar missing", "second flag"])] },
      { symbol: "BBB", tickerId: "t2", cycles: [cycleOf({ cc: bucketOf(1, 0, 1, 1) }, ["share count mismatch"])] },
    ]);
    const response = await call("GET", "/positions/cycles/scoreboard");
    expect(response.json.cyclesIncluded).toBe(1);
    expect(response.json.cyclesExcluded).toEqual([
      { symbol: "AAA", reason: "expiry bar missing" },
      { symbol: "BBB", reason: "share count mismatch" },
    ]);
    expect(response.json.buckets.csp).toMatchObject({ total: 100, capital: 1000, returnOnCapital: 0.1 });
    expect(response.json.buckets.cc).toMatchObject({ total: 0, returnOnCapital: null });
    expect(response.json.total).toBe(100);
  });

  it("answers an empty scoreboard when there are no cycles", async () => {
    fetchCyclesForTickersMock.mockResolvedValue([]);
    const response = await call("GET", "/positions/cycles/scoreboard");
    expect(response.json.total).toBe(0);
    expect(response.json.cyclesIncluded).toBe(0);
    expect(response.json.cyclesExcluded).toEqual([]);
    expect(response.json.buckets.csp).toEqual({ premium: 0, stock: 0, total: 0, capital: 0, returnOnCapital: null });
  });
});

describe("GET /positions/greeks", () => {
  it("answers an empty object when no leg ids are given", async () => {
    expect((await call("GET", "/positions/greeks")).json).toEqual({});
    expect((await call("GET", "/positions/greeks?legIds=")).json).toEqual({});
    expect(fetchGreeksPoolFirstMock).not.toHaveBeenCalled();
  });

  it("asks for the greeks of open option legs only, with the contract fields IBKR needs, and returns live values", async () => {
    const coveredCall = await createPosition("covered_call", [longStock(100), shortCall(1)]);
    const put = await createPosition("cash_secured_put", [shortPut(1)]);
    const closedPut = await createPosition("cash_secured_put", [shortPut(1)], { status: "closed" });
    const [stockLegId, callLegId] = coveredCall.legIds;
    const live = { delta: 0.3, gamma: 0.02, vega: 0.1, theta: -0.05 };
    fetchGreeksPoolFirstMock.mockResolvedValue({ [callLegId!]: live, [put.legIds[0]!]: { delta: -0.2, gamma: 0.01, vega: 0.08, theta: -0.04 } });

    const allLegIds = [stockLegId, callLegId, put.legIds[0], closedPut.legIds[0]].join(",");
    const response = await call("GET", `/positions/greeks?legIds=${allLegIds}`);
    expect(response.status).toBe(200);
    expect(response.json[callLegId!]).toEqual({ ...live, asOfDate: null });
    expect(response.json[put.legIds[0]!]).toEqual({ delta: -0.2, gamma: 0.01, vega: 0.08, theta: -0.04, asOfDate: null });
    expect(Object.keys(response.json).sort()).toEqual([callLegId, put.legIds[0]].sort());

    const contracts = (fetchGreeksPoolFirstMock.mock.calls[0]![0] as { key: string }[]).sort((first, second) => first.key.localeCompare(second.key));
    expect(contracts).toEqual(
      [
        { key: callLegId, symbol: coveredCall.symbol, expiry: "20300118", strike: 55, right: OptionType.Call },
        { key: put.legIds[0], symbol: put.symbol, expiry: "20300118", strike: 90, right: OptionType.Put },
      ].sort((first, second) => String(first.key).localeCompare(String(second.key))),
    );
  });

  it("falls back to the latest nightly snapshot for a leg with no live greeks, labelled with the snapshot date", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    await testDb("position_leg_greeks_snapshots").insert([
      { position_leg_id: legIds[0], snapshot_date: "2026-09-01", delta: -0.31, gamma: 0.011, vega: 0.09, theta: -0.03 },
      { position_leg_id: legIds[0], snapshot_date: "2026-09-02", delta: -0.25, gamma: 0.012, vega: 0.1, theta: -0.04 },
    ]);
    // Empty on every greek counts as "no live data", and so does a leg the pool did not answer for.
    for (const liveAnswer of [{ [legIds[0]!]: { delta: null, gamma: null, vega: null, theta: null } }, {}]) {
      fetchGreeksPoolFirstMock.mockResolvedValue(liveAnswer);
      const response = await call("GET", `/positions/greeks?legIds=${legIds[0]}`);
      expect(response.json[legIds[0]!]).toEqual({ delta: -0.25, gamma: 0.012, vega: 0.1, theta: -0.04, asOfDate: "2026-09-02" });
    }
  });

  it("counts a leg as live when any one greek is present, and does not read the snapshot for it", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    await testDb("position_leg_greeks_snapshots").insert({ position_leg_id: legIds[0], snapshot_date: "2026-09-02", delta: -0.25, gamma: 0.012, vega: 0.1, theta: -0.04 });
    fetchGreeksPoolFirstMock.mockResolvedValue({ [legIds[0]!]: { delta: null, gamma: 0.02, vega: null, theta: null } });
    const response = await call("GET", `/positions/greeks?legIds=${legIds[0]}`);
    expect(response.json[legIds[0]!]).toEqual({ delta: null, gamma: 0.02, vega: null, theta: null, asOfDate: null });
  });

  it("keeps a null greek of a snapshot row null rather than turning it into zero", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    await testDb("position_leg_greeks_snapshots").insert({ position_leg_id: legIds[0], snapshot_date: "2026-09-02", delta: -0.25, gamma: null, vega: null, theta: -0.04 });
    const response = await call("GET", `/positions/greeks?legIds=${legIds[0]}`);
    expect(response.json[legIds[0]!]).toEqual({ delta: -0.25, gamma: null, vega: null, theta: -0.04, asOfDate: "2026-09-02" });
  });

  it("answers null greeks, dated nothing, for a leg with neither live data nor a snapshot", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    const response = await call("GET", `/positions/greeks?legIds=${legIds[0]}`);
    expect(response.json[legIds[0]!]).toEqual({ delta: null, gamma: null, vega: null, theta: null, asOfDate: null });
  });

  it("degrades to the snapshot instead of failing when the live greeks lookup throws", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    await testDb("position_leg_greeks_snapshots").insert({ position_leg_id: legIds[0], snapshot_date: "2026-09-02", delta: -0.25, gamma: 0.012, vega: 0.1, theta: -0.04 });
    fetchGreeksPoolFirstMock.mockRejectedValue(new Error("Gateway unreachable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await call("GET", `/positions/greeks?legIds=${legIds[0]}`);
      expect(response.status).toBe(200);
      expect(response.json[legIds[0]!]).toMatchObject({ delta: -0.25, asOfDate: "2026-09-02" });
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("GET /positions/greeks/stream", () => {
  it("opens the stream, sends one empty frame and ends when there are no open option legs", async () => {
    const { headers, status, events } = await readServerSentEvents("/positions/greeks/stream");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(headers.get("cache-control")).toBe("no-cache");
    expect(events).toEqual([{}]);
    expect(streamPooledGreeksMock).not.toHaveBeenCalled();

    const stockOnly = await createPosition("unstructured", [longStock(100)]);
    const forStockLeg = await readServerSentEvents(`/positions/greeks/stream?legIds=${stockOnly.legIds[0]}`);
    expect(forStockLeg.events).toEqual([{}]);
  });

  it("sends a first frame of live greeks enriched with the leg's success probabilities, and records the delta sample", async () => {
    const { legIds, symbol } = await createPosition("covered_call", [longStock(100, { entryPrice: 50 }), longStock(100, { entryPrice: 60 }), shortCall(1)]);
    const callLegId = legIds[2]!;
    const live = { delta: 0.3, gamma: 0.02, vega: 0.1, theta: -0.05, impliedVolatility: 0.4, underlyingPrice: 52 };
    streamPooledGreeksMock.mockImplementation(async (_contracts: unknown, onUpdate: (greeks: unknown) => void, signal: AbortSignal) => {
      onUpdate({ [callLegId]: live });
      await waitForAbort(signal);
    });

    const { events } = await readServerSentEvents(`/positions/greeks/stream?legIds=${callLegId}`, 1);
    expect(events).toEqual([{ [callLegId]: { ...live, asOfDate: null, probabilityByDelta: 0.7, probabilityByD2: 0.65 } }]);
    expect(streamPooledGreeksMock.mock.calls[0]![0]).toEqual([{ key: callLegId, symbol, expiry: "20300118", strike: 55, right: OptionType.Call }]);
    // The stock cost basis the call is judged against is the average entry of the open shares: (50 x 100 + 60 x 100) / 200 = 55.
    expect(computeLegSuccessProbabilitiesMock).toHaveBeenCalledWith(
      { side: "short", optionType: "call", strike: 55, expiryIsoDate: "2030-01-18", stockCostBasisPerShare: 55 },
      { ...live, asOfDate: null },
      0.04,
    );
    expect(recordLegDeltaSampleMock).toHaveBeenCalledWith(callLegId, 0.3);
  });

  it("has no stock cost basis for a put, and passes a null risk-free rate when it cannot be read", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    getRiskFreeRateMock.mockRejectedValue(new Error("FRED down"));
    streamPooledGreeksMock.mockImplementation(async (_contracts: unknown, onUpdate: (greeks: unknown) => void, signal: AbortSignal) => {
      onUpdate({ [legIds[0]!]: { delta: -0.2, gamma: 0.01, vega: 0.08, theta: -0.04 } });
      await waitForAbort(signal);
    });
    const { events } = await readServerSentEvents(`/positions/greeks/stream?legIds=${legIds[0]}`, 1);
    expect(events).toHaveLength(1);
    expect(computeLegSuccessProbabilitiesMock).toHaveBeenCalledWith(expect.objectContaining({ optionType: "put", stockCostBasisPerShare: null }), expect.anything(), null);
  });

  it("applies the nightly snapshot to the first frame only, then lets live values replace it but never regress to nothing", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    const legId = legIds[0]!;
    await testDb("position_leg_greeks_snapshots").insert({ position_leg_id: legId, snapshot_date: "2026-09-02", delta: -0.25, gamma: 0.012, vega: 0.1, theta: -0.04 });
    const empty = { delta: null, gamma: null, vega: null, theta: null };
    const live = { delta: -0.22, gamma: 0.013, vega: 0.11, theta: -0.045 };
    streamPooledGreeksMock.mockImplementation(async (_contracts: unknown, onUpdate: (greeks: unknown) => void, signal: AbortSignal) => {
      onUpdate({ [legId]: empty });
      onUpdate({ [legId]: live });
      onUpdate({ [legId]: empty });
      await waitForAbort(signal);
    });
    computeLegSuccessProbabilitiesMock.mockReturnValue({ probabilityByDelta: null, probabilityByD2: null });

    const { events } = await readServerSentEvents(`/positions/greeks/stream?legIds=${legId}`, 3);
    const greeksOf = (event: Record<string, any>) => ({ delta: event[legId].delta, asOfDate: event[legId].asOfDate });
    expect(events.map(greeksOf)).toEqual([
      { delta: -0.25, asOfDate: "2026-09-02" },
      { delta: -0.22, asOfDate: null },
      { delta: -0.22, asOfDate: null },
    ]);
  });

  it("keeps a null greek of the snapshot null on the first frame rather than turning it into zero", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    await testDb("position_leg_greeks_snapshots").insert({ position_leg_id: legIds[0], snapshot_date: "2026-09-02", delta: null, gamma: 0.012, vega: null, theta: null });
    streamPooledGreeksMock.mockImplementation(async (_contracts: unknown, onUpdate: (greeks: unknown) => void, signal: AbortSignal) => {
      onUpdate({});
      await waitForAbort(signal);
    });
    const { events } = await readServerSentEvents(`/positions/greeks/stream?legIds=${legIds[0]}`, 1);
    expect(events[0][legIds[0]!]).toMatchObject({ delta: null, gamma: 0.012, vega: null, theta: null, asOfDate: "2026-09-02" });
  });

  it("sends null greeks on the first frame for a leg with neither live data nor a snapshot", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    streamPooledGreeksMock.mockImplementation(async (_contracts: unknown, onUpdate: (greeks: unknown) => void, signal: AbortSignal) => {
      onUpdate({});
      await waitForAbort(signal);
    });
    const { events } = await readServerSentEvents(`/positions/greeks/stream?legIds=${legIds[0]}`, 1);
    expect(events[0][legIds[0]!]).toMatchObject({ delta: null, gamma: null, vega: null, theta: null, asOfDate: null });
  });

  it("ends the stream cleanly when the pooled stream fails", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    streamPooledGreeksMock.mockRejectedValue(new Error("pool down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { status, events } = await readServerSentEvents(`/positions/greeks/stream?legIds=${legIds[0]}`);
      expect(status).toBe(200);
      expect(events).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("GET /positions/pnl", () => {
  it("answers an empty object when no position ids are given", async () => {
    expect((await call("GET", "/positions/pnl")).json).toEqual({});
    expect(fetchPricesPoolFirstMock).not.toHaveBeenCalled();
  });

  it("marks a covered call to live prices: stock +500, short call -100, total +400, market value 5500", async () => {
    const { positionId, legIds, symbol } = await createPosition("covered_call", [longStock(100, { entryPrice: 50 }), shortCall(1, { entryPrice: 2 })]);
    const [stockLegId, callLegId] = legIds;
    fetchPricesPoolFirstMock.mockResolvedValue({ [stockLegId!]: 55, [callLegId!]: 3 });
    const response = await call("GET", `/positions/pnl?positionIds=${positionId}`);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ [positionId]: { unrealizedPnl: 400, unrealizedPremiumPnl: -100, unrealizedStockPnl: 500, stockMarketValue: 5500, asOfDate: null } });

    const contracts = (fetchPricesPoolFirstMock.mock.calls[0]![0] as { key: string }[]).sort((first, second) => first.key.localeCompare(second.key));
    expect(contracts).toEqual(
      [
        { key: stockLegId, legType: "stock", symbol },
        { key: callLegId, legType: "option", symbol, expiry: "20300118", strike: 55, right: OptionType.Call },
      ].sort((first, second) => String(first.key).localeCompare(String(second.key))),
    );
  });

  it("marks a short put: entry 2.00, now 0.50, 2 contracts = +300, with no stock value", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(2, { entryPrice: 2 })]);
    fetchPricesPoolFirstMock.mockResolvedValue({ [legIds[0]!]: 0.5 });
    const response = await call("GET", `/positions/pnl?positionIds=${positionId}`);
    expect(response.json[positionId]).toEqual({ unrealizedPnl: 300, unrealizedPremiumPnl: 300, unrealizedStockPnl: 0, stockMarketValue: 0, asOfDate: null });
  });

  it("prices only the legs still open: a rolled-away leg is not re-marked", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(1, { strikePrice: 85, entryPrice: 1, exitPrice: 0.2, exitAt: new Date() }), shortPut(1, { entryPrice: 2 })]);
    fetchPricesPoolFirstMock.mockResolvedValue({ [legIds[1]!]: 1 });
    const response = await call("GET", `/positions/pnl?positionIds=${positionId}`);
    expect((fetchPricesPoolFirstMock.mock.calls[0]![0] as { key: string }[]).map((contract) => contract.key)).toEqual([legIds[1]]);
    expect(response.json[positionId].unrealizedPnl).toBe(100);
  });

  it("reads 0 for a position with no open legs, closed or unknown", async () => {
    const closed = await createPosition("cash_secured_put", [shortPut(1, { exitPrice: 0.2, exitAt: new Date() })], { status: "closed" });
    const response = await call("GET", `/positions/pnl?positionIds=${closed.positionId},${missingId}`);
    expect(response.json[closed.positionId]).toEqual({ unrealizedPnl: 0, unrealizedPremiumPnl: 0, unrealizedStockPnl: 0, stockMarketValue: 0, asOfDate: null });
    expect(response.json[missingId]).toEqual({ unrealizedPnl: 0, unrealizedPremiumPnl: 0, unrealizedStockPnl: 0, stockMarketValue: 0, asOfDate: null });
  });

  it("falls back to the latest nightly snapshot for a position with a leg that has no live price, never to a partial live sum", async () => {
    const { positionId, legIds } = await createPosition("covered_call", [longStock(100), shortCall(1)]);
    await testDb("position_pnl_snapshots").insert([
      { position_id: positionId, snapshot_date: "2026-09-01", unrealized_pnl: 111, premium_pnl: 11, stock_pnl: 100 },
      { position_id: positionId, snapshot_date: "2026-09-02", unrealized_pnl: 222.5, premium_pnl: 22.5, stock_pnl: 200 },
    ]);
    // The stock leg is priced, the call is not: the stock's gain alone would pass for the whole position's.
    fetchPricesPoolFirstMock.mockResolvedValue({ [legIds[0]!]: 55, [legIds[1]!]: null });
    const response = await call("GET", `/positions/pnl?positionIds=${positionId}`);
    expect(response.json[positionId]).toEqual({ unrealizedPnl: 222.5, unrealizedPremiumPnl: 22.5, unrealizedStockPnl: 200, stockMarketValue: null, asOfDate: "2026-09-02" });
  });

  it("keeps the split null when the snapshot predates it, and answers all-null with no snapshot at all", async () => {
    const withOldSnapshot = await createPosition("cash_secured_put", [shortPut(1)]);
    const withNothing = await createPosition("cash_secured_put", [shortPut(1)]);
    await testDb("position_pnl_snapshots").insert({ position_id: withOldSnapshot.positionId, snapshot_date: "2026-08-01", unrealized_pnl: -40, premium_pnl: null, stock_pnl: null });
    const response = await call("GET", `/positions/pnl?positionIds=${withOldSnapshot.positionId},${withNothing.positionId}`);
    expect(response.json[withOldSnapshot.positionId]).toEqual({ unrealizedPnl: -40, unrealizedPremiumPnl: null, unrealizedStockPnl: null, stockMarketValue: null, asOfDate: "2026-08-01" });
    expect(response.json[withNothing.positionId]).toEqual({ unrealizedPnl: null, unrealizedPremiumPnl: null, unrealizedStockPnl: null, stockMarketValue: null, asOfDate: null });
  });

  it("answers per position: one live, one from its snapshot", async () => {
    const live = await createPosition("cash_secured_put", [shortPut(1, { entryPrice: 2 })]);
    const stale = await createPosition("cash_secured_put", [shortPut(1, { entryPrice: 2 })]);
    await testDb("position_pnl_snapshots").insert({ position_id: stale.positionId, snapshot_date: "2026-09-02", unrealized_pnl: 55, premium_pnl: 55, stock_pnl: 0 });
    fetchPricesPoolFirstMock.mockResolvedValue({ [live.legIds[0]!]: 1.5 });
    const response = await call("GET", `/positions/pnl?positionIds=${live.positionId},${stale.positionId}`);
    expect(response.json[live.positionId]).toMatchObject({ unrealizedPnl: 50, asOfDate: null });
    expect(response.json[stale.positionId]).toMatchObject({ unrealizedPnl: 55, asOfDate: "2026-09-02" });
  });

  it("falls back to the snapshot instead of failing when the price lookup throws", async () => {
    const { positionId } = await createPosition("cash_secured_put", [shortPut(1)]);
    await testDb("position_pnl_snapshots").insert({ position_id: positionId, snapshot_date: "2026-09-02", unrealized_pnl: 55, premium_pnl: 55, stock_pnl: 0 });
    fetchPricesPoolFirstMock.mockRejectedValue(new Error("Gateway unreachable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await call("GET", `/positions/pnl?positionIds=${positionId}`);
      expect(response.status).toBe(200);
      expect(response.json[positionId]).toMatchObject({ unrealizedPnl: 55, asOfDate: "2026-09-02" });
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("GET /positions/pnl/stream", () => {
  const emptyResult = { unrealizedPnl: null, unrealizedPremiumPnl: null, unrealizedStockPnl: null, stockMarketValue: null, asOfDate: null };

  it("opens the stream, sends one empty frame and ends when no position ids are given", async () => {
    const { headers, status, events } = await readServerSentEvents("/positions/pnl/stream");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(headers.get("cache-control")).toBe("no-cache");
    expect(events).toEqual([{}]);
    expect(streamPooledPricesMock).not.toHaveBeenCalled();
  });

  it("sends a first frame of live P&L, records the sample, and hands the pool the open legs' contracts", async () => {
    const { positionId, legIds, symbol } = await createPosition("covered_call", [longStock(100, { entryPrice: 50 }), shortCall(1, { entryPrice: 2 })]);
    const [stockLegId, callLegId] = legIds;
    streamPooledPricesMock.mockImplementation(async (_contracts: unknown, onUpdate: (prices: unknown) => void, signal: AbortSignal) => {
      onUpdate({ [stockLegId!]: 55, [callLegId!]: 3 });
      await waitForAbort(signal);
    });
    const { events } = await readServerSentEvents(`/positions/pnl/stream?positionIds=${positionId}`, 1);
    expect(events).toEqual([{ [positionId]: { unrealizedPnl: 400, unrealizedPremiumPnl: -100, unrealizedStockPnl: 500, stockMarketValue: 5500, asOfDate: null } }]);
    expect(recordUnrealizedPnlSampleMock).toHaveBeenCalledWith(positionId, 400);
    const contracts = (streamPooledPricesMock.mock.calls[0]![0] as { key: string }[]).sort((first, second) => first.key.localeCompare(second.key));
    expect(contracts).toEqual(
      [
        { key: stockLegId, legType: "stock", symbol },
        { key: callLegId, legType: "option", symbol, expiry: "20300118", strike: 55, right: OptionType.Call },
      ].sort((first, second) => String(first.key).localeCompare(String(second.key))),
    );
  });

  it("starts from the nightly snapshot when the first prices are incomplete, replaces it once every leg is priced, and never regresses", async () => {
    const { positionId, legIds } = await createPosition("covered_call", [longStock(100, { entryPrice: 50 }), shortCall(1, { entryPrice: 2 })]);
    const [stockLegId, callLegId] = legIds;
    await testDb("position_pnl_snapshots").insert({ position_id: positionId, snapshot_date: "2026-09-02", unrealized_pnl: 222.5, premium_pnl: 22.5, stock_pnl: 200 });
    streamPooledPricesMock.mockImplementation(async (_contracts: unknown, onUpdate: (prices: unknown) => void, signal: AbortSignal) => {
      onUpdate({ [stockLegId!]: 55 });
      onUpdate({ [stockLegId!]: 55, [callLegId!]: 3 });
      onUpdate({ [stockLegId!]: 56 });
      await waitForAbort(signal);
    });
    const { events } = await readServerSentEvents(`/positions/pnl/stream?positionIds=${positionId}`, 3);
    expect(events[0]).toEqual({ [positionId]: { unrealizedPnl: 222.5, unrealizedPremiumPnl: 22.5, unrealizedStockPnl: 200, stockMarketValue: null, asOfDate: "2026-09-02" } });
    expect(events[1]).toEqual({ [positionId]: { unrealizedPnl: 400, unrealizedPremiumPnl: -100, unrealizedStockPnl: 500, stockMarketValue: 5500, asOfDate: null } });
    // The third frame has no call price: the position keeps its last complete figure instead of dropping to null.
    expect(events[2]).toEqual(events[1]);
  });

  it("keeps the premium and stock split null on the first frame when the snapshot predates it", async () => {
    const { positionId } = await createPosition("cash_secured_put", [shortPut(1)]);
    await testDb("position_pnl_snapshots").insert({ position_id: positionId, snapshot_date: "2026-08-01", unrealized_pnl: -40, premium_pnl: null, stock_pnl: null });
    streamPooledPricesMock.mockImplementation(async (_contracts: unknown, onUpdate: (prices: unknown) => void, signal: AbortSignal) => {
      onUpdate({});
      await waitForAbort(signal);
    });
    const { events } = await readServerSentEvents(`/positions/pnl/stream?positionIds=${positionId}`, 1);
    expect(events[0]).toEqual({ [positionId]: { unrealizedPnl: -40, unrealizedPremiumPnl: null, unrealizedStockPnl: null, stockMarketValue: null, asOfDate: "2026-08-01" } });
  });

  it("sends nulls for a position with neither complete prices nor a snapshot, and keeps a later incomplete update null", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    streamPooledPricesMock.mockImplementation(async (_contracts: unknown, onUpdate: (prices: unknown) => void, signal: AbortSignal) => {
      onUpdate({ [legIds[0]!]: null });
      onUpdate({});
      await waitForAbort(signal);
    });
    const { events } = await readServerSentEvents(`/positions/pnl/stream?positionIds=${positionId}`, 2);
    expect(events[0]).toEqual({ [positionId]: emptyResult });
    expect(events[1]).toEqual({ [positionId]: emptyResult });
  });

  it("ends the stream cleanly when the pooled stream fails", async () => {
    const { positionId } = await createPosition("cash_secured_put", [shortPut(1)]);
    streamPooledPricesMock.mockRejectedValue(new Error("pool down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { status, events } = await readServerSentEvents(`/positions/pnl/stream?positionIds=${positionId}`);
      expect(status).toBe(200);
      expect(events).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("GET /positions/pulse-chart-history", () => {
  it("returns the stored samples of open positions only: total P&L per instant and each leg's delta series per position", async () => {
    const open = await createPosition("cash_secured_put", [shortPut(1)]);
    const closed = await createPosition("cash_secured_put", [shortPut(1)], { status: "closed" });
    const firstInstant = new Date("2001-02-03T10:00:00.000Z");
    const secondInstant = new Date("2001-02-03T10:00:05.000Z");
    await testDb("pulse_unrealized_pnl_samples").insert([
      { position_id: open.positionId, sampled_at: firstInstant, unrealized_pnl: 100 },
      { position_id: open.positionId, sampled_at: secondInstant, unrealized_pnl: null },
      { position_id: closed.positionId, sampled_at: firstInstant, unrealized_pnl: 999 },
    ]);
    await testDb("pulse_leg_delta_samples").insert([
      { position_leg_id: open.legIds[0], sampled_at: secondInstant, leg_delta: -0.3 },
      { position_leg_id: open.legIds[0], sampled_at: firstInstant, leg_delta: -0.25 },
      { position_leg_id: open.legIds[0], sampled_at: new Date("2001-02-03T10:00:09.000Z"), leg_delta: null },
      { position_leg_id: closed.legIds[0], sampled_at: firstInstant, leg_delta: -0.1 },
    ]);

    const response = await call("GET", "/positions/pulse-chart-history");
    expect(response.status).toBe(200);
    const atFirst = response.json.pnlSamples.find((sample: { sampledAtMs: number }) => sample.sampledAtMs === firstInstant.getTime());
    const atSecond = response.json.pnlSamples.find((sample: { sampledAtMs: number }) => sample.sampledAtMs === secondInstant.getTime());
    // The closed position's 999 is excluded; a null sample counts as 0 in the total.
    expect(atFirst.totalUnrealizedPnl).toBe(100);
    expect(atSecond.totalUnrealizedPnl).toBe(0);
    const sampledTimes: number[] = response.json.pnlSamples.map((sample: { sampledAtMs: number }) => sample.sampledAtMs);
    expect(sampledTimes).toEqual([...sampledTimes].sort((first, second) => first - second));
    // Oldest first, and null deltas and closed positions are left out.
    expect(response.json.deltaSamplesByPositionId[open.positionId]).toEqual([
      { sampledAtMs: firstInstant.getTime(), delta: -0.25 },
      { sampledAtMs: secondInstant.getTime(), delta: -0.3 },
    ]);
    expect(response.json.deltaSamplesByPositionId[closed.positionId]).toBeUndefined();
  });
});

describe("GET /positions/quote/stream", () => {
  it("requires symbol, expiry, strike and a right of C or P, before opening a stream", async () => {
    const paths = [
      "/positions/quote/stream",
      "/positions/quote/stream?symbol=AAA&expiry=20261120&strike=100",
      "/positions/quote/stream?symbol=AAA&expiry=20261120&right=C",
      "/positions/quote/stream?symbol=AAA&strike=100&right=C",
      "/positions/quote/stream?expiry=20261120&strike=100&right=C",
      "/positions/quote/stream?symbol=AAA&expiry=20261120&strike=abc&right=C",
      "/positions/quote/stream?symbol=AAA&expiry=20261120&strike=100&right=X",
      "/positions/quote/stream?symbol=AAA&expiry=20261120&strike=100&right=c",
    ];
    for (const path of paths) {
      const response = await call("GET", path);
      expect(response.status, path).toBe(400);
      expect(response.json).toEqual({ error: "symbol, expiry, strike, and right (C or P) are all required." });
    }
    expect(streamOrderLegQuoteMock).not.toHaveBeenCalled();
  });

  it("streams each quote for the contract without a compliance verdict, then a done frame", async () => {
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, onQuote: (quote: unknown) => void) => {
      onQuote({ bid: 1, ask: 1.2, delta: -0.25 });
      onQuote({ bid: 1.1, ask: 1.3, delta: -0.26 });
    });
    const { status, headers, events } = await readServerSentEvents("/positions/quote/stream?symbol=AAA&expiry=20261120&strike=87.5&right=P");
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(events).toEqual([
      { type: "quote", data: { bid: 1, ask: 1.2, delta: -0.25, compliance: null } },
      { type: "quote", data: { bid: 1.1, ask: 1.3, delta: -0.26, compliance: null } },
      { type: "done" },
    ]);
    expect(streamOrderLegQuoteMock).toHaveBeenCalledWith("AAA", "20261120", 87.5, OptionType.Put, expect.any(Function), expect.any(AbortSignal));
  });

  it("maps a right of C to a call, and reports a failed stream as a streamError frame instead of done", async () => {
    streamOrderLegQuoteMock.mockRejectedValue(new Error("no market data permissions"));
    const { events } = await readServerSentEvents("/positions/quote/stream?symbol=AAA&expiry=20261120&strike=100&right=C");
    expect(events).toEqual([{ type: "streamError", message: "no market data permissions" }]);
    expect(streamOrderLegQuoteMock.mock.calls[0]![3]).toBe(OptionType.Call);
  });

  it("reports a thrown non-error as its text", async () => {
    streamOrderLegQuoteMock.mockRejectedValue("plain text failure");
    const { events } = await readServerSentEvents("/positions/quote/stream?symbol=AAA&expiry=20261120&strike=100&right=C");
    expect(events).toEqual([{ type: "streamError", message: "plain text failure" }]);
  });
});

describe("GET /positions/orders/:id/quote/stream", () => {
  async function insertOrder(symbol: string, requestType: string, payload: unknown): Promise<string> {
    const [row] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: requestType, payload: JSON.stringify(payload) }).returning("id");
    return row.id;
  }
  const openPutPayload = (symbol: string) => ({ symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol, quantity: 1, unitPrice: 1.5, strike: 90, expiry: "20261120", right: "P" }] });

  it("answers 404 for an unknown order and 400 for an order with no option leg to quote", async () => {
    const missing = await call("GET", `/positions/orders/${missingId}/quote/stream`);
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: "Order not found." });

    const ticker = await createTicker();
    const stockOnlyId = await insertOrder(ticker.symbol, "close_position", { symbol: ticker.symbol, strategyKey: "unstructured", legs: [{ role: "stock", action: "SELL", symbol: ticker.symbol, quantity: 100, unitPrice: 50 }] });
    const noOption = await call("GET", `/positions/orders/${stockOnlyId}/quote/stream`);
    expect(noOption.status).toBe(400);
    expect(noOption.json).toEqual({ error: "This order has no option leg to quote." });
    expect(streamOrderLegQuoteMock).not.toHaveBeenCalled();
  });

  it("streams an opening order's quotes with the delta-band verdict and the order's position-limit verdict, then done", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, "open_cash_secured_put", openPutPayload(ticker.symbol));
    evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["too big"] });
    checkDeltaComplianceMock.mockReturnValue({ compliant: false, reason: "Delta 0.35 is above the 0.2–0.3 delta band." });
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, onQuote: (quote: unknown) => void) => {
      onQuote({ bid: 1.4, ask: 1.6, delta: -0.35 });
    });

    const { status, headers, events } = await readServerSentEvents(`/positions/orders/${orderId}/quote/stream`);
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("text/event-stream");
    expect(events).toEqual([
      { type: "quote", data: { bid: 1.4, ask: 1.6, delta: -0.35, compliance: { compliant: false, reason: "Delta 0.35 is above the 0.2–0.3 delta band." }, signalLimits: { blocked: true, reasons: ["too big"] } } },
      { type: "done" },
    ]);
    expect(checkDeltaComplianceMock).toHaveBeenCalledWith(-0.35, 0.2, 0.3);
    expect(streamOrderLegQuoteMock).toHaveBeenCalledWith(ticker.symbol, "20261120", 90, OptionType.Put, expect.any(Function), expect.any(AbortSignal));
    expect(evaluateOrderLimitsMock).toHaveBeenCalledWith(expect.objectContaining({ strategyKey: "cash_secured_put", symbol: ticker.symbol, quantity: 1, strike: 90, excludeOrderRequestId: orderId }));
    // The underlying is pooled for the stream's lifetime so the limit re-checks can use its live price.
    expect(subscribeToPooledPriceMock).toHaveBeenCalledWith({ key: "stock", legType: "stock", symbol: ticker.symbol }, expect.any(Function));
  });

  it("checks the delta against no band when the settings row is missing", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, "open_cash_secured_put", openPutPayload(ticker.symbol));
    loadRecoveryTargetWindowMock.mockResolvedValue(null);
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, onQuote: (quote: unknown) => void) => {
      onQuote({ delta: -0.2 });
    });
    await readServerSentEvents(`/positions/orders/${orderId}/quote/stream`);
    expect(checkDeltaComplianceMock).toHaveBeenCalledWith(-0.2, null, null);
  });

  it("gives a closing order's quotes no compliance verdict and no position-limit verdict, and pools nothing", async () => {
    const ticker = await createTicker();
    const closePayload = { symbol: ticker.symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "BUY", symbol: ticker.symbol, quantity: 1, unitPrice: 0.5, strike: 90, expiry: "20261120", right: "C" }] };
    const orderId = await insertOrder(ticker.symbol, "close_position", closePayload);
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, onQuote: (quote: unknown) => void) => {
      onQuote({ bid: 0.4, ask: 0.6, delta: 0.3 });
    });
    const { events } = await readServerSentEvents(`/positions/orders/${orderId}/quote/stream`);
    expect(events).toEqual([{ type: "quote", data: { bid: 0.4, ask: 0.6, delta: 0.3, compliance: null, signalLimits: null } }, { type: "done" }]);
    expect(loadRecoveryTargetWindowMock).not.toHaveBeenCalled();
    expect(checkDeltaComplianceMock).not.toHaveBeenCalled();
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
    expect(subscribeToPooledPriceMock).not.toHaveBeenCalled();
    expect(streamOrderLegQuoteMock.mock.calls[0]![3]).toBe(OptionType.Call);
  });

  it("reports a thrown non-error as its text", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, "open_cash_secured_put", openPutPayload(ticker.symbol));
    streamOrderLegQuoteMock.mockRejectedValue("plain text failure");
    const { events } = await readServerSentEvents(`/positions/orders/${orderId}/quote/stream`);
    expect(events).toEqual([{ type: "streamError", message: "plain text failure" }]);
  });

  it("reports a failed quote stream as a streamError frame", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, "open_cash_secured_put", openPutPayload(ticker.symbol));
    streamOrderLegQuoteMock.mockRejectedValue(new Error("contract not found"));
    const { events } = await readServerSentEvents(`/positions/orders/${orderId}/quote/stream`);
    expect(events).toEqual([{ type: "streamError", message: "contract not found" }]);
  });
});

describe("POST /positions/:id/recovery-path", () => {
  async function recoveryFrame() {
    const response = await fetch(`${baseUrl}/positions/${missingId}/recovery-path`, { method: "POST", headers: { "x-test-user-id": userId, "content-type": "application/json" }, body: "{}" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const frames = text.split("\n\n").filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice("data: ".length)));
    expect(frames).toHaveLength(1);
    return frames[0] as { status: number; body: any };
  }

  it("streams the evaluation's outcome as one frame carrying the status a plain route would have sent", async () => {
    const cases: [string, unknown, number, unknown][] = [
      ["not_found", { status: "not_found" }, 404, { error: "Position not found." }],
      ["not_unstructured", { status: "not_unstructured", reason: "Only an open unstructured position can be evaluated for recovery." }, 400, { error: "Only an open unstructured position can be evaluated for recovery." }],
      ["no_shares", { status: "no_shares" }, 422, { error: "No open stock shares held on this position." }],
      ["no_settings", { status: "no_settings" }, 409, { error: "No strategy settings configured for covered calls." }],
    ];
    for (const [label, evaluation, expectedStatus, expectedBody] of cases) {
      evaluateRecoveryPathForPositionMock.mockResolvedValueOnce(evaluation);
      const frame = await recoveryFrame();
      expect(frame, label).toEqual({ status: expectedStatus, body: expectedBody });
    }
    expect(evaluateRecoveryPathForPositionMock).toHaveBeenCalledWith(missingId);
  });

  it("passes the projection through on success, leaving out anything else the evaluation carries", async () => {
    const projection = {
      symbol: "AAA",
      shares: 200,
      entryPrice: 50,
      costBasisPerShare: 48,
      costBasisSource: "ledger",
      currentPrice: 40,
      unrealizedLoss: 1600,
      contractsAvailable: 2,
      candidate: { strike: 45, premium: 1.2, dte: 30 },
      monthlyPremium: 240,
      monthsToRecover: 6.7,
      rationale: "because",
    };
    evaluateRecoveryPathForPositionMock.mockResolvedValue({ status: "ok", ...projection, internalOnly: "not exposed" });
    const frame = await recoveryFrame();
    expect(frame.status).toBe(200);
    expect(frame.body).toEqual(projection);
  });

  it("answers 502 with the message when the evaluation throws", async () => {
    evaluateRecoveryPathForPositionMock.mockRejectedValue(new Error("Gateway unreachable"));
    expect(await recoveryFrame()).toEqual({ status: 502, body: { error: "Gateway unreachable" } });
    evaluateRecoveryPathForPositionMock.mockRejectedValue("plain failure");
    expect(await recoveryFrame()).toEqual({ status: 502, body: { error: "plain failure" } });
  });
});

describe("stream heartbeats, limit refresh and writes after the stream ended", () => {
  const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  // Only the interval timers are faked, so the sockets and database calls keep running on real time.
  async function withFakeIntervals(body: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  }

  it("sends a ping comment every 20 seconds on the Greeks stream", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    streamPooledGreeksMock.mockImplementation(async (_contracts: unknown, _onUpdate: unknown, signal: AbortSignal) => waitForAbort(signal));
    await withFakeIntervals(async () => {
      const stream = await openServerSentStream(`/positions/greeks/stream?legIds=${legIds[0]}`);
      vi.advanceTimersByTime(20_000);
      expect(await stream.nextBlock()).toBe(": ping");
      await stream.close();
    });
  });

  it("sends a ping comment every 20 seconds on the P&L stream", async () => {
    const { positionId } = await createPosition("cash_secured_put", [shortPut(1)]);
    streamPooledPricesMock.mockImplementation(async (_contracts: unknown, _onUpdate: unknown, signal: AbortSignal) => waitForAbort(signal));
    await withFakeIntervals(async () => {
      const stream = await openServerSentStream(`/positions/pnl/stream?positionIds=${positionId}`);
      vi.advanceTimersByTime(20_000);
      expect(await stream.nextBlock()).toBe(": ping");
      await stream.close();
    });
  });

  it("sends a ping comment every 20 seconds on the contract quote stream", async () => {
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, _onQuote: unknown, signal: AbortSignal) => waitForAbort(signal));
    await withFakeIntervals(async () => {
      const stream = await openServerSentStream("/positions/quote/stream?symbol=AAA&expiry=20261120&strike=100&right=C");
      vi.advanceTimersByTime(20_000);
      expect(await stream.nextBlock()).toBe(": ping");
      await stream.close();
    });
  });

  it("re-checks an order's position limits every 10 seconds with the latest spot price, keeps the last verdict when a re-check fails, and pings", async () => {
    const ticker = await createTicker();
    const [order] = await testDb("order_requests")
      .insert({
        requested_by_user_id: userId,
        request_type: "open_cash_secured_put",
        payload: JSON.stringify({ symbol: ticker.symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: ticker.symbol, quantity: 1, unitPrice: 1.5, strike: 90, expiry: "20261120", right: "P" }] }),
      })
      .returning("id");
    let releaseSecondQuote: () => void = () => undefined;
    const secondQuoteGate = new Promise<void>((resolve) => {
      releaseSecondQuote = resolve;
    });
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, onQuote: (quote: unknown) => void, signal: AbortSignal) => {
      onQuote({ delta: -0.25, sequence: 1 });
      await secondQuoteGate;
      onQuote({ delta: -0.25, sequence: 2 });
      await waitForAbort(signal);
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withFakeIntervals(async () => {
        const stream = await openServerSentStream(`/positions/orders/${order.id}/quote/stream`);
        const first = await stream.nextEvent();
        expect(first.data.signalLimits).toEqual(clearLimits);
        await pause(20);

        // The pooled spot price arrives (a null price is ignored), then the limits are re-evaluated with it and now block.
        const onSpotPrice = subscribeToPooledPriceMock.mock.calls[0]![1] as (price: number | null) => void;
        onSpotPrice(null);
        onSpotPrice(101.5);
        evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["moved"] });
        evaluateOrderLimitsMock.mockClear();
        vi.advanceTimersByTime(10_000);
        await pause(50);
        expect(evaluateOrderLimitsMock).toHaveBeenCalledTimes(1);
        expect(evaluateOrderLimitsMock).toHaveBeenCalledWith(expect.objectContaining({ symbol: ticker.symbol, spotPrice: 101.5 }));

        releaseSecondQuote();
        const second = await stream.nextEvent();
        expect(second.data.signalLimits).toEqual({ blocked: true, reasons: ["moved"] });

        // A failing re-check is logged and the last verdict stands; the 20 second mark also pings.
        evaluateOrderLimitsMock.mockRejectedValue(new Error("account summary unreadable"));
        vi.advanceTimersByTime(10_000);
        await pause(50);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("signal limits refresh failed"), expect.any(Error));
        expect(await stream.nextBlock()).toBe(": ping");
        await stream.close();
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps streaming when the spot price subscription fails", async () => {
    const ticker = await createTicker();
    const [order] = await testDb("order_requests")
      .insert({
        requested_by_user_id: userId,
        request_type: "open_cash_secured_put",
        payload: JSON.stringify({ symbol: ticker.symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: ticker.symbol, quantity: 1, unitPrice: 1.5, strike: 90, expiry: "20261120", right: "P" }] }),
      })
      .returning("id");
    subscribeToPooledPriceMock.mockRejectedValue(new Error("pool refused"));
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, onQuote: (quote: unknown) => void) => onQuote({ delta: -0.25 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { events } = await readServerSentEvents(`/positions/orders/${order.id}/quote/stream`);
      expect(events.map((event) => event.type)).toEqual(["quote", "done"]);
      await pause(20);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("spot subscription failed"), expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("writes nothing, and does not fail, when a Greeks update finishes after the stream has ended", async () => {
    const { legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    // The update starts a snapshot lookup, and the producer returns (ending the response) before it completes.
    streamPooledGreeksMock.mockImplementation(async (_contracts: unknown, onUpdate: (greeks: unknown) => void) => {
      onUpdate({});
    });
    const { events } = await readServerSentEvents(`/positions/greeks/stream?legIds=${legIds[0]}`);
    expect(events).toEqual([]);
    await pause(100);
  });

  it("writes nothing, and does not fail, when a P&L update finishes after the stream has ended", async () => {
    const { positionId } = await createPosition("cash_secured_put", [shortPut(1)]);
    streamPooledPricesMock.mockImplementation(async (_contracts: unknown, onUpdate: (prices: unknown) => void) => {
      onUpdate({});
    });
    const { events } = await readServerSentEvents(`/positions/pnl/stream?positionIds=${positionId}`);
    expect(events).toEqual([]);
    await pause(100);
  });

  it("ignores a quote that arrives after the contract quote stream ended", async () => {
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, onQuote: (quote: unknown) => void) => {
      setTimeout(() => onQuote({ delta: 0.3 }), 30);
    });
    const { events } = await readServerSentEvents("/positions/quote/stream?symbol=AAA&expiry=20261120&strike=100&right=C");
    expect(events).toEqual([{ type: "done" }]);
    await pause(80);
  });

  it("ignores a quote that arrives after an order's quote stream ended", async () => {
    const ticker = await createTicker();
    const [order] = await testDb("order_requests")
      .insert({
        requested_by_user_id: userId,
        request_type: "close_position",
        payload: JSON.stringify({ symbol: ticker.symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "BUY", symbol: ticker.symbol, quantity: 1, unitPrice: 0.5, strike: 90, expiry: "20261120", right: "P" }] }),
      })
      .returning("id");
    streamOrderLegQuoteMock.mockImplementation(async (_symbol: string, _expiry: string, _strike: number, _right: unknown, onQuote: (quote: unknown) => void) => {
      setTimeout(() => onQuote({ delta: 0.3 }), 30);
    });
    const { events } = await readServerSentEvents(`/positions/orders/${order.id}/quote/stream`);
    expect(events).toEqual([{ type: "done" }]);
    await pause(80);
  });
});
