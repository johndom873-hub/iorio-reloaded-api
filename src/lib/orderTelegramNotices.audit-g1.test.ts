import { OrderAction } from "@stoqey/ib";
import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import type { OrderFill } from "./orderFills.js";

// Audit (G1, 2026-10-07) of the order side of the trading-events catch-all: the pass loop with fakes, and the database
// dependencies against the real test database (only this file's own users/orders/positions are looked at or touched).
// The dev .env has LIVE Telegram credentials: notifyTelegram is always mocked here.
const telegram = vi.hoisted(() => ({ notifyTelegram: vi.fn(async () => true) }));
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: telegram.notifyTelegram, notifyPlutoTelegram: telegram.notifyTelegram }));
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config({ quiet: true });
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the order Telegram notice audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { createDatabaseDependencies, describeOrderTelegramNotice, sendDueOrderTelegramNotices } = await import("./orderTelegramNotices.js");
type Notice = Parameters<typeof describeOrderTelegramNotice>[0];
type Row = Notice & { updatedAt: Date };
const testDb: Knex = db;

const sellPut: OrderLegPayload = { role: "option", action: OrderAction.SELL, symbol: "AUD", quantity: 1, unitPrice: 1.25, strike: 50, expiry: "20311017", right: "P" };
const buyBackPut: OrderLegPayload = { ...sellPut, action: OrderAction.BUY, unitPrice: 0.5, strike: 52, expiry: "20311010" };
const buyBackFill: OrderFill = { side: "buy", quantity: 1, price: 0.5, optionType: "put", strikePrice: 52, expiryDate: "2031-10-10" };

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: "order-a",
    status: "submitted",
    requestType: "open_cash_secured_put",
    symbol: "AUD",
    legs: [sellPut],
    errorMessage: null,
    cancellationReason: null,
    cancelledByDisplayName: null,
    placedBy: "Marce, web",
    ...overrides,
  };
}

const passNow = Date.parse("2026-10-07T15:00:00Z");

function fakeDependencies(rows: Row[], options: { fills?: Record<string, OrderFill[]>; send?: (text: string) => Promise<boolean>; markNotified?: (id: string, status: string) => Promise<void> } = {}) {
  const sent: string[] = [];
  const marked: [string, string][] = [];
  const fillLoads: string[] = [];
  return {
    sent,
    marked,
    fillLoads,
    dependencies: {
      loadOrdersNeedingNotice: async () => rows,
      loadFills: async (orderId: string) => {
        fillLoads.push(orderId);
        return options.fills?.[orderId] ?? [];
      },
      send: async (text: string) => {
        sent.push(text);
        return options.send ? options.send(text) : true;
      },
      markNotified: async (id: string, status: string) => {
        if (options.markNotified) await options.markNotified(id, status);
        marked.push([id, status]);
      },
      now: () => passNow,
    },
  };
}

