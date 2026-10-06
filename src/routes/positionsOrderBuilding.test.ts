import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import knexLibrary, { type Knex } from "knex";

// The real positionsRouter on a small express app against the test database, for the order-building, listing and cancel routes. Every IBKR /
// pool / market boundary the router imports is mocked, so nothing network-bound runs; the gate verdicts come from mocks of the gate inputs.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run positions order route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 6 } }) };
});

vi.mock("../lib/tradingGate.js", () => ({ fetchTradingBlockedReason: async () => null }));
vi.mock("../lib/orderLimits.js", () => ({ evaluateOrderLimits: async () => ({ blocked: false, reasons: [] }) }));
vi.mock("../lib/deltaBandGate.js", () => ({ evaluateDeltaBandForOrderRequest: async () => null }));
vi.mock("../lib/limitPriceCheckGate.js", () => ({ evaluateLimitPriceCheckForOrderRequest: async () => ({ blocked: false, reasons: [], legs: [] }) }));

const evaluateCloseGateForPositionMock = vi.fn();
vi.mock("../lib/closeGate.js", () => ({ evaluateCloseGateForPosition: (...args: unknown[]) => evaluateCloseGateForPositionMock(...args) }));

const publishNotificationMock = vi.fn();
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: (...args: unknown[]) => publishNotificationMock(...args) }));

const fetchEconomicCalendarWarningEventsMock = vi.fn();
vi.mock("../ibkr/calendarConflict.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/calendarConflict.js")>("../ibkr/calendarConflict.js");
  return { ...actual, fetchEconomicCalendarWarningEvents: (...args: unknown[]) => fetchEconomicCalendarWarningEventsMock(...args) };
});

const fetchPricesPoolFirstMock = vi.fn();
vi.mock("../ibkr/pricePool.js", () => ({
  fetchPricesPoolFirst: (...args: unknown[]) => fetchPricesPoolFirstMock(...args),
  streamPooledPrices: vi.fn(),
  subscribeToPooledPrice: vi.fn(),
}));

const peekPooledQuoteMock = vi.fn();
vi.mock("../ibkr/marketDataPool.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/marketDataPool.js")>("../ibkr/marketDataPool.js");
  return { ...actual, peekPooledQuote: (...args: unknown[]) => peekPooledQuoteMock(...args) };
});

const getRiskFreeRateMock = vi.fn();
vi.mock("../lib/riskFreeRate.js", () => ({ getRiskFreeRate: (...args: unknown[]) => getRiskFreeRateMock(...args) }));

vi.mock("../ibkr/greeksPool.js", () => ({ fetchGreeksPoolFirst: vi.fn(), streamPooledGreeks: vi.fn() }));
vi.mock("../ibkr/streamOrderLegQuote.js", () => ({ streamOrderLegQuote: vi.fn(), checkDeltaCompliance: vi.fn() }));
vi.mock("../ibkr/evaluateRecoveryPathForPosition.js", () => ({ evaluateRecoveryPathForPosition: vi.fn() }));
vi.mock("../lib/pulseChartSampleCollector.js", () => ({ recordUnrealizedPnlSample: vi.fn(), recordLegDeltaSample: vi.fn() }));
vi.mock("./positionCloseLive.js", () => ({ streamCloseLiveHandler: vi.fn() }));
vi.mock("./positionCycleMarks.js", () => ({ getCycleMarksHandler: vi.fn() }));

const { db } = await import("../db/connection.js");
const { positionsRouter, sharesCommittedByInFlightCoveredCalls } = await import("./positions.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
let otherUserId: string;
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
let listener: pg.Client;
const notifiedOrderIds: string[] = [];
let symbolCounter = Date.now() % 100_000;

const missingId = "00000000-0000-4000-8000-000000000000";
const userDisplayName = "Positions Orders Test";
const otherUserDisplayName = "Positions Orders Other";

beforeAll(async () => {
  const stamp = Date.now();
  const [user] = await testDb("users").insert({ username: `pos-orders-${stamp}`, display_name: userDisplayName, password_hash: "not-a-real-hash" }).returning("id");
  const [otherUser] = await testDb("users").insert({ username: `pos-orders-other-${stamp}`, display_name: otherUserDisplayName, password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  otherUserId = otherUser.id;

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

  listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await listener.connect();
  listener.on("notification", (message) => {
    if (message.channel === "order_requests_channel" && message.payload) notifiedOrderIds.push(message.payload);
  });
  await listener.query("LISTEN order_requests_channel");
});

afterAll(async () => {
  await listener.query("UNLISTEN *");
  await listener.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanRows();
  await testDb("users").whereIn("id", [userId, otherUserId]).del();
  await testDb.destroy();
});

async function cleanRows(): Promise<void> {
  await testDb("order_requests").whereIn("requested_by_user_id", [userId, otherUserId]).del();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  createdPositionIds.length = 0;
  createdTickerIds.length = 0;
}

afterEach(cleanRows);

beforeEach(() => {
  notifiedOrderIds.length = 0;
  evaluateCloseGateForPositionMock.mockReset().mockResolvedValue({ blocked: false, reason: null, cycleTotal: 7 });
  publishNotificationMock.mockReset().mockResolvedValue(undefined);
  fetchEconomicCalendarWarningEventsMock.mockReset().mockResolvedValue([]);
  fetchPricesPoolFirstMock.mockReset().mockResolvedValue({ stock: 100 });
  peekPooledQuoteMock.mockReset().mockReturnValue(null);
  getRiskFreeRateMock.mockReset().mockResolvedValue(0.04);
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

/** A short pause so a notification that must NOT arrive has had the chance to. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function waitForNotificationCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && notifiedOrderIds.length < expected; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = `PXO${(symbolCounter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Positions Orders Test Co", sector: "Technology" }).returning(["id", "symbol"]);
  createdTickerIds.push(ticker.id);
  return ticker;
}

interface LegSpec {
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType?: "call" | "put";
  strikePrice?: number;
  expiryDate?: string | null;
  multiplier?: number;
  entryPrice?: number;
  exitPrice?: number | null;
  exitAt?: Date | null;
  ibkrContractId?: string;
}

/** A position with its legs. Inserted closed and flipped to open only once the legs exist (see positionQueries.test.ts for why). */
async function createPosition(strategyKey: string, legs: LegSpec[], options: { status?: "open" | "closed"; tickerId?: string; symbol?: string } = {}): Promise<{ positionId: string; symbol: string; tickerId: string; legIds: string[] }> {
  const ticker = options.tickerId ? { id: options.tickerId, symbol: options.symbol! } : await createTicker();
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: ticker.id, status: "closed", closed_at: new Date() }).returning("id");
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
        expiry_date: spec.expiryDate === undefined ? (spec.legType === "option" ? "2030-01-18" : null) : spec.expiryDate,
        multiplier: spec.multiplier ?? (spec.legType === "option" ? 100 : 1),
        entry_price: spec.entryPrice ?? 2,
        entry_at: new Date(Date.now() - 86_400_000),
        exit_price: spec.exitPrice ?? null,
        exit_at: spec.exitAt ?? null,
        ibkr_contract_id: spec.ibkrContractId ?? null,
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

async function insertOrder(symbol: string, overrides: Record<string, unknown> = {}, payload?: unknown): Promise<string> {
  const defaultPayload = { symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol, quantity: 2, unitPrice: 1.5, strike: 90, expiry: "20261120", right: "P" }] };
  const [row] = await testDb("order_requests")
    .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify(payload ?? defaultPayload), ...overrides })
    .returning("id");
  return row.id;
}

async function orderRow(orderId: string) {
  return testDb("order_requests").where({ id: orderId }).first();
}

async function orderCount(): Promise<number> {
  return Number((await testDb("order_requests").whereIn("requested_by_user_id", [userId, otherUserId]).count({ count: "*" }).first())!.count);
}

