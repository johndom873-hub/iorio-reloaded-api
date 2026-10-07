import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import knexLibrary, { type Knex } from "knex";

// The real positionsRouter on a small express app against the test database. Every IBKR / pool / market boundary the router (and the
// gates it runs) imports is mocked, so nothing network-bound runs; the gate verdicts themselves are driven by mocks of the four
// gate inputs (trading worker, limit evaluator, delta band, close gate).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run positions gate route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 6 } }) };
});

const fetchTradingBlockedReasonMock = vi.fn();
vi.mock("../lib/tradingGate.js", () => ({ fetchTradingBlockedReason: (...args: unknown[]) => fetchTradingBlockedReasonMock(...args) }));

const evaluateOrderLimitsMock = vi.fn();
vi.mock("../lib/orderLimits.js", () => ({ evaluateOrderLimits: (...args: unknown[]) => evaluateOrderLimitsMock(...args) }));

const evaluateDeltaBandMock = vi.fn();
vi.mock("../lib/deltaBandGate.js", () => ({ evaluateDeltaBandForOrderRequest: (...args: unknown[]) => evaluateDeltaBandMock(...args) }));

const evaluateCloseGateForPositionMock = vi.fn();
vi.mock("../lib/closeGate.js", () => ({ evaluateCloseGateForPosition: (...args: unknown[]) => evaluateCloseGateForPositionMock(...args) }));

const publishNotificationMock = vi.fn();
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: (...args: unknown[]) => publishNotificationMock(...args) }));

const evaluateLimitPriceCheckMock = vi.fn();
vi.mock("../lib/limitPriceCheckGate.js", () => ({ evaluateLimitPriceCheckForOrderRequest: (...args: unknown[]) => evaluateLimitPriceCheckMock(...args) }));

const fetchMacroEventWarningEventsMock = vi.fn();
vi.mock("../ibkr/calendarConflict.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/calendarConflict.js")>("../ibkr/calendarConflict.js");
  return { ...actual, fetchMacroEventWarningEvents: (...args: unknown[]) => fetchMacroEventWarningEventsMock(...args) };
});

const fetchPricesPoolFirstMock = vi.fn();
vi.mock("../ibkr/pricePool.js", () => ({
  fetchPricesPoolFirst: (...args: unknown[]) => fetchPricesPoolFirstMock(...args),
  streamPooledPrices: vi.fn(),
  subscribeToPooledPrice: vi.fn(),
}));
vi.mock("../ibkr/greeksPool.js", () => ({ fetchGreeksPoolFirst: vi.fn(), streamPooledGreeks: vi.fn() }));
vi.mock("../ibkr/streamOrderLegQuote.js", () => ({ streamOrderLegQuote: vi.fn(), checkDeltaCompliance: vi.fn() }));
vi.mock("../ibkr/evaluateRecoveryPathForPosition.js", () => ({ evaluateRecoveryPathForPosition: vi.fn() }));
vi.mock("../lib/pulseChartSampleCollector.js", () => ({ recordUnrealizedPnlSample: vi.fn(), recordLegDeltaSample: vi.fn() }));
vi.mock("../lib/riskFreeRate.js", () => ({ getRiskFreeRate: async () => 0.04 }));
vi.mock("./positionCloseLive.js", () => ({ streamCloseLiveHandler: vi.fn() }));
vi.mock("./positionCycleMarks.js", () => ({ getCycleMarksHandler: vi.fn() }));

const { db } = await import("../db/connection.js");
const { positionsRouter } = await import("./positions.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
let listener: pg.Client;
const notifiedOrderIds: string[] = [];
let symbolCounter = Date.now() % 100_000;

const clearLimits = { blocked: false, reasons: [] as string[] };

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `pos-gates-${Date.now()}`, display_name: "Positions Gates Test", password_hash: "not-a-real-hash" }).returning("id");
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
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function cleanRows(): Promise<void> {
  await testDb("order_requests").where({ requested_by_user_id: userId }).del();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  createdPositionIds.length = 0;
  createdTickerIds.length = 0;
}

afterEach(cleanRows);