describe("sendDueOrderTelegramNotices (fakes)", () => {
  it("one undelivered order does not hold back the others, and stays unmarked", async () => {
    const rows: Row[] = [
      { ...notice({ id: "a" }), updatedAt: new Date(passNow) },
      { ...notice({ id: "b" }), updatedAt: new Date(passNow) },
    ];
    const fake = fakeDependencies(rows, { send: async () => fake.sent.length > 1 });
    expect(await sendDueOrderTelegramNotices(fake.dependencies)).toBe(1);
    expect(fake.sent).toHaveLength(2);
    expect(fake.marked).toEqual([["b", "submitted"]]);
  });

  it("a send that throws is contained to its order", async () => {
    const rows: Row[] = [
      { ...notice({ id: "a" }), updatedAt: new Date(passNow) },
      { ...notice({ id: "b" }), updatedAt: new Date(passNow) },
    ];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeDependencies(rows, {
      send: async () => {
        if (fake.sent.length === 1) throw new Error("telegram down");
        return true;
      },
    });
    expect(await sendDueOrderTelegramNotices(fake.dependencies)).toBe(1);
    expect(fake.marked).toEqual([["b", "submitted"]]);
    errorSpy.mockRestore();
  });

  it("never loads fills for statuses that do not list them", async () => {
    const rows: Row[] = ["submitted", "cancelled", "rejected", "error"].map((status, index) => ({ ...notice({ id: `o${index}`, status }), updatedAt: new Date(passNow) }));
    const fake = fakeDependencies(rows);
    expect(await sendDueOrderTelegramNotices(fake.dependencies)).toBe(4);
    expect(fake.fillLoads).toEqual([]);
  });

  it("a roll filled with only its buy-back recorded waits, then goes out with both fills once the new leg's fill lands", async () => {
    const roll: Row = { ...notice({ id: "roll", status: "filled", requestType: "roll_leg", legs: [buyBackPut, sellPut] }), updatedAt: new Date(passNow - 30_000) };
    const waiting = fakeDependencies([roll], { fills: { roll: [buyBackFill] } });
    expect(await sendDueOrderTelegramNotices(waiting.dependencies)).toBe(0);
    expect(waiting.sent).toEqual([]);

    const sellFill: OrderFill = { side: "sell", quantity: 1, price: 1.25, optionType: "put", strikePrice: 50, expiryDate: "2031-10-17" };
    const complete = fakeDependencies([roll], { fills: { roll: [buyBackFill, sellFill] } });
    expect(await sendDueOrderTelegramNotices(complete.dependencies)).toBe(1);
    expect(complete.sent[0]).toBe("✅ AUD roll filled (Marce, web):\n• BUY 1 put $52 exp 2031-10-10 at 0.50\n• SELL 1 put $50 exp 2031-10-17 at 1.25");
  });

  // After the 5-minute wait a "filled" roll whose new leg's fill was never recorded goes out with the fills it has.
  it("a filled roll sent after the wait with only part of its fills says some fills are missing", async () => {
    const roll: Row = { ...notice({ id: "roll", status: "filled", requestType: "roll_leg", legs: [buyBackPut, sellPut] }), updatedAt: new Date(passNow - 6 * 60_000) };
    const fake = fakeDependencies([roll], { fills: { roll: [buyBackFill] } });
    expect(await sendDueOrderTelegramNotices(fake.dependencies)).toBe(1);
    expect(fake.sent[0]).toBe("✅ AUD roll filled (Marce, web):\n• BUY 1 put $52 exp 2031-10-10 at 0.50\n(some fills not recorded yet)");
  });

  it("a mark that fails after a delivered send means the next pass sends the same message again (accepted duplicate)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows: Row[] = [{ ...notice({ id: "a" }), updatedAt: new Date(passNow) }];
    const fake = fakeDependencies(rows, {
      markNotified: async () => {
        throw new Error("db down");
      },
    });
    expect(await sendDueOrderTelegramNotices(fake.dependencies)).toBe(0);
    expect(fake.sent).toHaveLength(1);
    errorSpy.mockRestore();
  });
});