const sortedByRole = <Leg extends { role: string }>(legs: Leg[]): Leg[] => [...legs].sort((first, second) => first.role.localeCompare(second.role));

describe("authentication", () => {
  it("refuses every route here without a session and builds nothing", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    const attempts: [("GET" | "POST"), string, unknown?][] = [
      ["POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { quantity: 1, limitPrice: 1, strikePrice: 90, expiryDate: "20261120" } }],
      ["GET", "/positions/orders"],
      ["GET", "/positions/orders/today"],
      ["GET", `/positions/orders/${orderId}`],
      ["POST", `/positions/orders/${orderId}/cancel`, {}],
      ["POST", `/positions/${missingId}/roll`, {}],
      ["GET", `/positions/${missingId}`],
      ["GET", "/positions"],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call(method, path, body, { asUser: null });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.json).toEqual({ error: "Not logged in." });
    }
    expect(await orderCount()).toBe(1);
    expect((await orderRow(orderId)).status).toBe("pending_confirmation");
  });
});

describe("POST /positions/orders: cash-secured put details", () => {
  const optionBody = { quantity: 2, limitPrice: 1.5, strikePrice: 90, expiryDate: "20261120" };

  it("normalizes a dashed or slashed expiry to YYYYMMDD in the stored payload and in the calendar lookup", async () => {
    const ticker = await createTicker();
    for (const expiryDate of ["2026-11-20", "2026/11/20"]) {
      const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { ...optionBody, expiryDate } });
      expect(response.status).toBe(201);
      expect(response.json.payload.legs[0].expiry).toBe("20261120");
      expect(fetchEconomicCalendarWarningEventsMock).toHaveBeenLastCalledWith("20261120");
    }
  });

  it("rounds each leg's unit price to the cent and stores the rounded figure", async () => {
    const ticker = await createTicker();
    const rounded: [number, number][] = [
      [1.504, 1.5],
      [1.506, 1.51],
      [0.014, 0.01],
      [0.016, 0.02],
      [2, 2],
    ];
    for (const [limitPrice, expectedUnitPrice] of rounded) {
      const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { ...optionBody, limitPrice } });
      expect(response.status, String(limitPrice)).toBe(201);
      expect(response.json.payload.legs[0].unitPrice, String(limitPrice)).toBe(expectedUnitPrice);
      expect((await orderRow(response.json.id)).payload.legs[0].unitPrice).toBe(expectedUnitPrice);
    }
  });

  it("stores the strike as given (decimals kept) and builds a SELL put leg with no stock leg", async () => {
    const ticker = await createTicker();
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { ...optionBody, strikePrice: 87.5 } });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs).toEqual([{ role: "option", action: "SELL", symbol: ticker.symbol, quantity: 2, unitPrice: 1.5, strike: 87.5, expiry: "20261120", right: "P" }]);
  });

  it("ignores a stock object sent with a cash-secured put, even a nonsensical one", async () => {
    const ticker = await createTicker();
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, stock: { quantity: -5, limitPrice: "x" } });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs).toHaveLength(1);
    expect(response.json.payload.legs[0].role).toBe("option");
    expect(fetchPricesPoolFirstMock).not.toHaveBeenCalled();
  });

  it("stores the risk-free rate on the order, or null when it cannot be read", async () => {
    const ticker = await createTicker();
    const withRate = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody });
    expect(withRate.json.riskFreeRate).toBeCloseTo(0.04, 6);
    expect((await orderRow(withRate.json.id)).risk_free_rate).toBeCloseTo(0.04, 6);

    getRiskFreeRateMock.mockRejectedValue(new Error("FRED unreachable"));
    const withoutRate = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody });
    expect(withoutRate.status).toBe(201);
    expect(withoutRate.json.riskFreeRate).toBeNull();
    expect((await orderRow(withoutRate.json.id)).risk_free_rate).toBeNull();
  });

  it("rejects each malformed option field with its own message and builds nothing", async () => {
    const ticker = await createTicker();
    const cases: [string, unknown, string][] = [
      ["no option object", undefined, "A positive whole number of option contracts is required."],
      ["limit price as a string", { ...optionBody, limitPrice: "1.5" }, "option.limitPrice must be a positive number — a short option is never sold for $0."],
      ["negative limit price", { ...optionBody, limitPrice: -1 }, "option.limitPrice must be a positive number — a short option is never sold for $0."],
      ["missing limit price", { quantity: 2, strikePrice: 90, expiryDate: "20261120" }, "option.limitPrice must be a positive number — a short option is never sold for $0."],
      ["a price that rounds to $0.00 (0.004)", { ...optionBody, limitPrice: 0.004 }, "option.limitPrice must be a positive number — a short option is never sold for $0."],
      ["a price just under half a cent (0.0049)", { ...optionBody, limitPrice: 0.0049 }, "option.limitPrice must be a positive number — a short option is never sold for $0."],
      ["zero strike", { ...optionBody, strikePrice: 0 }, "option.strikePrice and option.expiryDate are required."],
      ["negative strike", { ...optionBody, strikePrice: -90 }, "option.strikePrice and option.expiryDate are required."],
      ["strike as a string", { ...optionBody, strikePrice: "90" }, "option.strikePrice and option.expiryDate are required."],
      ["missing expiry", { quantity: 2, limitPrice: 1.5, strikePrice: 90 }, "option.strikePrice and option.expiryDate are required."],
      ["empty expiry", { ...optionBody, expiryDate: "" }, "option.strikePrice and option.expiryDate are required."],
      ["expiry with seven digits", { ...optionBody, expiryDate: "2026112" }, 'option.expiryDate must be a YYYYMMDD date, got "2026112".'],
      ["expiry of letters", { ...optionBody, expiryDate: "next friday" }, 'option.expiryDate must be a YYYYMMDD date, got "next friday".'],
    ];
    for (const [label, option, message] of cases) {
      const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option });
      expect(response.status, label).toBe(400);
      expect(response.json.error, label).toBe(message);
    }
    expect(await orderCount()).toBe(0);
  });

  it("refuses a whitespace-only symbol and a missing body field before looking anything up", async () => {
    expect((await call("POST", "/positions/orders", { symbol: "   ", strategyKey: "cash_secured_put", option: optionBody })).json.error).toBe("Symbol is required.");
    expect((await call("POST", "/positions/orders", { symbol: "X", option: optionBody })).json.error).toBe("A valid strategyKey is required.");
    expect((await call("POST", "/positions/orders", { symbol: "X", strategyKey: "unstructured", option: optionBody })).json.error).toBe("A valid strategyKey is required.");
    expect(await orderCount()).toBe(0);
  });
});

describe("POST /positions/orders: Signals snapshot", () => {
  const optionBody = { quantity: 1, limitPrice: 1.5, strikePrice: 90, expiryDate: "20261120" };

  it("refuses a snapshot that is not a plain object, and builds nothing", async () => {
    const ticker = await createTicker();
    for (const signalSnapshot of [[1, 2], "text", 7, true]) {
      const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, signalSnapshot });
      expect(response.status, JSON.stringify(signalSnapshot)).toBe(400);
      expect(response.json.error).toBe("signalSnapshot must be an object.");
    }
    expect(await orderCount()).toBe(0);
  });

  it("stores no snapshot when none or null is sent", async () => {
    const ticker = await createTicker();
    const none = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody });
    const asNull = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, signalSnapshot: null });
    expect((await orderRow(none.json.id)).signal_snapshot).toBeNull();
    expect((await orderRow(asNull.json.id)).signal_snapshot).toBeNull();
  });

  it("allows a snapshot of exactly 16384 characters and refuses one of 16385", async () => {
    const ticker = await createTicker();
    // {"candidate":{"quoteSource":"live"},"padding":"<n x>"} -> measure the empty frame, then fill to the limit.
    const frame = (padding: string) => ({ candidate: { quoteSource: "live" }, padding });
    const frameLength = JSON.stringify(frame("")).length;
    const atLimit = frame("x".repeat(16_384 - frameLength));
    expect(JSON.stringify(atLimit).length).toBe(16_384);
    const accepted = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, signalSnapshot: atLimit });
    expect(accepted.status).toBe(201);

    const overLimit = frame("x".repeat(16_385 - frameLength));
    const refused = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, signalSnapshot: overLimit });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("signalSnapshot is too large.");
  });

  it("refuses a live-labelled quote that is older than 15 seconds with 409", async () => {
    const ticker = await createTicker();
    const staleSnapshot = { candidate: { quoteSource: "live", quotedAt: new Date(Date.now() - 60_000).toISOString() } };
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, signalSnapshot: staleSnapshot });
    expect(response.status).toBe(409);
    expect(response.json.error).toBe("The contract's live quote is older than 15 seconds. Wait for live prices and build the order again.");
    expect(await orderCount()).toBe(0);
  });

  it("accepts a live quote stamped a few seconds ago", async () => {
    const ticker = await createTicker();
    const freshSnapshot = { candidate: { quoteSource: "live", quotedAt: new Date(Date.now() - 3_000).toISOString() } };
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, signalSnapshot: freshSnapshot });
    expect(response.status).toBe(201);
  });
});

