import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Knex } from "knex";

// The real tradeBlotterRouter on a small express app against a private copy of the test database's tables, so the blotter's
// contents are exactly the rows each test inserts.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { tradeBlotterRouter } = await import("./tradeBlotter.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let requesterId: string;
let cancellerId: string;

beforeAll(async () => {
  vi.stubEnv("PASSKEY_LOGIN", "off");
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/trade-blotter", tradeBlotterRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [requester] = await testDb("users").insert({ username: "blotter-requester", display_name: "Rita Requester", password_hash: "x" }).returning("id");
  const [canceller] = await testDb("users").insert({ username: "blotter-canceller", display_name: "Carl Canceller", password_hash: "x" }).returning("id");
  requesterId = requester.id;
  cancellerId = canceller.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await dropIsolatedTestDatabase(testDb);
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  for (const table of ["trades", "order_requests", "position_legs", "positions", "tickers"]) await testDb(table).del();
});

async function get(path: string, options: { authenticated?: boolean } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers: options.authenticated === false ? {} : { "x-test-user-id": "test-user" } });
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
}

async function insertTicker(symbol: string): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: `${symbol} Inc` }).returning("id");
  return ticker.id;
}

async function insertPosition(tickerId: string, strategyKey: string): Promise<string> {
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning("id");
  return position.id;
}

interface LegInput {
  positionId: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  legType?: "option" | "stock";
  optionType?: "call" | "put";
  strikePrice?: number;
  expiryDate?: string;
}

async function insertLeg(input: LegInput): Promise<string> {
  const legType = input.legType ?? "option";
  const [leg] = await testDb("position_legs")
    .insert({
      position_id: input.positionId,
      leg_type: legType,
      side: input.side,
      quantity: input.quantity,
      option_type: legType === "option" ? input.optionType ?? "put" : null,
      strike_price: legType === "option" ? input.strikePrice ?? 100 : null,
      expiry_date: legType === "option" ? input.expiryDate ?? "2026-12-18" : null,
      multiplier: legType === "option" ? 100 : 1,
      entry_price: input.entryPrice,
      entry_at: new Date("2026-01-02T15:00:00Z"),
    })
    .returning("id");
  return leg.id;
}

interface TradeInput {
  legId: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  isClosingTrade: boolean;
  executedAt: string;
  commission?: number | null;
  sourceOrderRequestId?: string | null;
  ibkrOrderId?: string | null;
}

async function insertTrade(input: TradeInput): Promise<string> {
  const [trade] = await testDb("trades")
    .insert({
      position_leg_id: input.legId,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      commission: input.commission === undefined ? null : input.commission,
      is_closing_trade: input.isClosingTrade,
      executed_at: input.executedAt,
      source_order_request_id: input.sourceOrderRequestId ?? null,
      ibkr_order_id: input.ibkrOrderId ?? null,
    })
    .returning("id");
  return trade.id;
}

async function insertOrderRequest(overrides: Record<string, unknown> = {}): Promise<string> {
  const [order] = await testDb("order_requests")
    .insert({ requested_by_user_id: requesterId, request_type: "open", payload: { symbol: "AAA", strategyKey: "cash_secured_put", legs: [] }, status: "submitted", ...overrides })
    .returning("id");
  return order.id;
}

describe("access and validation", () => {
  it("is refused without a session", async () => {
    expect(await get("/trade-blotter", { authenticated: false })).toEqual({ status: 401, json: { error: "Not logged in." } });
  });

  it("answers empty lists on an empty book", async () => {
    expect(await get("/trade-blotter")).toEqual({ status: 200, json: { trades: [], pendingOrders: [] } });
  });

  it("refuses an unknown strategy with a 400", async () => {
    expect(await get("/trade-blotter?strategy=moonshot")).toEqual({ status: 400, json: { error: "Unknown strategy." } });
  });

  it.each(["covered_call", "cash_secured_put", "hedge", "unstructured"])("accepts the strategy %s", async (strategyKey) => {
    expect((await get(`/trade-blotter?strategy=${strategyKey}`)).status).toBe(200);
  });

  it("refuses a repeated strategy parameter (an array is not a known strategy)", async () => {
    expect((await get("/trade-blotter?strategy=hedge&strategy=covered_call")).status).toBe(400);
  });
});