describe("describeOrderTelegramNotice (corner cases)", () => {
  it("a covered-call buy-write shows both legs and one net debit (stock price minus call premium)", () => {
    const buyStock: OrderLegPayload = { role: "stock", action: OrderAction.BUY, symbol: "AUD", quantity: 100, unitPrice: 50.1 };
    const sellCall: OrderLegPayload = { ...sellPut, right: "C", strike: 55, unitPrice: 1.35 };
    expect(describeOrderTelegramNotice(notice({ requestType: "open_covered_call", legs: [buyStock, sellCall] }), [])).toBe(
      "⏳ AUD order working at IBKR (Marce, web):\n• BUY 100 shares\n• SELL 1 call $55 exp 2031-10-17\nLimit: 48.75 net debit",
    );
  });

  it("a single stock leg (closing leftover shares) shows its limit", () => {
    const sellStock: OrderLegPayload = { role: "stock", action: OrderAction.SELL, symbol: "AUD", quantity: 100, unitPrice: 49 };
    expect(describeOrderTelegramNotice(notice({ requestType: "close_position", legs: [sellStock] }), [])).toBe("⏳ AUD order working at IBKR (Marce, web):\n• SELL 100 shares, limit 49.00");
  });

  it("a combo whose legs net to zero says 'net' with no direction", () => {
    expect(describeOrderTelegramNotice(notice({ requestType: "roll_leg", legs: [{ ...buyBackPut, unitPrice: 1 }, { ...sellPut, unitPrice: 1 }] }), [])).toContain("Limit: 0.00 net");
  });

  it("a cancelled-after-partial order cancelled by a user names them", () => {
    expect(describeOrderTelegramNotice(notice({ status: "cancelled_partially_filled", cancelledByDisplayName: "Juan" }), [buyBackFill])).toBe(
      "⚠️ AUD order cancelled by Juan after partly filling:\n• SELL 1 put $50 exp 2031-10-17, limit 1.25\nFilled:\n• BUY 1 put $52 exp 2031-10-10 at 0.50",
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Database dependencies (real test DB, this file's own rows only)
// ---------------------------------------------------------------------------------------------------------------------

const stamp = Date.now();
let requesterId: string;
let genosukeId: string;
const createdOrderIds: string[] = [];
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
let symbolCounter = stamp % 100_000;

async function createOrder(fields: Record<string, unknown>): Promise<string> {
  const [row] = await testDb("order_requests")
    .insert({
      requested_by_user_id: requesterId,
      request_type: "open_cash_secured_put",
      payload: { symbol: "AUD", strategyKey: "cash_secured_put", legs: [sellPut] },
      status: "submitted",
      ...fields,
    })
    .returning(["id"]);
  createdOrderIds.push(row.id);
  return row.id;
}

async function createLeg(fields: Record<string, unknown>): Promise<string> {
  const symbol = `AUG${(symbolCounter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "G1 Audit Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: ticker.id, status: "open", telegram_opened_notified_at: new Date() }).returning(["id"]);
  createdPositionIds.push(position.id);
  const [leg] = await testDb("position_legs")
    .insert({ position_id: position.id, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: "put", strike_price: 50, expiry_date: "2031-10-17", entry_price: 1.25, entry_at: new Date(), ...fields })
    .returning(["id"]);
  return leg.id;
}

async function insertTrade(orderId: string, legId: string, fields: Record<string, unknown>): Promise<void> {
  await testDb("trades").insert({ position_leg_id: legId, side: "sell", quantity: 1, price: 1.25, executed_at: new Date(), is_closing_trade: false, source_order_request_id: orderId, ...fields });
}

function onlyOrders(dependencies: ReturnType<typeof createDatabaseDependencies>, orderIds: string[]) {
  return {
    ...dependencies,
    loadOrdersNeedingNotice: async () => (await dependencies.loadOrdersNeedingNotice()).filter((order) => orderIds.includes(order.id)),
  };
}

beforeAll(async () => {
  const [requester] = await testDb("users").insert({ username: `g1_web_${stamp}`, display_name: "G1 Web", password_hash: "x" }).returning(["id"]);
  const [genosuke] = await testDb("users").insert({ username: `g1_genosuke_${stamp}`, display_name: "Genosuke Display", password_hash: "x" }).returning(["id"]);
  requesterId = requester.id;
  genosukeId = genosuke.id;
});

afterAll(async () => {
  await testDb("trades").whereIn("source_order_request_id", createdOrderIds).del();
  await testDb("order_requests").whereIn("id", createdOrderIds).del();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").whereIn("id", [requesterId, genosukeId]).del();
  await testDb.destroy();
});

describe("order Telegram notices against the test database", () => {
  it("names Genosuke's orders by its service user (read at call time) and returns updatedAt as a Date", async () => {
    const orderId = await createOrder({ requested_by_user_id: genosukeId });
    const previous = process.env.GENOSUKE_SERVICE_USERNAME;
    process.env.GENOSUKE_SERVICE_USERNAME = `g1_genosuke_${stamp}`;
    try {
      const due = (await createDatabaseDependencies().loadOrdersNeedingNotice()).find((order) => order.id === orderId);
      expect(due?.placedBy).toBe("Genosuke");
      expect(due?.updatedAt).toBeInstanceOf(Date);
    } finally {
      if (previous === undefined) delete process.env.GENOSUKE_SERVICE_USERNAME;
      else process.env.GENOSUKE_SERVICE_USERNAME = previous;
    }
  });

  it("the 48-hour window is on created_at: an order created 49 h ago that just changed status is never told", async () => {
    const orderId = await createOrder({ created_at: new Date(Date.now() - 49 * 3_600_000), updated_at: new Date(), status: "filled" });
    const due = (await createDatabaseDependencies().loadOrdersNeedingNotice()).map((order) => order.id);
    expect(due).not.toContain(orderId);
  });

  it("loadOrderFills reads real trades: prices and strikes as numbers, expiry as YYYY-MM-DD, oldest first", async () => {
    const orderId = await createOrder({ status: "filled" });
    const legId = await createLeg({});
    await insertTrade(orderId, legId, { price: "1.2500", executed_at: new Date(Date.now() - 1_000), ibkr_exec_id: `g1-${stamp}-1` });
    await insertTrade(orderId, legId, { price: "1.3000", executed_at: new Date(), ibkr_exec_id: `g1-${stamp}-2` });
    const fills = await createDatabaseDependencies().loadFills(orderId);
    expect(fills).toEqual([
      { side: "sell", quantity: 1, price: 1.25, optionType: "put", strikePrice: 50, expiryDate: "2031-10-17" },
      { side: "sell", quantity: 1, price: 1.3, optionType: "put", strikePrice: 50, expiryDate: "2031-10-17" },
    ]);
  });

  it("end to end with the real loaders: a filled roll waits for its opening fill, then is told once and marked", async () => {
    const roll = await createOrder({ status: "filled", request_type: "roll_leg", payload: { symbol: "AUD", strategyKey: "cash_secured_put", legs: [buyBackPut, sellPut] } });
    const oldLeg = await createLeg({ strike_price: 52, expiry_date: "2031-10-10" });
    await insertTrade(roll, oldLeg, { side: "buy", price: 0.5, is_closing_trade: true, ibkr_exec_id: `g1-${stamp}-r1` });
    const sends: string[] = [];
    const wired = {
      ...onlyOrders(createDatabaseDependencies(), [roll]),
      send: async (text: string) => {
        sends.push(text);
        return true;
      },
    };
    expect(await sendDueOrderTelegramNotices(wired)).toBe(0);

    const newLeg = await createLeg({});
    await insertTrade(roll, newLeg, { ibkr_exec_id: `g1-${stamp}-r2` });
    expect(await sendDueOrderTelegramNotices(wired)).toBe(1);
    expect(sends).toEqual(["✅ AUD roll filled (G1 Web, web):\n• BUY 1 put $52 exp 2031-10-10 at 0.50\n• SELL 1 put $50 exp 2031-10-17 at 1.25"]);
    expect((await testDb("order_requests").where({ id: roll }).first("telegram_notified_status")).telegram_notified_status).toBe("filled");
    expect(await sendDueOrderTelegramNotices(wired)).toBe(0);
    expect(telegram.notifyTelegram).not.toHaveBeenCalled();
  });

  // The web review panel cancels its built order whenever it is closed without Confirm (app cancelUnconfirmedOrder →
  // POST /orders/:id/cancel), and Genosuke/Pluto discard gate-blocked orders the same way: such an order never reached IBKR.
  it("an order cancelled before it was ever sent to IBKR (review panel closed) is not announced", async () => {
    const orderId = await createOrder({ status: "cancelled", cancelled_by_user_id: requesterId, ibkr_order_id: null, placed_at: null });
    const due = (await createDatabaseDependencies().loadOrdersNeedingNotice()).map((order) => order.id);
    expect(due).not.toContain(orderId);
  });
});