beforeEach(() => {
  notifiedOrderIds.length = 0;
  fetchTradingBlockedReasonMock.mockReset().mockResolvedValue(null);
  evaluateOrderLimitsMock.mockReset().mockResolvedValue(clearLimits);
  evaluateDeltaBandMock.mockReset().mockImplementation(async (order: { request_type: string }) => (order.request_type.startsWith("open_") ? { compliant: true, reason: null } : null));
  evaluateCloseGateForPositionMock.mockReset().mockResolvedValue({ blocked: false, reason: null, cycleTotal: 7 });
  evaluateLimitPriceCheckMock.mockReset().mockResolvedValue({ blocked: false, reasons: [], legs: [] });
  publishNotificationMock.mockReset().mockResolvedValue(undefined);
  fetchMacroEventWarningEventsMock.mockReset().mockResolvedValue([]);
  fetchPricesPoolFirstMock.mockReset().mockResolvedValue({ stock: 100 });
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

async function waitForNotificationCount(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && notifiedOrderIds.length < expected; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A short pause so a notification that must NOT arrive has had the chance to. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = `PG${(symbolCounter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Positions Gates Test Co", sector: "Technology" }).returning(["id", "symbol"]);
  createdTickerIds.push(ticker.id);
  return ticker;
}

function putOpenPayload(symbol: string) {
  return { symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol, quantity: 2, unitPrice: 1.5, strike: 90, expiry: "20261120", right: "P" }] };
}

async function insertOrder(symbol: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const [row] = await testDb("order_requests")
    .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify(putOpenPayload(symbol)), ...overrides })
    .returning("id");
  return row.id;
}

async function orderRow(orderId: string) {
  return testDb("order_requests").where({ id: orderId }).first();
}

/** A cash-secured put position with one open short put leg, ready to be closed. */
async function createOpenPutPosition(): Promise<{ positionId: string; legId: string; symbol: string }> {
  const ticker = await createTicker();
  const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: ticker.id, status: "open" }).returning("id");
  createdPositionIds.push(position.id);
  const [leg] = await testDb("position_legs")
    .insert({
      position_id: position.id,
      leg_type: "option",
      side: "short",
      quantity: 2,
      option_type: "put",
      strike_price: 90,
      expiry_date: "2030-01-18",
      multiplier: 100,
      entry_price: 2,
      entry_at: new Date(Date.now() - 86_400_000),
    })
    .returning("id");
  return { positionId: position.id, legId: leg.id, symbol: ticker.symbol };
}

const missingId = "00000000-0000-4000-8000-000000000000";

describe("authentication", () => {
  it("refuses an unauthenticated gates read, confirm and close without evaluating anything", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    expect((await call("GET", `/positions/orders/${orderId}/gates`, undefined, { asUser: null })).status).toBe(401);
    expect((await call("POST", `/positions/orders/${orderId}/confirm`, {}, { asUser: null })).status).toBe(401);
    expect((await call("POST", `/positions/${missingId}/close`, { legs: [] }, { asUser: null })).status).toBe(401);
    expect(fetchTradingBlockedReasonMock).not.toHaveBeenCalled();
    expect((await orderRow(orderId)).status).toBe("pending_confirmation");
  });
});

describe("POST /positions/orders", () => {
  const optionBody = { quantity: 2, limitPrice: 1.5, strikePrice: 90, expiryDate: "20261120" };

  it("builds a pending_confirmation order for a non-Signals cash-secured put and stores nothing of a gate verdict", async () => {
    const ticker = await createTicker();
    const response = await call("POST", "/positions/orders", { symbol: ` ${ticker.symbol.toLowerCase()} `, strategyKey: "cash_secured_put", option: optionBody });
    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({ requestType: "open_cash_secured_put", status: "pending_confirmation", requestedByUserId: userId, calendarWarning: null, calendarWarningEvents: null, note: null });
    expect(response.json.payload).toEqual({
      symbol: ticker.symbol,
      strategyKey: "cash_secured_put",
      legs: [{ role: "option", action: "SELL", symbol: ticker.symbol, quantity: 2, unitPrice: 1.5, strike: 90, expiry: "20261120", right: "P" }],
    });
    const row = await orderRow(response.json.id);
    expect(row.status).toBe("pending_confirmation");
    expect(row.signal_snapshot).toBeNull();
    expect(row.gate_evaluation).toBeNull();
    expect(row.genosuke_notified_status).toBeNull();
    expect(row.requested_by_user_id).toBe(userId);
    // Building only prepares: no gate ran and nothing was sent to the worker.
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
    expect(fetchTradingBlockedReasonMock).not.toHaveBeenCalled();
    expect(publishNotificationMock).toHaveBeenCalledWith({ type: "order_status", orderId: response.json.id });
    await settle();
    expect(notifiedOrderIds).toEqual([]);
  });

  it("stores the economic-calendar events and one-line warning on the built order", async () => {
    const ticker = await createTicker();
    fetchMacroEventWarningEventsMock.mockResolvedValue([{ title: "FOMC Rate Decision", eventDate: "2026-11-04" }]);
    const response = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody });
    expect(response.status).toBe(201);
    expect(fetchMacroEventWarningEventsMock).toHaveBeenCalledWith("20261120");
    const row = await orderRow(response.json.id);
    expect(row.calendar_warning_events).toEqual([{ title: "FOMC Rate Decision", eventDate: "2026-11-04" }]);
    expect(row.calendar_warning).toBe("1 economic event before expiry: FOMC Rate Decision (2026-11-04)");
  });

  it("stores a Signals snapshot as given, and refuses one priced from a non-live quote (409, nothing built)", async () => {
    const ticker = await createTicker();
    const liveSnapshot = { candidate: { quoteSource: "live" }, grade: "A" };
    const built = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, signalSnapshot: liveSnapshot });
    expect(built.status).toBe(201);
    expect((await orderRow(built.json.id)).signal_snapshot).toEqual(liveSnapshot);

    const refused = await call("POST", "/positions/orders", { symbol: ticker.symbol, strategyKey: "cash_secured_put", option: optionBody, signalSnapshot: { candidate: { quoteSource: "snapshot" } } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("The contract is priced from a snapshot quote, not a live one. Wait for live prices and build the order again.");
    expect(await testDb("order_requests").where({ requested_by_user_id: userId }).count({ count: "*" }).first()).toEqual({ count: "1" });
  });

  it("rejects bad input with a specific 400 and builds nothing", async () => {
    const ticker = await createTicker();
    const bad = async (body: unknown, message: string) => {
      const response = await call("POST", "/positions/orders", body);
      expect(response.status).toBe(400);
      expect(response.json.error).toBe(message);
    };
    await bad({ strategyKey: "cash_secured_put", option: optionBody }, "Symbol is required.");
    await bad({ symbol: ticker.symbol, strategyKey: "iron_condor", option: optionBody }, "A valid strategyKey is required.");
    await bad({ symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { ...optionBody, quantity: 0 } }, "A positive whole number of option contracts is required.");
    for (const quantity of [1.5, 0.5, 2.0000001, Number.NaN, "2", null]) {
      await bad({ symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { ...optionBody, quantity } }, "A positive whole number of option contracts is required.");
    }
    await bad({ symbol: ticker.symbol, strategyKey: "covered_call", option: optionBody, stock: { quantity: 150.5, limitPrice: 50 } }, "stock.quantity must be a positive whole number of shares when stock is provided.");
    await bad({ symbol: ticker.symbol, strategyKey: "covered_call", option: optionBody, stock: { quantity: 0, limitPrice: 50 } }, "stock.quantity must be a positive whole number of shares when stock is provided.");
    await bad({ symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { ...optionBody, limitPrice: 0 } }, "option.limitPrice must be a positive number — a short option is never sold for $0.");
    await bad({ symbol: ticker.symbol, strategyKey: "cash_secured_put", option: { ...optionBody, expiryDate: "2026-13" } }, 'option.expiryDate must be a YYYYMMDD date, got "2026-13".');
    await bad({ symbol: "NOSUCHSYMBOLZZ", strategyKey: "cash_secured_put", option: optionBody }, "Unknown symbol — add it via the Shortlist first.");
    expect(await testDb("order_requests").where({ requested_by_user_id: userId }).count({ count: "*" }).first()).toEqual({ count: "0" });
  });
});

describe("GET /positions/orders/:id/gates", () => {
  it("answers 404 for an unknown order", async () => {
    const response = await call("GET", `/positions/orders/${missingId}/gates`);
    expect(response.status).toBe(404);
    expect(response.json).toEqual({ error: "Order not found." });
    expect(fetchTradingBlockedReasonMock).not.toHaveBeenCalled();
  });

  it("returns exactly {blocks, warnings, evaluatedAt}, empty and ISO-stamped when everything passes", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    const response = await call("GET", `/positions/orders/${orderId}/gates`);
    expect(response.status).toBe(200);
    expect(Object.keys(response.json).sort()).toEqual(["blocks", "evaluatedAt", "warnings"]);
    expect(response.json.blocks).toEqual([]);
    expect(response.json.warnings).toEqual([]);
    expect(new Date(response.json.evaluatedAt).toISOString()).toBe(response.json.evaluatedAt);
  });

  it("includes the calendar warning text from the order's stored events, and still returns no blocks", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, { calendar_warning_events: JSON.stringify([{ title: "FOMC Rate Decision", eventDate: "2026-11-04" }]) });
    const response = await call("GET", `/positions/orders/${orderId}/gates`);
    expect(response.json.warnings).toEqual(["1 economic event before expiry: 2026-11-04 FOMC Rate Decision."]);
    expect(response.json.blocks).toEqual([]);
  });

  it("lists every block in order (trading, limits, delta band) without changing the order", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: worker offline.");
    evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["too big"] });
    evaluateDeltaBandMock.mockResolvedValue({ compliant: false, reason: "Delta has drifted to 0.50, above the 0.2–0.3 delta band." });
    const response = await call("GET", `/positions/orders/${orderId}/gates`);
    expect(response.status).toBe(200);
    expect(response.json.blocks).toEqual(["Trading is blocked: worker offline.", "too big", "Delta has drifted to 0.50, above the 0.2–0.3 delta band."]);
    const row = await orderRow(orderId);
    expect(row.status).toBe("pending_confirmation");
    expect(row.gate_evaluation).toBeNull();
    await settle();
    expect(notifiedOrderIds).toEqual([]);
  });

  it("evaluates the order the same way for a Signals-built order as for a plain one", async () => {
    const ticker = await createTicker();
    const plainId = await insertOrder(ticker.symbol);
    const signalsId = await insertOrder(ticker.symbol, { signal_snapshot: JSON.stringify({ candidate: { quoteSource: "live" } }) });
    evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["too big"] });
    const [plain, fromSignals] = await Promise.all([call("GET", `/positions/orders/${plainId}/gates`), call("GET", `/positions/orders/${signalsId}/gates`)]);
    expect(plain.json.blocks).toEqual(["too big"]);
    expect(fromSignals.json.blocks).toEqual(["too big"]);
    const limitInputs = evaluateOrderLimitsMock.mock.calls.map((callArguments) => ({ ...callArguments[0], excludeOrderRequestId: "x" }));
    expect(limitInputs[0]).toEqual(limitInputs[1]);
  });
});

describe("POST /positions/orders/:id/confirm", () => {
  it("404s for an unknown order", async () => {
    const response = await call("POST", `/positions/orders/${missingId}/confirm`, {});
    expect(response.status).toBe(404);
    expect(response.json).toEqual({ error: "Order not found." });
  });

  it("confirms an order that passes every gate: status confirmed, gate_evaluation stored, worker notified once", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, { calendar_warning_events: JSON.stringify([{ title: "CPI", eventDate: "2026-11-12" }]) });
    const response = await call("POST", `/positions/orders/${orderId}/confirm`, {});
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ id: orderId, status: "confirmed" });

    const row = await orderRow(orderId);
    expect(row.status).toBe("confirmed");
    expect(row.gate_evaluation).toMatchObject({
      blocks: [],
      warnings: ["1 economic event before expiry: 2026-11-12 CPI."],
      limits: clearLimits,
      deltaBand: { compliant: true, reason: null },
      closeGate: null,
      tradingBlockedReason: null,
    });
    expect(new Date(row.gate_evaluation.evaluatedAt).toISOString()).toBe(row.gate_evaluation.evaluatedAt);
    await waitForNotificationCount(1);
    expect(notifiedOrderIds).toEqual([orderId]);
    expect(publishNotificationMock).toHaveBeenCalledWith({ type: "order_status", orderId });
  });

  it("refuses a Pluto order whose ticker's Pluto switch went off after it was built, and confirms it while the switch is on", async () => {
    const ticker = await createTicker();
    const [entry] = await testDb("shortlist_entries").insert({ ticker_id: ticker.id, added_by_user_id: userId, signals_enabled: true, bot_enabled: true }).returning("id");
    const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ test: "positions-gates" }), model_called: false }).returning("id");
    const [action] = await testDb("pluto_actions").insert({ pass_id: pass.id, kind: "open_cash_secured_put", symbol: ticker.symbol, outcome: "order_built" }).returning("id");
    try {
      const switchedOff = await insertOrder(ticker.symbol, { pluto_action_id: action.id });
      await testDb("shortlist_entries").where({ id: entry.id }).update({ bot_enabled: false });
      const refused = await call("POST", `/positions/orders/${switchedOff}/confirm`, {});
      expect(refused.status).toBe(409);
      expect(refused.json.error).toBe(`Pluto is no longer allowed to trade ${ticker.symbol} (its Pluto switch is off).`);
      expect((await orderRow(switchedOff)).status).toBe("pending_confirmation");

      await testDb("shortlist_entries").where({ id: entry.id }).update({ bot_enabled: true });
      const allowed = await insertOrder(ticker.symbol, { pluto_action_id: action.id });
      expect((await call("POST", `/positions/orders/${allowed}/confirm`, {})).status).toBe(200);
      // A person's order is not subject to the Pluto switch.
      await testDb("shortlist_entries").where({ id: entry.id }).update({ bot_enabled: false });
      expect((await call("POST", `/positions/orders/${await insertOrder(ticker.symbol)}/confirm`, {})).status).toBe(200);
    } finally {
      await testDb("order_requests").where({ pluto_action_id: action.id }).del();
      await testDb("pluto_actions").where({ id: action.id }).del();
      await testDb("pluto_passes").where({ id: pass.id }).del();
      await testDb("shortlist_entries").where({ id: entry.id }).del();
    }
  });

  it("answers 409 with every block reason joined, and leaves the order pending with no notification", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: worker offline.");
    evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["This order is 12.0% of portfolio value, above the 10% max position size.", "AAA would be 25.0% of portfolio value, above the 20% max concentration per ticker."] });
    evaluateDeltaBandMock.mockResolvedValue({ compliant: false, reason: "Delta has drifted to 0.50, above the 0.2–0.3 delta band." });
    const response = await call("POST", `/positions/orders/${orderId}/confirm`, {});
    expect(response.status).toBe(409);
    expect(response.json.error).toBe(
      "Trading is blocked: worker offline. This order is 12.0% of portfolio value, above the 10% max position size. AAA would be 25.0% of portfolio value, above the 20% max concentration per ticker. Delta has drifted to 0.50, above the 0.2–0.3 delta band.",
    );
    const row = await orderRow(orderId);
    expect(row.status).toBe("pending_confirmation");
    expect(row.gate_evaluation).toBeNull();
    await settle();
    expect(notifiedOrderIds).toEqual([]);
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  const singleBlocks: [string, () => void, string][] = [
    ["the trading gate", () => fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: wrong account."), "Trading is blocked: wrong account."],
    ["the position limits", () => evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["too big"] }), "too big"],
    ["the delta band", () => evaluateDeltaBandMock.mockResolvedValue({ compliant: false, reason: "Delta is out of band." }), "Delta is out of band."],
    ["the limit-price check", () => evaluateLimitPriceCheckMock.mockResolvedValue({ blocked: true, reasons: ["Limit price 0.12 is 1.08 below the live mid 1.20."], legs: [] }), "Limit price 0.12 is 1.08 below the live mid 1.20."],
    ["a delta band that could not be verified", () => evaluateDeltaBandMock.mockResolvedValue({ compliant: false, reason: null }), "The delta band could not be verified."],
  ];
  for (const [label, arrange, expectedError] of singleBlocks) {
    it(`refuses the confirm when only ${label} blocks`, async () => {
      const ticker = await createTicker();
      const orderId = await insertOrder(ticker.symbol);
      arrange();
      const response = await call("POST", `/positions/orders/${orderId}/confirm`, {});
      expect(response.status).toBe(409);
      expect(response.json.error).toBe(expectedError);
      expect((await orderRow(orderId)).status).toBe("pending_confirmation");
      await settle();
      expect(notifiedOrderIds).toEqual([]);
    });
  }

  it("a Signals-built order (signal_snapshot set) and a non-Signals order go through the SAME gate, blocked or confirmed alike", async () => {
    const ticker = await createTicker();
    const plainId = await insertOrder(ticker.symbol);
    const signalsId = await insertOrder(ticker.symbol, { signal_snapshot: JSON.stringify({ candidate: { quoteSource: "live" }, grade: "A" }) });

    evaluateOrderLimitsMock.mockResolvedValue({ blocked: true, reasons: ["too big"] });
    expect((await call("POST", `/positions/orders/${plainId}/confirm`, {})).json.error).toBe("too big");
    expect((await call("POST", `/positions/orders/${signalsId}/confirm`, {})).json.error).toBe("too big");
    expect(evaluateOrderLimitsMock).toHaveBeenCalledTimes(2);
    expect(evaluateDeltaBandMock).toHaveBeenCalledTimes(2);
    expect(fetchTradingBlockedReasonMock).toHaveBeenCalledTimes(2);
    const [plainInput, signalsInput] = evaluateOrderLimitsMock.mock.calls.map((callArguments) => callArguments[0]);
    expect({ ...plainInput, excludeOrderRequestId: "x" }).toEqual({ ...signalsInput, excludeOrderRequestId: "x" });
    expect(plainInput.excludeOrderRequestId).toBe(plainId);
    expect(signalsInput.excludeOrderRequestId).toBe(signalsId);

    evaluateOrderLimitsMock.mockResolvedValue(clearLimits);
    expect((await call("POST", `/positions/orders/${plainId}/confirm`, {})).json.status).toBe("confirmed");
    expect((await call("POST", `/positions/orders/${signalsId}/confirm`, {})).json.status).toBe("confirmed");
    expect((await orderRow(plainId)).gate_evaluation.blocks).toEqual([]);
    expect((await orderRow(signalsId)).gate_evaluation.blocks).toEqual([]);
  });

  it("a second confirm returns the current state without re-evaluating the gates or notifying again", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    expect((await call("POST", `/positions/orders/${orderId}/confirm`, {})).json.status).toBe("confirmed");
    const firstEvaluation = (await orderRow(orderId)).gate_evaluation;
    await waitForNotificationCount(1);
    const callsAfterFirst = { trading: fetchTradingBlockedReasonMock.mock.calls.length, limits: evaluateOrderLimitsMock.mock.calls.length, delta: evaluateDeltaBandMock.mock.calls.length };

    // Even with everything now blocking, the idempotent answer is the order's state, not a 409.
    fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: now.");
    const second = await call("POST", `/positions/orders/${orderId}/confirm`, {});
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ id: orderId, status: "confirmed" });
    expect({ trading: fetchTradingBlockedReasonMock.mock.calls.length, limits: evaluateOrderLimitsMock.mock.calls.length, delta: evaluateDeltaBandMock.mock.calls.length }).toEqual(callsAfterFirst);
    expect((await orderRow(orderId)).gate_evaluation).toEqual(firstEvaluation);
    await settle();
    expect(notifiedOrderIds).toEqual([orderId]);
  });

  it("an order already past confirmation (submitted) answers with its state and evaluates nothing", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, { status: "submitted" });
    fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: now.");
    const response = await call("POST", `/positions/orders/${orderId}/confirm`, {});
    expect(response.status).toBe(200);
    expect(response.json.status).toBe("submitted");
    expect(fetchTradingBlockedReasonMock).not.toHaveBeenCalled();
    expect((await orderRow(orderId)).gate_evaluation).toBeNull();
  });

  it("two simultaneous confirms of one order notify the worker exactly once", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    const [first, second] = await Promise.all([call("POST", `/positions/orders/${orderId}/confirm`, {}), call("POST", `/positions/orders/${orderId}/confirm`, {})]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.json.status).toBe("confirmed");
    expect(second.json.status).toBe("confirmed");
    await waitForNotificationCount(1);
    await settle();
    expect(notifiedOrderIds).toEqual([orderId]);
    expect(publishNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("the 15-minute age refusal still wins over a blocking gate, and the gates are not even evaluated", async () => {
    const ticker = await createTicker();
    const staleId = await insertOrder(ticker.symbol, { created_at: new Date(Date.now() - 16 * 60_000) });
    fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: now.");
    const response = await call("POST", `/positions/orders/${staleId}/confirm`, {});
    expect(response.status).toBe(409);
    expect(response.json.error).toBe("This order was built more than 15 minutes ago — its limit prices are stale. Build it again at current prices.");
    expect(fetchTradingBlockedReasonMock).not.toHaveBeenCalled();
    expect((await orderRow(staleId)).status).toBe("pending_confirmation");
  });

  it("an order built 14 minutes ago is still confirmable", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol, { created_at: new Date(Date.now() - 14 * 60_000) });
    expect((await call("POST", `/positions/orders/${orderId}/confirm`, {})).status).toBe(200);
  });

  it("rejects an unknown adaptivePriority with 400 before anything else, even for an order past confirmation", async () => {
    const ticker = await createTicker();
    const pendingId = await insertOrder(ticker.symbol);
    const submittedId = await insertOrder(ticker.symbol, { status: "submitted" });
    for (const orderId of [pendingId, submittedId]) {
      const response = await call("POST", `/positions/orders/${orderId}/confirm`, { adaptivePriority: "Fast" });
      expect(response.status).toBe(400);
      expect(response.json.error).toBe("adaptivePriority must be Urgent, Normal, or Patient.");
    }
    expect(fetchTradingBlockedReasonMock).not.toHaveBeenCalled();
    expect((await orderRow(pendingId)).status).toBe("pending_confirmation");
  });

  it("applies a valid adaptivePriority to a single-leg order only", async () => {
    const ticker = await createTicker();
    const singleLegId = await insertOrder(ticker.symbol);
    const comboPayload = {
      symbol: ticker.symbol,
      strategyKey: "covered_call",
      legs: [
        { role: "stock", action: "BUY", symbol: ticker.symbol, quantity: 100, unitPrice: 95 },
        { role: "option", action: "SELL", symbol: ticker.symbol, quantity: 1, unitPrice: 1, strike: 100, expiry: "20261120", right: "C" },
      ],
    };
    const comboId = await insertOrder(ticker.symbol, { request_type: "open_covered_call", payload: JSON.stringify(comboPayload) });
    expect((await call("POST", `/positions/orders/${singleLegId}/confirm`, { adaptivePriority: "Patient" })).status).toBe(200);
    expect((await call("POST", `/positions/orders/${comboId}/confirm`, { adaptivePriority: "Urgent" })).status).toBe(200);
    expect((await orderRow(singleLegId)).payload.adaptivePriority).toBe("Patient");
    expect((await orderRow(comboId)).payload.adaptivePriority).toBeUndefined();
  });

  it("answers 500 and leaves the order pending when a gate lookup itself fails (fail closed)", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    fetchTradingBlockedReasonMock.mockRejectedValue(new Error("worker_health unreadable"));
    const response = await call("POST", `/positions/orders/${orderId}/confirm`, {});
    expect(response.status).toBe(500);
    expect((await orderRow(orderId)).status).toBe("pending_confirmation");
    await settle();
    expect(notifiedOrderIds).toEqual([]);
  });

  it("refuses to confirm a close while another order on the same position is in flight, leaving it pending", async () => {
    const { positionId, legId, symbol } = await createOpenPutPosition();
    const closePayload = { symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "BUY", symbol, quantity: 2, unitPrice: 0.5, strike: 90, expiry: "20300118", right: "P", positionLegId: legId }] };
    await insertOrder(symbol, { request_type: "close_position", status: "submitted", related_position_id: positionId, payload: JSON.stringify(closePayload) });
    const secondId = await insertOrder(symbol, { request_type: "close_position", related_position_id: positionId, payload: JSON.stringify(closePayload) });
    const response = await call("POST", `/positions/orders/${secondId}/confirm`, {});
    expect(response.status).toBe(409);
    expect(response.json.error).toBe(`An order for this position is already in progress (${symbol}, submitted) — cancel it first or wait for it to finish.`);
    expect((await orderRow(secondId)).status).toBe("pending_confirmation");
    expect((await orderRow(secondId)).gate_evaluation).toBeNull();
  });
});

describe("POST /positions/:id/close and its confirm", () => {
  const closeBody = (legId: string) => ({ legs: [{ legId, limitPrice: 0.5 }] });

  it("builds a close order when the close gate allows it", async () => {
    const { positionId, legId, symbol } = await createOpenPutPosition();
    const response = await call("POST", `/positions/${positionId}/close`, closeBody(legId));
    expect(response.status).toBe(201);
    expect(response.json).toMatchObject({ requestType: "close_position", status: "pending_confirmation", relatedPositionId: positionId });
    expect(response.json.payload).toEqual({
      symbol,
      strategyKey: "cash_secured_put",
      legs: [{ role: "option", action: "BUY", symbol, quantity: 2, unitPrice: 0.5, strike: 90, expiry: "20300118", right: "P", positionLegId: legId }],
    });
    expect(evaluateCloseGateForPositionMock).toHaveBeenCalledWith(positionId);
    const row = await orderRow(response.json.id);
    expect(row.related_position_id).toBe(positionId);
    expect(row.gate_evaluation).toBeNull();
    // A close is never limit-checked.
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
  });

  it("answers 409 with the close gate's reason when it blocks, and builds no order", async () => {
    const { positionId, legId } = await createOpenPutPosition();
    evaluateCloseGateForPositionMock.mockResolvedValue({ blocked: true, reason: "Closing is blocked: the market is closed.", cycleTotal: null });
    const response = await call("POST", `/positions/${positionId}/close`, closeBody(legId));
    expect(response.status).toBe(409);
    expect(response.json).toEqual({ error: "Closing is blocked: the market is closed." });
    expect(await testDb("order_requests").where({ related_position_id: positionId }).count({ count: "*" }).first()).toEqual({ count: "0" });
    await settle();
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  it("checks the request before the close gate: bad input is a 400 and the gate is never consulted", async () => {
    const { positionId } = await createOpenPutPosition();
    const noLegs = await call("POST", `/positions/${positionId}/close`, { legs: [] });
    expect(noLegs.status).toBe(400);
    expect(noLegs.json).toEqual({ error: "At least one leg is required." });
    const notALeg = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: missingId, limitPrice: 1 }] });
    expect(notALeg.status).toBe(400);
    expect(notALeg.json.error).toBe(`Leg ${missingId} is not an open leg of this position.`);
    const negativePrice = await call("POST", `/positions/${positionId}/close`, { legs: [{ legId: missingId, limitPrice: -1 }] });
    expect(negativePrice.status).toBe(400);
    expect(evaluateCloseGateForPositionMock).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown position and 409 for a position that is already closed", async () => {
    expect((await call("POST", `/positions/${missingId}/close`, { legs: [{ legId: missingId, limitPrice: 1 }] })).status).toBe(404);
    const { positionId, legId } = await createOpenPutPosition();
    await testDb("positions").where({ id: positionId }).update({ status: "closed", closed_at: new Date() });
    const response = await call("POST", `/positions/${positionId}/close`, closeBody(legId));
    expect(response.status).toBe(409);
    expect(response.json).toEqual({ error: "Position is already closed." });
    expect(evaluateCloseGateForPositionMock).not.toHaveBeenCalled();
  });

  it("answers 409 when another order on the position is already in progress, without consulting the close gate", async () => {
    const { positionId, legId, symbol } = await createOpenPutPosition();
    const first = await call("POST", `/positions/${positionId}/close`, closeBody(legId));
    expect(first.status).toBe(201);
    evaluateCloseGateForPositionMock.mockClear();
    const second = await call("POST", `/positions/${positionId}/close`, closeBody(legId));
    expect(second.status).toBe(409);
    expect(second.json.error).toBe(`An order for this position is already in progress (${symbol}, pending confirmation) — cancel it first or wait for it to finish.`);
    expect(evaluateCloseGateForPositionMock).not.toHaveBeenCalled();
  });

  it("the close confirm re-runs the close gate: a gate that blocks now refuses it, one that allows confirms it with the verdict stored", async () => {
    const { positionId, legId } = await createOpenPutPosition();
    const built = await call("POST", `/positions/${positionId}/close`, closeBody(legId));
    const orderId: string = built.json.id;
    expect(evaluateCloseGateForPositionMock).toHaveBeenCalledTimes(1);

    evaluateCloseGateForPositionMock.mockResolvedValue({ blocked: true, reason: "Closing is blocked: no live quote for the $90P leg.", cycleTotal: null });
    const refused = await call("POST", `/positions/orders/${orderId}/confirm`, {});
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("Closing is blocked: no live quote for the $90P leg.");
    expect(evaluateCloseGateForPositionMock).toHaveBeenCalledTimes(2);
    expect(evaluateCloseGateForPositionMock).toHaveBeenLastCalledWith(positionId);
    expect((await orderRow(orderId)).status).toBe("pending_confirmation");
    await settle();
    expect(notifiedOrderIds).toEqual([]);

    evaluateCloseGateForPositionMock.mockResolvedValue({ blocked: false, reason: null, cycleTotal: 42 });
    const confirmed = await call("POST", `/positions/orders/${orderId}/confirm`, {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.status).toBe("confirmed");
    expect(evaluateCloseGateForPositionMock).toHaveBeenCalledTimes(3);
    const row = await orderRow(orderId);
    expect(row.gate_evaluation).toMatchObject({ blocks: [], closeGate: { blocked: false, reason: null, cycleTotal: 42 }, limits: null, deltaBand: null });
    await waitForNotificationCount(1);
    expect(notifiedOrderIds).toEqual([orderId]);
    // The close was neither limit-checked nor delta-checked.
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
  });

  it("the trading gate refuses a close confirm even when the close gate allows it", async () => {
    const { positionId, legId } = await createOpenPutPosition();
    const built = await call("POST", `/positions/${positionId}/close`, closeBody(legId));
    fetchTradingBlockedReasonMock.mockResolvedValue("Trading is blocked: wrong account.");
    const response = await call("POST", `/positions/orders/${built.json.id}/confirm`, {});
    expect(response.status).toBe(409);
    expect(response.json.error).toBe("Trading is blocked: wrong account.");
    expect((await orderRow(built.json.id)).status).toBe("pending_confirmation");
  });
});

describe("two different orders confirmed at the same instant", () => {
  // The limit judges from what is already committed (like the real evaluator) and takes time to do it (like the account summary read),
  // and only one working order fits under it. Without the confirmation lock both orders would read "nothing in flight" and both pass.
  function onlyOneWorkingOrderFits() {
    evaluateOrderLimitsMock.mockImplementation(async (input: { excludeOrderRequestId: string }) => {
      const inFlight = await testDb("order_requests").where({ requested_by_user_id: userId, status: "confirmed" }).whereNot({ id: input.excludeOrderRequestId }).count({ count: "*" }).first();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return Number(inFlight?.count ?? 0) > 0 ? { blocked: true, reasons: ["Only one working order fits under this limit."] } : clearLimits;
    });
  }

  it("take turns: the second sees the first as in flight and is refused", async () => {
    const [tickerA, tickerB] = [await createTicker(), await createTicker()];
    const first = await insertOrder(tickerA.symbol);
    const second = await insertOrder(tickerB.symbol);
    onlyOneWorkingOrderFits();

    const responses = await Promise.all([call("POST", `/positions/orders/${first}/confirm`, {}), call("POST", `/positions/orders/${second}/confirm`, {})]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)!.json).toEqual({ error: "Only one working order fits under this limit." });
    const statuses = [(await orderRow(first)).status, (await orderRow(second)).status].sort();
    expect(statuses).toEqual(["confirmed", "pending_confirmation"]);
  });

  it("a refused confirm does not hold the lock: the next one still goes through once there is room", async () => {
    const ticker = await createTicker();
    const orderId = await insertOrder(ticker.symbol);
    evaluateOrderLimitsMock.mockResolvedValueOnce({ blocked: true, reasons: ["No room."] });
    expect((await call("POST", `/positions/orders/${orderId}/confirm`, {})).status).toBe(409);
    expect((await call("POST", `/positions/orders/${orderId}/confirm`, {})).status).toBe(200);
    expect((await orderRow(orderId)).status).toBe("confirmed");
  });

  it("many simultaneous confirms of different orders still let exactly one of them through a one-order limit", async () => {
    const orderIds: string[] = [];
    for (let index = 0; index < 5; index += 1) orderIds.push(await insertOrder((await createTicker()).symbol));
    onlyOneWorkingOrderFits();
    const responses = await Promise.all(orderIds.map((orderId) => call("POST", `/positions/orders/${orderId}/confirm`, {})));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(4);
  });
});

describe("POST /positions/:id/roll quantity", () => {
  const rollBody = (quantity: unknown) => ({ closeLegId: "00000000-0000-0000-0000-000000000001", closeLimitPrice: 1, newLeg: { strikePrice: 95, expiryDate: "20261120", quantity, limitPrice: 2 } });

  it("refuses a fractional or non-numeric new-leg quantity before touching anything", async () => {
    for (const quantity of [1.5, 0, -1, "1", null]) {
      const response = await call("POST", `/positions/${missingId}/roll`, rollBody(quantity));
      expect(response.status, String(quantity)).toBe(400);
      expect(response.json.error).toContain("positive whole-number quantity");
    }
  });
});