describe("POST /positions/orders: covered call", () => {
  const callOption = (quantity: number) => ({ quantity, limitPrice: 1.5, strikePrice: 105, expiryDate: "20261120" });

  it("auto-fills a standard buy-write at the last price: 2 contracts need 200 shares, bought at the cent-rounded last price", async () => {
    const ticker = await createTicker();
    fetchPricesPoolFirstMock.mockResolvedValue({ stock: 100.456 });
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(2) });
    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({ requestType: "open_covered_call", status: "pending_confirmation", note: null });
    expect(response.json.payload).toEqual({
      symbol: ticker.symbol,
      strategyKey: "covered_call",
      legs: [
        { role: "stock", action: "BUY", symbol: ticker.symbol, quantity: 200, unitPrice: 100.46 },
        { role: "option", action: "SELL", symbol: ticker.symbol, quantity: 2, unitPrice: 1.5, strike: 105, expiry: "20261120", right: "C" },
      ],
    });
    expect(fetchPricesPoolFirstMock).toHaveBeenCalledWith([{ key: "stock", legType: "stock", symbol: ticker.symbol }]);
    expect((await orderRow(response.json.id)).request_type).toBe("open_covered_call");
  });

  it("prices the stock leg at the mid of a pooled two-sided quote when there is one", async () => {
    const ticker = await createTicker();
    fetchPricesPoolFirstMock.mockResolvedValue({ stock: 100.456 });
    peekPooledQuoteMock.mockReturnValue({ bid: 99.9, ask: 100.2 });
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(1) });
    expect(response.status).toBe(201);
    // (99.9 + 100.2) / 2 = 100.05, not the last price 100.456.
    expect(response.json.payload.legs[0]).toMatchObject({ role: "stock", quantity: 100, unitPrice: 100.05 });
    expect(peekPooledQuoteMock).toHaveBeenCalledWith({ key: "stock", legType: "stock", symbol: ticker.symbol });
  });

  it("falls back to the last price when the pooled quote has a zero bid", async () => {
    const ticker = await createTicker();
    fetchPricesPoolFirstMock.mockResolvedValue({ stock: 100.456 });
    peekPooledQuoteMock.mockReturnValue({ bid: 0, ask: 100.2 });
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(1) });
    expect(response.json.payload.legs[0].unitPrice).toBe(100.46);
  });

  it("answers 400 when no live stock price can be read for the auto-fill, and builds nothing", async () => {
    const ticker = await createTicker();
    for (const livePrices of [{ stock: null }, {}]) {
      fetchPricesPoolFirstMock.mockResolvedValue(livePrices);
      const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(1) });
      expect(response.status).toBe(400);
      expect(response.json.error).toBe("Could not fetch a live stock price to auto-fill the stock leg (markets may be closed) — pass stock.quantity/stock.limitPrice explicitly.");
    }
    expect(await orderCount()).toBe(0);
  });

  it("builds no stock leg when uncovered shares already held cover the contracts, and notes the surplus: 150 held, 1 contract uses 100, 50 left", async () => {
    const { symbol } = await createPosition("unstructured", [longStock(150)]);
    const response = await call("POST", "/positions/orders", { symbol, strategyKey: "covered_call", option: callOption(1) });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs).toEqual([{ role: "option", action: "SELL", symbol, quantity: 1, unitPrice: 1.5, strike: 105, expiry: "20261120", right: "C" }]);
    expect(response.json.note).toBe(`50 uncovered share(s) of ${symbol} remain beyond what this order uses — worth checking whether an additional contract is worth selling.`);
    expect(fetchPricesPoolFirstMock).not.toHaveBeenCalled();
  });

  it("buys only the shortfall when held uncovered shares cover part of the contracts: 150 held, 2 contracts need 200, buy 50", async () => {
    const { symbol } = await createPosition("unstructured", [longStock(150)]);
    fetchPricesPoolFirstMock.mockResolvedValue({ stock: 60 });
    const response = await call("POST", "/positions/orders", { symbol, strategyKey: "covered_call", option: callOption(2) });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs[0]).toEqual({ role: "stock", action: "BUY", symbol, quantity: 50, unitPrice: 60 });
    expect(response.json.note).toBeNull();
  });

  it("counts only open, unsold, long shares on unstructured positions as uncovered", async () => {
    const ticker = await createTicker();
    const symbol = ticker.symbol;
    await createPosition("unstructured", [longStock(100, { exitPrice: 51, exitAt: new Date() })], { tickerId: ticker.id, symbol });
    await createPosition("unstructured", [longStock(300)], { tickerId: ticker.id, symbol, status: "closed" });
    await createPosition("covered_call", [longStock(100), shortCall(1)], { tickerId: ticker.id, symbol });
    const response = await call("POST", "/positions/orders", { symbol, strategyKey: "covered_call", option: callOption(1) });
    // None of those shares is free to cover a new call, so the full 100 are bought.
    expect(response.json.payload.legs[0]).toMatchObject({ role: "stock", quantity: 100 });
    expect(response.json.note).toBeNull();
  });

  it("subtracts the shares in-flight covered-call orders already count on: 150 held, 100 spoken for by an order in flight, 50 free", async () => {
    const { symbol } = await createPosition("unstructured", [longStock(150)]);
    const coveredCallPayload = (quantity: number, stockQuantity: number | null) => ({
      symbol,
      strategyKey: "covered_call",
      legs: [
        ...(stockQuantity === null ? [] : [{ role: "stock", action: "BUY", symbol, quantity: stockQuantity, unitPrice: 50 }]),
        { role: "option", action: "SELL", symbol, quantity, unitPrice: 1.5, strike: 105, expiry: "20261120", right: "C" },
      ],
    });
    await insertOrder(symbol, { request_type: "open_covered_call" }, coveredCallPayload(1, null));
    // None of these counts: finished, a roll rather than an open, and another symbol.
    await insertOrder(symbol, { request_type: "open_covered_call", status: "cancelled" }, coveredCallPayload(5, null));
    await insertOrder(symbol, { request_type: "roll_leg" }, coveredCallPayload(5, null));
    await insertOrder("SOMEOTHER", { request_type: "open_covered_call" }, { ...coveredCallPayload(5, null), symbol: "SOMEOTHER" });

    fetchPricesPoolFirstMock.mockResolvedValue({ stock: 60 });
    const response = await call("POST", "/positions/orders", { symbol, strategyKey: "covered_call", option: callOption(1) });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs[0]).toMatchObject({ role: "stock", quantity: 50 });
  });

  it("never counts a negative number of free shares when in-flight orders commit more than are held", async () => {
    const { symbol } = await createPosition("unstructured", [longStock(50)]);
    await insertOrder(
      symbol,
      { request_type: "open_covered_call" },
      { symbol, strategyKey: "covered_call", legs: [{ role: "option", action: "SELL", symbol, quantity: 3, unitPrice: 1, strike: 105, expiry: "20261120", right: "C" }] },
    );
    const response = await call("POST", "/positions/orders", { symbol, strategyKey: "covered_call", option: callOption(1) });
    expect(response.json.payload.legs[0]).toMatchObject({ role: "stock", quantity: 100 });
    expect(response.json.note).toBeNull();
  });

  it("uses an explicit stock override exactly as given, without netting held shares or reading a price", async () => {
    const { symbol } = await createPosition("unstructured", [longStock(150)]);
    const response = await call("POST", "/positions/orders", { symbol, strategyKey: "covered_call", option: callOption(1), stock: { quantity: 120, limitPrice: 50.126 } });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs[0]).toEqual({ role: "stock", action: "BUY", symbol, quantity: 120, unitPrice: 50.13 });
    expect(response.json.note).toBeNull();
    expect(fetchPricesPoolFirstMock).not.toHaveBeenCalled();
  });

  it("blocks a naked call in the explicit path: 3 contracts need 300 shares, 299 is refused, 300 and 301 are built", async () => {
    const ticker = await createTicker();
    const build = (stockQuantity: number) => call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(3), stock: { quantity: stockQuantity, limitPrice: 50 } });

    const refused = await build(299);
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("Short call coverage (300 shares) exceeds stock held (299 shares) — this would leave the position naked.");
    expect(await orderCount()).toBe(0);

    expect((await build(300)).status).toBe(201);
    expect((await build(301)).status).toBe(201);
    expect(await orderCount()).toBe(2);
  });

  it("accepts the smallest price that survives rounding (0.005 becomes $0.01)", async () => {
    const ticker = await createTicker();
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { quantity: 2, limitPrice: 0.005, strikePrice: 90, expiryDate: "20261120" } });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs[0].unitPrice).toBe(0.01);
  });

  it("refuses a null or non-object stock on a covered call with a 400 instead of failing", async () => {
    const ticker = await createTicker();
    for (const stock of [null, "100 shares", 100, true]) {
      const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(1), stock });
      expect(response.status, JSON.stringify(stock)).toBe(400);
      expect(response.json.error).toBe("stock must be an object with quantity and limitPrice when provided.");
    }
  });

  it("allows a free stock leg (limit price 0) but not a negative one", async () => {
    const ticker = await createTicker();
    const free = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(1), stock: { quantity: 100, limitPrice: 0 } });
    expect(free.status).toBe(201);
    expect(free.json.payload.legs[0].unitPrice).toBe(0);
    const negative = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(1), stock: { quantity: 100, limitPrice: -1 } });
    expect(negative.status).toBe(400);
    expect(negative.json.error).toBe("stock.limitPrice must be a non-negative number.");
    const asText = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "covered_call", option: callOption(1), stock: { quantity: 100, limitPrice: "50" } });
    expect(asText.status).toBe(400);
    expect(asText.json.error).toBe("stock.limitPrice must be a non-negative number.");
  });
});