describe("trade rows and realized P&L (exit - entry) x quantity x multiplier, sign-flipped for shorts", () => {
  it("a short put bought back cheaper: (0.50 - 2.00) x 1 x 100 x -1 = +150, value is the premium transacted", async () => {
    const positionId = await insertPosition(await insertTicker("PUT"), "cash_secured_put");
    const legId = await insertLeg({ positionId, side: "short", quantity: 1, entryPrice: 2, strikePrice: 95.5, expiryDate: "2026-12-18" });
    await insertTrade({ legId, side: "buy", quantity: 1, price: 0.5, isClosingTrade: true, executedAt: "2026-03-02T15:00:00Z", commission: 1.25 });

    const { json } = await get("/trade-blotter");

    expect(json.trades).toHaveLength(1);
    expect(json.trades[0]).toMatchObject({
      side: "buy",
      quantity: 1,
      price: "0.5000",
      value: "50.0000",
      commission: "1.2500",
      isClosingTrade: true,
      pnl: "150.0000",
      positionId,
      strategyKey: "cash_secured_put",
      legId,
      legType: "option",
      legSide: "short",
      optionType: "put",
      strikePrice: "95.5000",
      expiryDate: "2026-12-18",
      symbol: "PUT",
      requestedByDisplayName: null,
      ibkrPermId: null,
    });
  });

  it("a short closed at a loss is negative: (3.00 - 2.00) x 1 x 100 x -1 = -100", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("LOSS"), "covered_call"), side: "short", quantity: 1, entryPrice: 2, optionType: "call" });
    await insertTrade({ legId, side: "buy", quantity: 1, price: 3, isClosingTrade: true, executedAt: "2026-03-02T15:00:00Z" });
    expect(Number((await get("/trade-blotter")).json.trades[0].pnl)).toBe(-100);
  });

  it("a long option sold higher: (5.00 - 3.00) x 2 x 100 = +400, with no sign flip", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("HDG"), "hedge"), side: "long", quantity: 2, entryPrice: 3, optionType: "call" });
    await insertTrade({ legId, side: "sell", quantity: 2, price: 5, isClosingTrade: true, executedAt: "2026-03-02T15:00:00Z" });
    expect(Number((await get("/trade-blotter")).json.trades[0].pnl)).toBe(400);
  });

  it("stock shares use a multiplier of 1: (55 - 50) x 100 = +500", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("STK"), "unstructured"), side: "long", quantity: 100, entryPrice: 50, legType: "stock" });
    await insertTrade({ legId, side: "sell", quantity: 100, price: 55, isClosingTrade: true, executedAt: "2026-03-02T15:00:00Z" });
    const [trade] = (await get("/trade-blotter")).json.trades;
    expect(Number(trade.pnl)).toBe(500);
    expect(Number(trade.value)).toBe(5500);
    expect(trade).toMatchObject({ legType: "stock", optionType: null, strikePrice: null, expiryDate: null });
  });

  it("a partial close uses the TRADE's quantity, not the leg's: 4 of 10 contracts closed at +0.25 each on a short = (1.75 - 2.00) x 4 x 100 x -1 = +100", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("PART"), "cash_secured_put"), side: "short", quantity: 10, entryPrice: 2 });
    await insertTrade({ legId, side: "buy", quantity: 4, price: 1.75, isClosingTrade: true, executedAt: "2026-03-02T15:00:00Z" });
    expect(Number((await get("/trade-blotter")).json.trades[0].pnl)).toBe(100);
  });

  it("the P&L is gross of the fill's commission (the commission is reported next to it, not subtracted)", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("COMM"), "cash_secured_put"), side: "short", quantity: 1, entryPrice: 2 });
    await insertTrade({ legId, side: "buy", quantity: 1, price: 0.5, isClosingTrade: true, executedAt: "2026-03-02T15:00:00Z", commission: 10 });
    const [trade] = (await get("/trade-blotter")).json.trades;
    expect(Number(trade.pnl)).toBe(150);
    expect(Number(trade.commission)).toBe(10);
  });

  it("an opening trade has no P&L (null), though it still has a value", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("OPEN"), "cash_secured_put"), side: "short", quantity: 1, entryPrice: 2 });
    await insertTrade({ legId, side: "sell", quantity: 1, price: 2, isClosingTrade: false, executedAt: "2026-03-01T15:00:00Z" });
    const [trade] = (await get("/trade-blotter")).json.trades;
    expect(trade.pnl).toBeNull();
    expect(Number(trade.value)).toBe(200);
    expect(trade.isClosingTrade).toBe(false);
  });

  it("a closing fill at the entry price realizes exactly zero", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("FLAT"), "cash_secured_put"), side: "short", quantity: 1, entryPrice: 2 });
    await insertTrade({ legId, side: "buy", quantity: 1, price: 2, isClosingTrade: true, executedAt: "2026-03-02T15:00:00Z" });
    expect(Number((await get("/trade-blotter")).json.trades[0].pnl)).toBe(0);
  });

  it("lists newest fills first", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("ORD"), "cash_secured_put"), side: "short", quantity: 1, entryPrice: 2 });
    await insertTrade({ legId, side: "sell", quantity: 1, price: 2, isClosingTrade: false, executedAt: "2026-03-01T15:00:00Z" });
    await insertTrade({ legId, side: "buy", quantity: 1, price: 1, isClosingTrade: true, executedAt: "2026-03-03T15:00:00Z" });
    await insertTrade({ legId, side: "buy", quantity: 1, price: 1.5, isClosingTrade: true, executedAt: "2026-03-02T15:00:00Z" });
    expect((await get("/trade-blotter")).json.trades.map((trade: { price: string }) => Number(trade.price))).toEqual([1, 1.5, 2]);
  });

  it("names who requested the order behind a fill and carries the IBKR perm id", async () => {
    const legId = await insertLeg({ positionId: await insertPosition(await insertTicker("WHO"), "cash_secured_put"), side: "short", quantity: 1, entryPrice: 2 });
    const orderId = await insertOrderRequest({ status: "filled", ibkr_perm_id: 987654 });
    await insertTrade({ legId, side: "sell", quantity: 1, price: 2, isClosingTrade: false, executedAt: "2026-03-01T15:00:00Z", sourceOrderRequestId: orderId, ibkrOrderId: "42" });
    const { json } = await get("/trade-blotter");
    expect(json.trades[0]).toMatchObject({ requestedByDisplayName: "Rita Requester", ibkrPermId: 987654, ibkrOrderId: "42" });
    expect(json.pendingOrders).toEqual([]);
  });
});

