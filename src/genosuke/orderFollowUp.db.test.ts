import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";

// createDatabaseDependencies / sendDueOrderNotices against real order_requests, trades and position_legs rows in the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run order follow-up database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { createDatabaseDependencies, notifiableOrderStatuses, sendDueOrderNotices } = await import("./orderFollowUp.js");

const testDb: Knex = db;

const stamp = Date.now();
const serviceUsername = `genosuke-followup-${stamp}`;
const otherServiceUsername = `genosuke-other-${stamp}`;
let serviceUserId: string;
let webUserId: string;
let otherServiceUserId: string;
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
let symbolCounter = stamp % 100_000;

async function createUser(username: string): Promise<string> {
  const [user] = await testDb("users").insert({ username, display_name: username, password_hash: "not-a-real-hash" }).returning("id");
  return user.id;
}

beforeAll(async () => {
  serviceUserId = await createUser(serviceUsername);
  webUserId = await createUser(`web-user-${stamp}`);
  otherServiceUserId = await createUser(otherServiceUsername);
});

afterEach(async () => {
  const userIds = [serviceUserId, webUserId, otherServiceUserId];
  const orderIds = (await testDb("order_requests").whereIn("requested_by_user_id", userIds).select("id")).map((row) => row.id);
  await testDb("trades").whereIn("source_order_request_id", orderIds).del();
  await testDb("order_requests").whereIn("id", orderIds).del();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  createdPositionIds.length = 0;
  createdTickerIds.length = 0;
});