describe("sharesCommittedByInFlightCoveredCalls", () => {
  it("is zero for a symbol with no orders", async () => {
    expect(await sharesCommittedByInFlightCoveredCalls("NOORDERSHERE")).toBe(0);
  });

  it("sums contracts x 100 minus bought shares over the symbol's active covered-call opens, and ignores everything else", async () => {
    const ticker = await createTicker();
    const symbol = ticker.symbol;
    const coveredCall = (optionQuantity: number, stockQuantity?: number) => ({
      symbol,
      strategyKey: "covered_call",
      legs: [
        ...(stockQuantity === undefined ? [] : [{ role: "stock", action: "BUY", symbol, quantity: stockQuantity, unitPrice: 50 }]),
        { role: "option", action: "SELL", symbol, quantity: optionQuantity, unitPrice: 1, strike: 105, expiry: "20261120", right: "C" },
      ],
    });
    // Counts: 3 bare contracts = 300; 2 contracts with 150 bought = 50; one buying more than it covers = 0.
    await insertOrder(symbol, { request_type: "open_covered_call", status: "pending_confirmation" }, coveredCall(3));
    await insertOrder(symbol, { request_type: "open_covered_call", status: "confirmed" }, coveredCall(2, 150));
    await insertOrder(symbol, { request_type: "open_covered_call", status: "submitted" }, coveredCall(1, 200));
    // Ignored: finished statuses, a cash-secured put, a close, and a roll.
    for (const status of ["filled", "cancelled", "rejected", "error"]) await insertOrder(symbol, { request_type: "open_covered_call", status }, coveredCall(9));
    await insertOrder(symbol, { request_type: "open_cash_secured_put" }, { symbol, strategyKey: "cash_secured_put", legs: coveredCall(9).legs });
    await insertOrder(symbol, { request_type: "close_position" }, coveredCall(9));
    await insertOrder(symbol, { request_type: "roll_leg" }, coveredCall(9));

    expect(await sharesCommittedByInFlightCoveredCalls(symbol)).toBe(350);
    expect(await sharesCommittedByInFlightCoveredCalls(`${symbol}X`)).toBe(0);
  });

  it("counts the working states past confirmation too (partially filled, cancel requested)", async () => {
    const ticker = await createTicker();
    const symbol = ticker.symbol;
    const payload = { symbol, strategyKey: "covered_call", legs: [{ role: "option", action: "SELL", symbol, quantity: 1, unitPrice: 1, strike: 105, expiry: "20261120", right: "C" }] };
    await insertOrder(symbol, { request_type: "open_covered_call", status: "partially_filled" }, payload);
    await insertOrder(symbol, { request_type: "open_covered_call", status: "cancel_requested" }, payload);
    expect(await sharesCommittedByInFlightCoveredCalls(symbol)).toBe(200);
  });
});