describe("trade filters", () => {
  let putLegId: string;
  let callLegId: string;

  beforeEach(async () => {
    putLegId = await insertLeg({ positionId: await insertPosition(await insertTicker("AAA"), "cash_secured_put"), side: "short", quantity: 1, entryPrice: 2 });
    callLegId = await insertLeg({ positionId: await insertPosition(await insertTicker("BBB"), "covered_call"), side: "short", quantity: 1, entryPrice: 2, optionType: "call" });
    await insertTrade({ legId: putLegId, side: "buy", quantity: 1, price: 1, isClosingTrade: true, executedAt: "2026-03-10T12:00:00Z" });
    await insertTrade({ legId: callLegId, side: "buy", quantity: 1, price: 1, isClosingTrade: true, executedAt: "2026-03-20T12:00:00Z" });
  });

  const symbolsFor = async (query: string) => (await get(`/trade-blotter${query}`)).json.trades.map((trade: { symbol: string }) => trade.symbol);

  it("filters by strategy", async () => {
    expect(await symbolsFor("?strategy=covered_call")).toEqual(["BBB"]);
    expect(await symbolsFor("?strategy=cash_secured_put")).toEqual(["AAA"]);
    expect(await symbolsFor("?strategy=hedge")).toEqual([]);
  });

  it("filters by symbol, trimming and upper-casing the input", async () => {
    expect(await symbolsFor("?symbol=aaa")).toEqual(["AAA"]);
    expect(await symbolsFor("?symbol=%20bbb%20")).toEqual(["BBB"]);
    expect(await symbolsFor("?symbol=ZZZ")).toEqual([]);
  });

  it("a blank symbol filter means no filter", async () => {
    expect(await symbolsFor("?symbol=%20%20")).toEqual(["BBB", "AAA"]);
  });

  it("filters by an inclusive from/to window on the execution time", async () => {
    expect(await symbolsFor("?from=2026-03-15T00:00:00Z")).toEqual(["BBB"]);
    expect(await symbolsFor("?to=2026-03-15T00:00:00Z")).toEqual(["AAA"]);
    expect(await symbolsFor("?from=2026-03-10T12:00:00Z&to=2026-03-20T12:00:00Z")).toEqual(["BBB", "AAA"]);
    expect(await symbolsFor("?from=2026-03-10T12:00:01Z&to=2026-03-20T11:59:59Z")).toEqual([]);
  });

  it("combines every filter with AND", async () => {
    expect(await symbolsFor("?strategy=covered_call&symbol=aaa")).toEqual([]);
    expect(await symbolsFor("?strategy=covered_call&symbol=bbb&from=2026-03-01T00:00:00Z")).toEqual(["BBB"]);
  });

  it("a malformed date is refused with a 400 instead of reaching the database", async () => {
    for (const query of ["from=not-a-date", "to=31/31/2026", "from=2026-01-01&to=soon"]) {
      const response = await get(`/trade-blotter?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.json, query).toEqual({ error: "from and to must be valid dates." });
    }
  });
});

describe("pending (unfilled) orders", () => {
  const optionLeg = { role: "option", action: "sell", quantity: 2, unitPrice: 1.5, strike: "95", expiry: "20261218", right: "put" };
  const stockLeg = { role: "stock", action: "buy", quantity: 100, unitPrice: 40.25, strike: "", expiry: "", right: "" };

  it("expands a multi-leg order into one row per leg with a distinct id, the premium value (x100 for options only) and YYYY-MM-DD expiry", async () => {
    const orderId = await insertOrderRequest({
      request_type: "open",
      status: "submitted",
      ibkr_order_id: 11,
      ibkr_perm_id: 22,
      payload: { symbol: "BWR", strategyKey: "covered_call", legs: [stockLeg, { ...optionLeg, right: "call" }] },
    });

    const { json } = await get("/trade-blotter");

    expect(json.trades).toEqual([]);
    expect(json.pendingOrders).toHaveLength(2);
    const [stockRow, optionRow] = json.pendingOrders;
    expect(stockRow).toMatchObject({
      id: `${orderId}:1`,
      status: "submitted",
      ibkrOrderId: 11,
      ibkrPermId: 22,
      requestType: "open",
      symbol: "BWR",
      strategyKey: "covered_call",
      requestedByDisplayName: "Rita Requester",
      cancelledByDisplayName: null,
      legRole: "stock",
      action: "buy",
      quantity: "100",
      unitPrice: "40.25",
      value: "4025.00",
      strike: null,
      expiry: null,
      optionType: null,
    });
    expect(optionRow).toMatchObject({ id: `${orderId}:2`, legRole: "option", action: "sell", quantity: "2", value: "300.0", strike: "95", expiry: "2026-12-18", optionType: "call" });
  });

  it("includes every non-filled status with its error / cancellation details, and leaves out filled orders", async () => {
    const payload = { symbol: "STA", strategyKey: "cash_secured_put", legs: [optionLeg] };
    await insertOrderRequest({ status: "filled", payload });
    await insertOrderRequest({ status: "pending_confirmation", payload });
    await insertOrderRequest({ status: "rejected", error_message: "no margin", payload });
    await insertOrderRequest({ status: "cancelled", cancelled_by_user_id: cancellerId, cancellation_reason: "expired_at_close", payload });

    const { json } = await get("/trade-blotter");

    expect(json.pendingOrders.map((row: { status: string }) => row.status).sort()).toEqual(["cancelled", "pending_confirmation", "rejected"]);
    expect(json.pendingOrders.find((row: { status: string }) => row.status === "rejected")).toMatchObject({ errorMessage: "no margin" });
    expect(json.pendingOrders.find((row: { status: string }) => row.status === "cancelled")).toMatchObject({ cancelledByDisplayName: "Carl Canceller", cancellationReason: "expired_at_close" });
  });

  it("a partially filled order shows in both lists (its fills as trades, the order itself as pending)", async () => {
    await insertOrderRequest({ status: "partially_filled", payload: { symbol: "PAR", strategyKey: "cash_secured_put", legs: [optionLeg] } });
    expect((await get("/trade-blotter")).json.pendingOrders).toHaveLength(1);
  });

  it("an order without legs yields no rows", async () => {
    await insertOrderRequest({ status: "submitted", payload: { symbol: "NOL", strategyKey: "hedge" } });
    expect((await get("/trade-blotter")).json.pendingOrders).toEqual([]);
  });

  it("lists newest orders first", async () => {
    const payload = (symbol: string) => ({ symbol, strategyKey: "cash_secured_put", legs: [optionLeg] });
    await insertOrderRequest({ payload: payload("OLD"), created_at: "2026-03-01T00:00:00Z" });
    await insertOrderRequest({ payload: payload("NEW"), created_at: "2026-03-05T00:00:00Z" });
    expect((await get("/trade-blotter")).json.pendingOrders.map((row: { symbol: string }) => row.symbol)).toEqual(["NEW", "OLD"]);
  });

  it("filters pending orders by strategy, symbol (case-insensitive input) and the order's creation time", async () => {
    const make = (symbol: string, strategyKey: string, createdAt: string) =>
      insertOrderRequest({ payload: { symbol, strategyKey, legs: [optionLeg] }, created_at: createdAt });
    await make("AAA", "cash_secured_put", "2026-03-01T00:00:00Z");
    await make("BBB", "covered_call", "2026-03-10T00:00:00Z");
    const symbolsFor = async (query: string) => (await get(`/trade-blotter${query}`)).json.pendingOrders.map((row: { symbol: string }) => row.symbol);

    expect(await symbolsFor("?strategy=covered_call")).toEqual(["BBB"]);
    expect(await symbolsFor("?symbol=aaa")).toEqual(["AAA"]);
    expect(await symbolsFor("?from=2026-03-05T00:00:00Z")).toEqual(["BBB"]);
    expect(await symbolsFor("?to=2026-03-05T00:00:00Z")).toEqual(["AAA"]);
    expect(await symbolsFor("?strategy=covered_call&symbol=AAA")).toEqual([]);
  });
});