afterAll(async () => {
  await testDb("users").whereIn("id", [serviceUserId, webUserId, otherServiceUserId]).del();
  await testDb.destroy();
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

async function insertOrder(overrides: Record<string, unknown> = {}): Promise<string> {
  const [row] = await testDb("order_requests")
    .insert({
      requested_by_user_id: serviceUserId,
      request_type: "open_cash_secured_put",
      status: "submitted",
      payload: JSON.stringify({ symbol: "FUA", strategyKey: "cash_secured_put", legs: [] }),
      genosuke_notified_status: null,
      ...overrides,
    })
    .returning("id");
  return row.id;
}

const noopSend = async () => {};
const dependencies = () => createDatabaseDependencies(serviceUsername, noopSend);

describe("loadOrdersNeedingNotice: which orders", () => {
  it("returns only orders requested by the service user, never a web user's or another service user's", async () => {
    const mine = await insertOrder();
    await insertOrder({ requested_by_user_id: webUserId });
    await insertOrder({ requested_by_user_id: otherServiceUserId });
    const orders = await dependencies().loadOrdersNeedingNotice();
    expect(orders.map((order) => order.id)).toEqual([mine]);
  });

  it("returns exactly the notifiable statuses, and none of pending_confirmation, confirmed or cancel_requested", async () => {
    const idByStatus = new Map<string, string>();
    for (const status of [...notifiableOrderStatuses, "pending_confirmation", "confirmed", "cancel_requested"]) idByStatus.set(status, await insertOrder({ status, ibkr_order_id: 4242 }));
    const returned = await dependencies().loadOrdersNeedingNotice();
    expect(returned.map((order) => order.status).sort()).toEqual([...notifiableOrderStatuses].sort());
    for (const status of ["pending_confirmation", "confirmed", "cancel_requested"]) expect(returned.map((order) => order.id)).not.toContain(idByStatus.get(status));
  });

  it("skips an order cancelled before it reached IBKR (discarded or never confirmed by hand), but tells one the stale sweep cancelled", async () => {
    const discarded = await insertOrder({ status: "cancelled" });
    const staleUnconfirmed = await insertOrder({ status: "cancelled", cancellation_reason: "not_confirmed_in_time" });
    const ids = (await dependencies().loadOrdersNeedingNotice()).map((order) => order.id);
    expect(ids).not.toContain(discarded);
    expect(ids).toContain(staleUnconfirmed);
  });

  it("the notifiable statuses are the seven the follow-up promises", () => {
    expect([...notifiableOrderStatuses]).toEqual(["submitted", "partially_filled", "filled", "cancelled", "cancelled_partially_filled", "rejected", "error"]);
  });

  it("skips a row whose notified status already equals its status, and returns one with a NULL notified status", async () => {
    const alreadyTold = await insertOrder({ status: "filled", genosuke_notified_status: "filled" });
    const fresh = await insertOrder({ status: "filled", genosuke_notified_status: null });
    const toldAnEarlierStatus = await insertOrder({ status: "filled", genosuke_notified_status: "submitted" });
    const ids = (await dependencies().loadOrdersNeedingNotice()).map((order) => order.id);
    expect(ids).toContain(fresh);
    expect(ids).toContain(toldAnEarlierStatus);
    expect(ids).not.toContain(alreadyTold);
  });

  it("a row backfilled by the migration (notified = status) is not returned, while a new row with no notified status is", async () => {
    const backfilled = await insertOrder({ status: "submitted" });
    await testDb.raw("update order_requests set genosuke_notified_status = status where id = ?", [backfilled]);
    const created = await insertOrder({ status: "submitted" });
    const ids = (await dependencies().loadOrdersNeedingNotice()).map((order) => order.id);
    expect(ids).toEqual([created]);
  });

  it("skips orders created more than 48 hours ago, keeps ones just inside the window", async () => {
    const old = await insertOrder({ created_at: hoursAgo(49) });
    const recent = await insertOrder({ created_at: hoursAgo(47) });
    const ids = (await dependencies().loadOrdersNeedingNotice()).map((order) => order.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(old);
  });

  it("maps the symbol from the payload and the error message", async () => {
    await insertOrder({ status: "rejected", error_message: "IBKR error 201: insufficient margin", payload: JSON.stringify({ symbol: "ZZTOP", strategyKey: "cash_secured_put", legs: [] }) });
    const [order] = await dependencies().loadOrdersNeedingNotice();
    expect(order).toMatchObject({ status: "rejected", errorMessage: "IBKR error 201: insufficient margin", symbol: "ZZTOP" });
  });

  it("orders the notices by when each order last changed", async () => {
    const newest = await insertOrder({ status: "filled", updated_at: hoursAgo(1) });
    const oldest = await insertOrder({ status: "submitted", updated_at: hoursAgo(5) });
    const middle = await insertOrder({ status: "cancelled", ibkr_order_id: 4243, updated_at: hoursAgo(3) });
    const ids = (await dependencies().loadOrdersNeedingNotice()).map((order) => order.id);
    expect(ids).toEqual([oldest, middle, newest]);
  });

  it("returns nothing for an empty set", async () => {
    expect(await dependencies().loadOrdersNeedingNotice()).toEqual([]);
  });
});

describe("markNotified and the notice life cycle", () => {
  it("markNotified persists the status that was told", async () => {
    const orderId = await insertOrder({ status: "submitted" });
    await dependencies().markNotified(orderId, "submitted");
    expect((await testDb("order_requests").where({ id: orderId }).first()).genosuke_notified_status).toBe("submitted");
    expect(await dependencies().loadOrdersNeedingNotice()).toEqual([]);
  });

  it("markNotified touches only that order", async () => {
    const first = await insertOrder();
    const second = await insertOrder();
    await dependencies().markNotified(first, "submitted");
    expect((await testDb("order_requests").where({ id: second }).first()).genosuke_notified_status).toBeNull();
  });

  it("tells each status exactly once: submitted, then filled after a status change, then nothing more", async () => {
    const sent: string[] = [];
    const wired = createDatabaseDependencies(serviceUsername, async (text) => {
      sent.push(text);
    });
    const orderId = await insertOrder({ status: "submitted" });

    expect(await sendDueOrderNotices(wired)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Working at IBKR");
    expect(await sendDueOrderNotices(wired)).toBe(0);
    expect(sent).toHaveLength(1);

    await testDb("order_requests").where({ id: orderId }).update({ status: "filled", updated_at: testDb.fn.now() });
    expect(await sendDueOrderNotices(wired)).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("order filled");
    expect(await sendDueOrderNotices(wired)).toBe(0);
    expect(sent).toHaveLength(2);
    expect((await testDb("order_requests").where({ id: orderId }).first()).genosuke_notified_status).toBe("filled");
  });

  it("a failed send leaves the order to be told on the next pass", async () => {
    let failing = true;
    const sent: string[] = [];
    const wired = createDatabaseDependencies(serviceUsername, async (text) => {
      if (failing) throw new Error("telegram down");
      sent.push(text);
    });
    const orderId = await insertOrder({ status: "rejected", error_message: "no margin" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await sendDueOrderNotices(wired)).toBe(0);
      expect((await testDb("order_requests").where({ id: orderId }).first()).genosuke_notified_status).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
    failing = false;
    expect(await sendDueOrderNotices(wired)).toBe(1);
    expect(sent).toEqual(["❌ IBKR rejected the FUA order: no margin."]);
  });

  it("never tells the chat about a web user's order, whatever its status", async () => {
    const sent: string[] = [];
    const wired = createDatabaseDependencies(serviceUsername, async (text) => {
      sent.push(text);
    });
    for (const status of notifiableOrderStatuses) await insertOrder({ requested_by_user_id: webUserId, status });
    expect(await sendDueOrderNotices(wired)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("sends the fills of a filled order read from its trades", async () => {
    const sent: string[] = [];
    const wired = createDatabaseDependencies(serviceUsername, async (text) => {
      sent.push(text);
    });
    const { legId } = await createOptionLeg();
    const orderId = await insertOrder({ status: "filled" });
    await insertTrade(legId, orderId, { side: "sell", quantity: 2, price: 1.35, executedAt: hoursAgo(1) });
    expect(await sendDueOrderNotices(wired)).toBe(1);
    // The real loaders run on the real clock: DTE counts from today's Eastern date.
    const dte = daysToExpiry("2030-01-18", easternIsoDate(new Date()));
    expect(sent[0]).toBe(`✅ FUA order filled — IBKR confirmed the trade:\n• Sell $90 Put · 18 Jan (${dte}DTE) · 2× @ 1.35`);
  });
});

async function createOptionLeg(): Promise<{ positionId: string; legId: string }> {
  const [ticker] = await testDb("tickers").insert({ symbol: `FU${(symbolCounter += 1)}`, company_name: "Follow Up Test Co", sector: "Technology" }).returning("id");
  createdTickerIds.push(ticker.id);
  const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: ticker.id, status: "closed", closed_at: new Date() }).returning("id");
  createdPositionIds.push(position.id);
  const [leg] = await testDb("position_legs")
    .insert({ position_id: position.id, leg_type: "option", side: "short", quantity: 2, option_type: "put", strike_price: 90, expiry_date: "2030-01-18", multiplier: 100, entry_price: 1.35, entry_at: hoursAgo(2) })
    .returning("id");
  return { positionId: position.id, legId: leg.id };
}

async function createStockLeg(): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol: `FU${(symbolCounter += 1)}`, company_name: "Follow Up Test Co", sector: "Technology" }).returning("id");
  createdTickerIds.push(ticker.id);
  const [position] = await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "closed", closed_at: new Date() }).returning("id");
  createdPositionIds.push(position.id);
  const [leg] = await testDb("position_legs").insert({ position_id: position.id, leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 48.2, entry_at: hoursAgo(2) }).returning("id");
  return leg.id;
}

async function insertTrade(legId: string, orderId: string, trade: { side: string; quantity: number; price: number; executedAt: Date }): Promise<void> {
  await testDb("trades").insert({ position_leg_id: legId, source_order_request_id: orderId, side: trade.side, quantity: trade.quantity, price: trade.price, executed_at: trade.executedAt });
}

describe("loadFills", () => {
  it("returns an option fill with numeric price and strike and an ISO expiry date", async () => {
    const { legId } = await createOptionLeg();
    const orderId = await insertOrder({ status: "filled" });
    await insertTrade(legId, orderId, { side: "sell", quantity: 2, price: 1.35, executedAt: hoursAgo(1) });
    const fills = await dependencies().loadFills(orderId);
    expect(fills).toEqual([{ side: "sell", quantity: 2, price: 1.35, optionType: "put", strikePrice: 90, expiryDate: "2030-01-18" }]);
    expect(typeof fills[0]!.price).toBe("number");
    expect(typeof fills[0]!.strikePrice).toBe("number");
  });

  it("returns a stock fill with no option details", async () => {
    const stockLegId = await createStockLeg();
    const orderId = await insertOrder({ status: "filled" });
    await insertTrade(stockLegId, orderId, { side: "buy", quantity: 100, price: 48.2, executedAt: hoursAgo(1) });
    expect(await dependencies().loadFills(orderId)).toEqual([{ side: "buy", quantity: 100, price: 48.2, optionType: null, strikePrice: null, expiryDate: null }]);
  });

  it("returns the option and stock fills of one buy-write together, oldest execution first", async () => {
    const { legId } = await createOptionLeg();
    const stockLegId = await createStockLeg();
    const orderId = await insertOrder({ status: "filled" });
    await insertTrade(legId, orderId, { side: "sell", quantity: 1, price: 2.1, executedAt: hoursAgo(1) });
    await insertTrade(stockLegId, orderId, { side: "buy", quantity: 100, price: 48.2, executedAt: hoursAgo(3) });
    const fills = await dependencies().loadFills(orderId);
    expect(fills.map((fill) => `${fill.side}:${fill.optionType ?? "stock"}`)).toEqual(["buy:stock", "sell:put"]);
  });

  it("returns only the fills recorded for that order", async () => {
    const { legId } = await createOptionLeg();
    const mine = await insertOrder({ status: "filled" });
    const other = await insertOrder({ status: "filled" });
    await insertTrade(legId, mine, { side: "sell", quantity: 1, price: 1, executedAt: hoursAgo(1) });
    await insertTrade(legId, other, { side: "sell", quantity: 5, price: 9, executedAt: hoursAgo(1) });
    const fills = await dependencies().loadFills(mine);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.quantity).toBe(1);
  });

  it("returns an empty list for an order with no trades", async () => {
    expect(await dependencies().loadFills(await insertOrder({ status: "filled" }))).toEqual([]);
  });

  it("keeps four decimals of a stored price", async () => {
    const { legId } = await createOptionLeg();
    const orderId = await insertOrder({ status: "filled" });
    await insertTrade(legId, orderId, { side: "sell", quantity: 1, price: 1.2345, executedAt: hoursAgo(1) });
    expect((await dependencies().loadFills(orderId))[0]!.price).toBe(1.2345);
  });
});