describe("GET /positions/orders, /orders/today and /orders/:id", () => {
  it("lists orders newest first with the requester's display name, and filters by status", async () => {
    const ticker = await createTicker();
    const olderId = await insertOrder(ticker.symbol, { status: "filled", created_at: new Date(Date.now() - 3_600_000) });
    const newerId = await insertOrder(ticker.symbol, { status: "filled", created_at: new Date(Date.now() - 60_000) });
    const pendingId = await insertOrder(ticker.symbol);

    const all = await call("GET", "/positions/orders");
    expect(all.status).toBe(200);
    const allIds: string[] = all.json.map((order: { id: string }) => order.id);
    for (const id of [olderId, newerId, pendingId]) expect(allIds).toContain(id);
    expect(allIds.indexOf(newerId)).toBeLessThan(allIds.indexOf(olderId));
    const newest = all.json.find((order: { id: string }) => order.id === newerId);
    expect(newest.requestedByDisplayName).toBe(userDisplayName);
    expect(newest.requestedByUserId).toBe(userId);

    const filled = await call("GET", "/positions/orders?status=filled");
    expect(filled.json.every((order: { status: string }) => order.status === "filled")).toBe(true);
    const filledIds: string[] = filled.json.map((order: { id: string }) => order.id);
    expect(filledIds).toContain(olderId);
    expect(filledIds).toContain(newerId);
    expect(filledIds).not.toContain(pendingId);

    const none = await call("GET", "/positions/orders?status=rejected");
    expect(none.json.map((order: { id: string }) => order.id)).not.toContain(pendingId);
  });

  it("returns one order in the camelCase shape, with both display names once it was cancelled by another user", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, { status: "cancelled", cancelled_by_user_id: otherUserId, cancellation_reason: "expired_at_close", error_message: "boom", ibkr_order_id: 42 });
    const response = await call("GET", `/positions/orders/${orderId}`);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      id: orderId,
      requestType: "open_cash_secured_put",
      status: "cancelled",
      ibkrOrderId: 42,
      errorMessage: "boom",
      requestedByUserId: userId,
      requestedByDisplayName: userDisplayName,
      cancelledByUserId: otherUserId,
      cancelledByDisplayName: otherUserDisplayName,
      cancellationReason: "expired_at_close",
      relatedPositionId: null,
      calendarWarning: null,
      calendarWarningEvents: null,
      riskFreeRate: null,
    });
    expect(response.json.payload.symbol).toBe(ticker.symbol);
    expect(Object.keys(response.json).sort()).toEqual(
      [
        "calendarWarning", "calendarWarningEvents", "cancellationReason", "cancelledByDisplayName", "cancelledByUserId", "createdAt", "errorMessage", "ibkrOrderId", "id",
        "payload", "plutoActionId", "relatedPositionId", "requestType", "requestedByDisplayName", "requestedByUserId", "riskFreeRate", "status", "updatedAt",
      ].sort(),
    );
  });

  it("answers 404 for an unknown order id", async () => {
    const response = await call("GET", `/positions/orders/${missingId}`);
    expect(response.status).toBe(404);
    expect(response.json).toEqual({ error: "Order not found." });
  });

  it("lists today's orders: an order updated now, and an old order still active, but not an old finished one", async () => {
    const ticker = await createTicker();
    const longAgo = new Date(Date.now() - 5 * 86_400_000);
    const updatedNowId = await insertOrder(ticker.symbol, { status: "filled" });
    const oldActiveId = await insertOrder(ticker.symbol, { status: "submitted", created_at: longAgo, updated_at: longAgo });
    const oldFinishedId = await insertOrder(ticker.symbol, { status: "filled", created_at: longAgo, updated_at: longAgo });

    const response = await call("GET", "/positions/orders/today");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.json)).toBe(true);
    const ids: string[] = response.json.map((order: { id: string }) => order.id);
    expect(ids).toContain(updatedNowId);
    expect(ids).toContain(oldActiveId);
    expect(ids).not.toContain(oldFinishedId);
    const today = response.json.find((order: { id: string }) => order.id === updatedNowId);
    expect(today).toMatchObject({ requestType: "open_cash_secured_put", status: "filled", symbol: ticker.symbol, strategyKey: "cash_secured_put", requestedByDisplayName: userDisplayName, netLimitPrice: -1.5 });
    expect(today.legs).toEqual([{ role: "option", action: "SELL", quantity: 2, unitPrice: 1.5, strike: 90, expiry: "20261120", right: "P", filledQuantity: 0, averageFillPrice: null }]);
  });
});

describe("POST /positions/orders/:id/cancel", () => {
  it("answers 404 for an unknown order", async () => {
    const response = await call("POST", `/positions/orders/${missingId}/cancel`, {});
    expect(response.status).toBe(404);
    expect(response.json).toEqual({ error: "Order not found." });
  });

  for (const status of ["pending_confirmation", "confirmed"]) {
    it(`cancels a ${status} order locally: status cancelled, the canceller recorded, the app notified, the worker never told`, async () => {
      const ticker = await createTicker();
      const orderId = await insertOrder(ticker.symbol, { status });
      const response = await call("POST", `/positions/orders/${orderId}/cancel`, {});
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({ id: orderId, status: "cancelled", cancelledByUserId: userId, cancelledByDisplayName: userDisplayName });
      const row = await orderRow(orderId);
      expect(row.status).toBe("cancelled");
      expect(row.cancelled_by_user_id).toBe(userId);
      expect(new Date(row.updated_at).getTime()).toBeGreaterThan(Date.now() - 10_000);
      expect(publishNotificationMock).toHaveBeenCalledWith({ type: "order_status", orderId });
      await settle();
      expect(notifiedOrderIds).toEqual([]);
    });
  }

  for (const status of ["submitted", "partially_filled"]) {
    it(`asks the worker to cancel a ${status} order: status cancel_requested, the worker notified once, the app notified`, async () => {
      const ticker = await createTicker();
      const orderId = await insertOrder(ticker.symbol, { status });
      const response = await call("POST", `/positions/orders/${orderId}/cancel`, {});
      expect(response.status).toBe(200);
      expect(response.json).toMatchObject({ id: orderId, status: "cancel_requested", cancelledByUserId: userId });
      expect((await orderRow(orderId)).status).toBe("cancel_requested");
      expect((await orderRow(orderId)).cancelled_by_user_id).toBe(userId);
      await waitForNotificationCount(1);
      await settle();
      expect(notifiedOrderIds).toEqual([orderId]);
      expect(publishNotificationMock).toHaveBeenCalledWith({ type: "order_status", orderId });
    });
  }

  it("refuses a second cancel of an order whose cancellation is already requested", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, { status: "submitted" });
    expect((await call("POST", `/positions/orders/${orderId}/cancel`, {})).status).toBe(200);
    await waitForNotificationCount(1);
    publishNotificationMock.mockClear();
    const second = await call("POST", `/positions/orders/${orderId}/cancel`, {});
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "Cancellation already requested for this order." });
    expect((await orderRow(orderId)).status).toBe("cancel_requested");
    await settle();
    expect(notifiedOrderIds).toEqual([orderId]);
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  for (const status of ["filled", "cancelled", "rejected", "error", "cancelled_partially_filled"]) {
    it(`refuses to cancel an order that already reached ${status}, leaving it untouched`, async () => {
      const ticker = await createTicker();
      const orderId = await insertOrder(ticker.symbol, { status });
      const before = await orderRow(orderId);
      const response = await call("POST", `/positions/orders/${orderId}/cancel`, {});
      expect(response.status).toBe(409);
      expect(response.json).toEqual({ error: "This order has already reached a final status and can't be cancelled." });
      const after = await orderRow(orderId);
      expect(after.status).toBe(status);
      expect(after.cancelled_by_user_id).toBeNull();
      expect(after.updated_at).toEqual(before.updated_at);
      await settle();
      expect(notifiedOrderIds).toEqual([]);
      expect(publishNotificationMock).not.toHaveBeenCalled();
    });
  }

  it("lets any signed-in user cancel another user's order, recording who did it", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    const response = await call("POST", `/positions/orders/${orderId}/cancel`, {}, { asUser: otherUserId });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ status: "cancelled", requestedByUserId: userId, cancelledByUserId: otherUserId, cancelledByDisplayName: otherUserDisplayName });
  });

  it("two simultaneous cancels of one pending order: exactly one wins, the other is told it is final", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    const responses = await Promise.all([call("POST", `/positions/orders/${orderId}/cancel`, {}), call("POST", `/positions/orders/${orderId}/cancel`, {}, { asUser: otherUserId })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)!.json.error).toBe("This order has already reached a final status and can't be cancelled.");
    expect((await orderRow(orderId)).status).toBe("cancelled");
    expect(publishNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("when the worker moves the order to submitted between the read and the cancel, asks the worker to cancel it instead of marking it cancelled", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, { status: "confirmed" });
    // Hold the row so the route's status-conditioned update waits, then let the "worker" win before releasing it.
    const holdingTransaction = await testDb.transaction();
    await holdingTransaction("order_requests").where({ id: orderId }).forUpdate().first();
    const pendingCancel = call("POST", `/positions/orders/${orderId}/cancel`, {});
    await new Promise((resolve) => setTimeout(resolve, 250));
    await holdingTransaction("order_requests").where({ id: orderId }).update({ status: "submitted" });
    await holdingTransaction.commit();

    const response = await pendingCancel;
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ id: orderId, status: "cancel_requested", cancelledByUserId: userId });
    expect((await orderRow(orderId)).status).toBe("cancel_requested");
    await waitForNotificationCount(1);
    expect(notifiedOrderIds).toEqual([orderId]);
  });

  it("cannot be confirmed afterwards: a confirm of the cancelled order answers with its state and sends nothing", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    await call("POST", `/positions/orders/${orderId}/cancel`, {});
    const response = await call("POST", `/positions/orders/${orderId}/confirm`, {});
    expect(response.status).toBe(200);
    expect(response.json.status).toBe("cancelled");
    await settle();
    expect(notifiedOrderIds).toEqual([]);
    expect((await orderRow(orderId)).status).toBe("cancelled");
  });

  it("lets a user other than the builder confirm the order (every user has the same access)", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    const response = await call("POST", `/positions/orders/${orderId}/confirm`, {}, { asUser: otherUserId });
    expect(response.status).toBe(200);
    expect(response.json.status).toBe("confirmed");
    await waitForNotificationCount(1);
    expect(notifiedOrderIds).toEqual([orderId]);
  });
});

describe("POST /positions/:id/close", () => {
  it("closes a covered call with both legs: stock sold, call bought back, prices rounded, contract id and leg id carried", async () => {
    const { positionId, symbol, legIds } = await createPosition("covered_call", [longStock(300), shortCall(3, { ibkrContractId: "555123" })]);
    const [stockLegId, optionLegId] = legIds;
    const response = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: stockLegId, limitPrice: 55.554 }, { legId: optionLegId, limitPrice: 0.556 }] });
    expect(response.status).toBe(201);
    expect(response.json.requestType).toBe("close_position");
    expect(response.json.relatedPositionId).toBe(positionId);
    expect(response.json.payload.symbol).toBe(symbol);
    expect(response.json.payload.strategyKey).toBe("covered_call");
    expect(sortedByRole(response.json.payload.legs)).toEqual([
      { role: "option", action: "BUY", symbol, quantity: 3, unitPrice: 0.56, strike: 55, expiry: "20300118", right: "C", ibkrContractId: "555123", positionLegId: optionLegId },
      { role: "stock", action: "SELL", symbol, quantity: 300, unitPrice: 55.55, positionLegId: stockLegId },
    ]);
    expect((await orderRow(response.json.id)).status).toBe("pending_confirmation");
    expect(await testDb("positions").where({ id: positionId }).first("status")).toEqual({ status: "open" });
    expect(publishNotificationMock).toHaveBeenCalledWith({ type: "order_status", orderId: response.json.id });
  });

  it("closes a long (hedge) option with a SELL, and accepts a limit price of zero", async () => {
    const { positionId, legIds, symbol } = await createPosition("hedge", [{ legType: "option", side: "long", quantity: 2, optionType: "call", strikePrice: 100, entryPrice: 3 }]);
    const response = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[0], limitPrice: 0 }] });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs).toEqual([{ role: "option", action: "SELL", symbol, quantity: 2, unitPrice: 0, strike: 100, expiry: "20300118", right: "C", positionLegId: legIds[0] }]);
  });

  it("downsizes a covered call: closing 1 of 3 contracts closes 1 option contract and 100 shares, whatever the stock leg's own request", async () => {
    const { positionId, legIds } = await createPosition("covered_call", [longStock(300), shortCall(3)]);
    const [stockLegId, optionLegId] = legIds;
    const response = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: stockLegId, limitPrice: 55, quantity: 7 }, { legId: optionLegId, limitPrice: 1 }], contractsToClose: 1 });
    expect(response.status).toBe(201);
    const legs = sortedByRole<{ role: string; quantity: number }>(response.json.payload.legs);
    expect(legs.map((leg: { role: string; quantity: number }) => [leg.role, leg.quantity])).toEqual([
      ["option", 1],
      ["stock", 100],
    ]);
  });

  it("closes every held contract when contractsToClose equals what is held", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(3)]);
    const response = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[0], limitPrice: 1 }], contractsToClose: 3 });
    expect(response.status).toBe(201);
    expect(response.json.payload.legs[0].quantity).toBe(3);
  });

  it("refuses to downsize by more than is held", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(3)]);
    const response = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[0], limitPrice: 1 }], contractsToClose: 4 });
    expect(response.status).toBe(400);
    expect(response.json.error).toBe("Cannot close 4 contracts — only 3 held.");
    expect(await orderCount()).toBe(0);
  });

  it("refuses a contractsToClose that is zero, negative or fractional", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(3)]);
    for (const contractsToClose of [0, -1, 1.5, "1"]) {
      const response = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[0], limitPrice: 1 }], contractsToClose });
      expect(response.status, String(contractsToClose)).toBe(400);
      expect(response.json.error).toBe("contractsToClose must be a positive integer.");
    }
  });

  it("refuses to downsize a position with no option leg or two of them", async () => {
    const stockOnly = await createPosition("covered_call", [longStock(100)]);
    const noOption = await call("POST", `/positions/${stockOnly.positionId}/close`, { legs: [{ legId: stockOnly.legIds[0], limitPrice: 50 }], contractsToClose: 1 });
    expect(noOption.status).toBe(400);
    expect(noOption.json.error).toBe("Downsizing only supports positions with exactly one option leg.");

    const twoOptions = await createPosition("cash_secured_put", [shortPut(2), shortPut(1, { strikePrice: 85 })]);
    const response = await call("POST", `/positions/${twoOptions.positionId}/close`, { legs: twoOptions.legIds.map((legId) => ({ legId, limitPrice: 1 })), contractsToClose: 1 });
    expect(response.status).toBe(400);
    expect(response.json.error).toBe("Downsizing only supports positions with exactly one option leg.");
  });

  it("stops a downsize whose derived share count exceeds the stock held (inconsistent position data)", async () => {
    // 3 contracts but only 100 shares: closing 2 contracts would sell 200 shares.
    const { positionId, legIds } = await createPosition("covered_call", [longStock(100), shortCall(3)]);
    const response = await call("POST", `/positions/${positionId}/close`, { legs: legIds.map((legId) => ({ legId, limitPrice: 1 })), contractsToClose: 2 });
    expect(response.status).toBe(400);
    expect(response.json.error).toBe("Derived stock quantity (200 shares) exceeds what's held (100 shares) — position data may be inconsistent.");
    expect(await orderCount()).toBe(0);
  });

  it("requires every open leg of a structured position, and names the problem", async () => {
    const { positionId, legIds } = await createPosition("covered_call", [longStock(100), shortCall(1)]);
    const response = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[1], limitPrice: 1 }] });
    expect(response.status).toBe(400);
    expect(response.json.error).toBe("All open legs of this position must be included when closing it.");
  });

  it("refuses a leg that was already closed or belongs to another position", async () => {
    const { positionId, legIds } = await createPosition("covered_call", [longStock(100), shortCall(1), shortCall(1, { strikePrice: 50, exitPrice: 0.1, exitAt: new Date() })]);
    const closedLegId = legIds[2];
    const closedLeg = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[0], limitPrice: 1 }, { legId: legIds[1], limitPrice: 1 }, { legId: closedLegId, limitPrice: 1 }] });
    expect(closedLeg.status).toBe(400);
    expect(closedLeg.json.error).toBe(`Leg ${closedLegId} is not an open leg of this position.`);

    const other = await createPosition("cash_secured_put", [shortPut(1)]);
    const foreign = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: other.legIds[0], limitPrice: 1 }] });
    expect(foreign.status).toBe(400);
    expect(foreign.json.error).toBe(`Leg ${other.legIds[0]} is not an open leg of this position.`);
  });

  it("validates each requested leg's fields", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(2)]);
    const legId = legIds[0];
    const bad = async (leg: unknown, message: string) => {
      const response = await call("POST", `/positions/${positionId}/close`, { legs: [leg] });
      expect(response.status, JSON.stringify(leg)).toBe(400);
      expect(response.json.error).toBe(message);
    };
    await bad(null, "Each leg requires legId and a non-negative limitPrice.");
    await bad("leg-1", "Each leg requires legId and a non-negative limitPrice.");
    await bad({ limitPrice: 1 }, "Each leg requires legId and a non-negative limitPrice.");
    await bad({ legId }, "Each leg requires legId and a non-negative limitPrice.");
    await bad({ legId, limitPrice: "1" }, "Each leg requires legId and a non-negative limitPrice.");
    await bad({ legId, limitPrice: -0.01 }, "Each leg requires legId and a non-negative limitPrice.");
    for (const quantity of [0, -1, 1.5, "2", null]) await bad({ legId, limitPrice: 1, quantity }, "Each leg's quantity, if provided, must be a positive integer.");
    expect(await orderCount()).toBe(0);
  });

  it("closes an unstructured position leg by leg: any subset, each with its own quantity, defaulting to everything held", async () => {
    const { positionId, legIds, symbol } = await createPosition("unstructured", [longStock(100), shortCall(2)]);
    const [stockLegId, optionLegId] = legIds;

    const partial = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: stockLegId, limitPrice: 55, quantity: 40 }] });
    expect(partial.status).toBe(201);
    expect(partial.json.payload.legs).toEqual([{ role: "stock", action: "SELL", symbol, quantity: 40, unitPrice: 55, positionLegId: stockLegId }]);
    await call("POST", `/positions/orders/${partial.json.id}/cancel`, {});

    const everything = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: stockLegId, limitPrice: 55 }, { legId: optionLegId, limitPrice: 1, quantity: 1 }] });
    expect(everything.status).toBe(201);
    expect(sortedByRole<{ role: string; quantity: number }>(everything.json.payload.legs).map((leg: { role: string; quantity: number }) => [leg.role, leg.quantity])).toEqual([
      ["option", 1],
      ["stock", 100],
    ]);
  });

  it("refuses to close more of an unstructured leg than is held, and contractsToClose for one", async () => {
    const { positionId, legIds } = await createPosition("unstructured", [longStock(100), shortCall(2)]);
    const tooMany = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[0], limitPrice: 55, quantity: 150 }] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error).toBe(`Cannot close 150 units of leg ${legIds[0]} — only 100 held.`);

    const withContracts = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[1], limitPrice: 1 }], contractsToClose: 1 });
    expect(withContracts.status).toBe(400);
    expect(withContracts.json.error).toBe("contractsToClose is not supported for unstructured positions — provide a quantity per leg instead.");
  });

  it("answers 500 and builds nothing when an option leg has no expiry date to put in the order", async () => {
    const { positionId, legIds, symbol } = await createPosition("cash_secured_put", [shortPut(1, { expiryDate: null })]);
    const response = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: legIds[0], limitPrice: 1 }] });
    expect(response.status).toBe(500);
    expect(response.json.error).toBe(`Order not built: ${symbol} option leg has expiry "undefined", expected YYYYMMDD.`);
    expect(await orderCount()).toBe(0);
  });

  it("does not consult the close gate for a position that already has an order in flight, and does not close an unknown position", async () => {
    expect((await call("POST", `/positions/${missingId}/close`, { legs: [{ legId: missingId, limitPrice: 1 }] })).status).toBe(404);
    expect(evaluateCloseGateForPositionMock).not.toHaveBeenCalled();
  });
});

describe("POST /positions/:id/roll", () => {
  const rollBody = (closeLegId: string | undefined, overrides: Record<string, unknown> = {}) => ({
    closeLegId,
    closeLimitPrice: 0.504,
    newLeg: { strikePrice: 95, expiryDate: "2026-12-18", quantity: 2, limitPrice: 2.506 },
    ...overrides,
  });

  it("builds a roll_leg combo for a short put: buy back the old leg, sell the new, with rounded prices and a normalized expiry", async () => {
    const { positionId, legIds, symbol } = await createPosition("cash_secured_put", [shortPut(2, { ibkrContractId: "777001" })]);
    fetchEconomicCalendarWarningEventsMock.mockResolvedValue([{ title: "CPI", eventDate: "2026-12-10", importance: 2 }]);
    const response = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0]));
    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({ requestType: "roll_leg", status: "pending_confirmation", relatedPositionId: positionId, requestedByUserId: userId });
    expect(response.json.payload).toEqual({
      symbol,
      strategyKey: "cash_secured_put",
      legs: [
        { role: "option", action: "BUY", symbol, quantity: 2, unitPrice: 0.5, strike: 90, expiry: "20300118", right: "P", ibkrContractId: "777001", positionLegId: legIds[0] },
        { role: "option", action: "SELL", symbol, quantity: 2, unitPrice: 2.51, strike: 95, expiry: "20261218", right: "P" },
      ],
    });
    expect(fetchEconomicCalendarWarningEventsMock).toHaveBeenCalledWith("20261218");
    const row = await orderRow(response.json.id);
    expect(row.request_type).toBe("roll_leg");
    expect(row.related_position_id).toBe(positionId);
    expect(row.signal_snapshot).toBeNull();
    expect(row.gate_evaluation).toBeNull();
    expect(row.calendar_warning_events).toEqual([{ title: "CPI", eventDate: "2026-12-10" }]);
    expect(row.risk_free_rate).toBeCloseTo(0.04, 6);
    expect(publishNotificationMock).toHaveBeenCalledWith({ type: "order_status", orderId: response.json.id });
    await settle();
    expect(notifiedOrderIds).toEqual([]);
  });

  it("stores no risk-free rate on a roll when it cannot be read, and still builds the order", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    getRiskFreeRateMock.mockRejectedValue(new Error("FRED unreachable"));
    const response = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0]));
    expect(response.status).toBe(201);
    expect(response.json.riskFreeRate).toBeNull();
    expect((await orderRow(response.json.id)).risk_free_rate).toBeNull();
  });

  it("rolls a short call to a new short call (right C), and a long leg reverses the actions", async () => {
    const shortCallPosition = await createPosition("cash_secured_put", [shortCall(1)]);
    const shortRoll = await call("POST", `/positions/${shortCallPosition.positionId}/roll`, rollBody(shortCallPosition.legIds[0], { newLeg: { strikePrice: 60, expiryDate: "20261218", quantity: 1, limitPrice: 1 } }));
    expect(shortRoll.status).toBe(201);
    expect(shortRoll.json.payload.legs.map((leg: { action: string; right: string }) => [leg.action, leg.right])).toEqual([
      ["BUY", "C"],
      ["SELL", "C"],
    ]);

    const hedge = await createPosition("hedge", [{ legType: "option", side: "long", quantity: 1, optionType: "call", strikePrice: 100, entryPrice: 3 }]);
    const longRoll = await call("POST", `/positions/${hedge.positionId}/roll`, rollBody(hedge.legIds[0], { newLeg: { strikePrice: 105, expiryDate: "20261218", quantity: 1, limitPrice: 3 } }));
    expect(longRoll.status).toBe(201);
    expect(longRoll.json.payload.legs.map((leg: { action: string }) => leg.action)).toEqual(["SELL", "BUY"]);
  });

  it("allows closing the old leg at zero", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    const response = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0], { closeLimitPrice: 0 }));
    expect(response.status).toBe(201);
    expect(response.json.payload.legs[0].unitPrice).toBe(0);
  });

  it("stores a live roll snapshot, and refuses a non-live one with 409 before validating anything else", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    const liveSnapshot = { kind: "roll", closeLeg: { quoteSource: "live" }, replacement: { quoteSource: "live" } };
    const built = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0], { signalSnapshot: liveSnapshot }));
    expect(built.status).toBe(201);
    expect((await orderRow(built.json.id)).signal_snapshot).toEqual(liveSnapshot);
    await call("POST", `/positions/orders/${built.json.id}/cancel`, {});

    const closeLegStale = await call("POST", `/positions/${positionId}/roll`, { signalSnapshot: { kind: "roll", closeLeg: { quoteSource: "snapshot" }, replacement: { quoteSource: "live" } } });
    expect(closeLegStale.status).toBe(409);
    expect(closeLegStale.json.error).toBe("The leg being closed is priced from a snapshot quote, not a live one. Wait for live prices and build the order again.");
    const replacementMissing = await call("POST", `/positions/${positionId}/roll`, { signalSnapshot: { kind: "roll", closeLeg: { quoteSource: "live" } } });
    expect(replacementMissing.status).toBe(409);
    expect(replacementMissing.json.error).toBe("The new leg has no quote recorded. Wait for live prices and build the order again.");
    expect(await orderCount()).toBe(1);
  });

  it("refuses a roll snapshot that is not an object, or is too large", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    const notObject = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0], { signalSnapshot: [1] }));
    expect(notObject.status).toBe(400);
    expect(notObject.json.error).toBe("signalSnapshot must be an object.");
    const tooLarge = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0], { signalSnapshot: { kind: "roll", padding: "x".repeat(17_000) } }));
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.json.error).toBe("signalSnapshot is too large.");
  });

  it("rejects bad input with a specific 400 before reading the position", async () => {
    const bad = async (body: unknown, message: string) => {
      const response = await call("POST", `/positions/${missingId}/roll`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.json.error).toBe(message);
    };
    const closeMessage = "closeLegId and a non-negative closeLimitPrice are required.";
    await bad({ closeLimitPrice: 1, newLeg: rollBody("x").newLeg }, closeMessage);
    await bad({ closeLegId: "x", newLeg: rollBody("x").newLeg }, closeMessage);
    await bad({ closeLegId: "x", closeLimitPrice: "1", newLeg: rollBody("x").newLeg }, closeMessage);
    await bad({ closeLegId: "x", closeLimitPrice: -1, newLeg: rollBody("x").newLeg }, closeMessage);

    const newLegMessage = "newLeg requires strikePrice, expiryDate, a positive whole-number quantity, and a positive limitPrice (the new leg is sold, never for $0).";
    const goodNewLeg = rollBody("x").newLeg;
    await bad({ closeLegId: "x", closeLimitPrice: 1 }, newLegMessage);
    await bad({ closeLegId: "x", closeLimitPrice: 1, newLeg: { ...goodNewLeg, strikePrice: 0 } }, newLegMessage);
    await bad({ closeLegId: "x", closeLimitPrice: 1, newLeg: { ...goodNewLeg, strikePrice: "95" } }, newLegMessage);
    await bad({ closeLegId: "x", closeLimitPrice: 1, newLeg: { ...goodNewLeg, expiryDate: "" } }, newLegMessage);
    await bad({ closeLegId: "x", closeLimitPrice: 1, newLeg: { ...goodNewLeg, limitPrice: 0 } }, newLegMessage);
    await bad({ closeLegId: "x", closeLimitPrice: 1, newLeg: { ...goodNewLeg, limitPrice: 0.004 } }, newLegMessage);
    await bad({ closeLegId: "x", closeLimitPrice: 1, newLeg: { ...goodNewLeg, limitPrice: "2" } }, newLegMessage);
    await bad({ closeLegId: "x", closeLimitPrice: 1, newLeg: { ...goodNewLeg, expiryDate: "tomorrow" } }, 'newLeg.expiryDate must be a YYYYMMDD date, got "tomorrow".');
    expect(await orderCount()).toBe(0);
  });

  it("answers 404 for an unknown position and 409 for a closed one", async () => {
    const missing = await call("POST", `/positions/${missingId}/roll`, rollBody(missingId));
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: "Position not found." });

    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(1)], { status: "closed" });
    const closed = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0]));
    expect(closed.status).toBe(409);
    expect(closed.json).toEqual({ error: "Position is already closed." });
  });

  it("refuses a second order on the position while one is in flight", async () => {
    const { positionId, legIds, symbol } = await createPosition("cash_secured_put", [shortPut(1)]);
    expect((await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0]))).status).toBe(201);
    const second = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0]));
    expect(second.status).toBe(409);
    expect(second.json.error).toBe(`An order for this position is already in progress (${symbol}, pending confirmation) — cancel it first or wait for it to finish.`);
    expect(await orderCount()).toBe(1);
  });

  it("answers 404 for a leg of another position, 400 for a stock leg, 409 for a leg already closed", async () => {
    const { positionId, legIds } = await createPosition("covered_call", [longStock(100), shortCall(1), shortCall(1, { strikePrice: 50, exitPrice: 0.1, exitAt: new Date() })]);
    const [stockLegId, , closedLegId] = legIds;
    const other = await createPosition("cash_secured_put", [shortPut(1)]);

    const foreign = await call("POST", `/positions/${positionId}/roll`, rollBody(other.legIds[0]));
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual({ error: "Leg not found on this position." });

    const stock = await call("POST", `/positions/${positionId}/roll`, rollBody(stockLegId!));
    expect(stock.status).toBe(400);
    expect(stock.json).toEqual({ error: "Only option legs can be rolled." });

    const closed = await call("POST", `/positions/${positionId}/roll`, rollBody(closedLegId!));
    expect(closed.status).toBe(409);
    expect(closed.json).toEqual({ error: "Leg is already closed." });
    expect(await orderCount()).toBe(0);
  });

  it("blocks a covered-call roll that would leave the position naked: 200 shares, another short call of 1 contract, so the new leg may be 1 contract and not 2", async () => {
    const { positionId, legIds } = await createPosition("covered_call", [longStock(200), shortCall(1), shortCall(1, { strikePrice: 60 })]);
    const closingLegId = legIds[1]!;
    const naked = await call("POST", `/positions/${positionId}/roll`, rollBody(closingLegId, { newLeg: { strikePrice: 65, expiryDate: "20261218", quantity: 2, limitPrice: 1 } }));
    expect(naked.status).toBe(400);
    expect(naked.json.error).toBe("Short call coverage (300 shares) exceeds stock held (200 shares) — this would leave the position naked.");
    expect(await orderCount()).toBe(0);

    const covered = await call("POST", `/positions/${positionId}/roll`, rollBody(closingLegId, { newLeg: { strikePrice: 65, expiryDate: "20261218", quantity: 1, limitPrice: 1 } }));
    expect(covered.status).toBe(201);
  });

  it("counts only open long stock toward roll coverage: a sold-off stock slice does not cover the new call", async () => {
    const { positionId, legIds } = await createPosition("covered_call", [longStock(100), longStock(100, { exitPrice: 52, exitAt: new Date() }), shortCall(1)]);
    const response = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[2]!, { newLeg: { strikePrice: 65, expiryDate: "20261218", quantity: 2, limitPrice: 1 } }));
    expect(response.status).toBe(400);
    expect(response.json.error).toBe("Short call coverage (200 shares) exceeds stock held (100 shares) — this would leave the position naked.");
  });

  it("applies no coverage check to a cash-secured put roll", async () => {
    const { positionId, legIds } = await createPosition("cash_secured_put", [shortPut(1)]);
    const response = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0], { newLeg: { strikePrice: 85, expiryDate: "20261218", quantity: 9, limitPrice: 1 } }));
    expect(response.status).toBe(201);
    expect(response.json.payload.legs[1].quantity).toBe(9);
  });

  it("answers 500 and builds nothing when the closing leg has no expiry date", async () => {
    const { positionId, legIds, symbol } = await createPosition("cash_secured_put", [shortPut(1, { expiryDate: null })]);
    const response = await call("POST", `/positions/${positionId}/roll`, rollBody(legIds[0]));
    expect(response.status).toBe(500);
    expect(response.json.error).toBe(`Order not built: ${symbol} option leg has expiry "null", expected YYYYMMDD.`);
    expect(await orderCount()).toBe(0);
  });
});

describe("GET /positions/:id", () => {
  it("returns the position with its legs, and 404 for an unknown id", async () => {
    const { positionId, symbol } = await createPosition("cash_secured_put", [shortPut(2)]);
    const found = await call("GET", `/positions/${positionId}`);
    expect(found.status).toBe(200);
    expect(found.json).toMatchObject({ id: positionId, symbol, strategyKey: "cash_secured_put", status: "open" });
    expect(found.json.legs).toHaveLength(1);
    // A short put of 2 contracts at strike 90 x multiplier 100: 18,000 of collateral.
    expect(Number(found.json.capitalAtRisk)).toBe(18_000);

    const missing = await call("GET", `/positions/${missingId}`);
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: "Position not found." });
  });
});
