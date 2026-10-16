import type { CommissionReport, Contract, Execution, IBApi } from "@stoqey/ib";
import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppNotification } from "../lib/notificationChannel.js";
import type { OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";

// The worker's order tracking against the real order_requests, trades and position_legs tables of the test database. The code
// under test updates rows by ibkr_order_id, so every test uses its own random order ids, and the stale-order sweep (which scans
// every working order) is run through a handle scoped to this file's user so it can never touch another test's rows.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the order tracking tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const {
  createExecutionRecorder,
  executedOutcomeForOrderRequest,
  handleOrderErrorEvent,
  handleOrderStatusEvent,
  maxPendingCommissions,
  openingFillReconciliationDelayMs,
  reconcileStaleOrderRequests,
} = await import("./ibkrGatewayOrderTracking.js");
const testDb: Knex = db;

let userId: string;
let otherUserId: string;
const createdOrderIds: string[] = [];
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
let counter = 0;
const randomBase = 1_500_000_000 + Math.floor(Math.random() * 400_000_000);
const nextIbkrOrderId = () => randomBase + (counter += 1);
const permIdBase = 1_000_000 + Math.floor(Math.random() * 1_000_000_000); // order_requests.ibkr_perm_id is a 32-bit integer
const nextPermId = () => permIdBase + (counter += 1);
const nextConId = () => String(randomBase + 900_000_000 + (counter += 1));
const nextExecId = () => `test-exec-${randomBase}-${(counter += 1)}`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

const notifications: AppNotification[] = [];
const publishNotification = async (notification: AppNotification) => void notifications.push(notification);
const dependencies = { db: testDb, publishNotification };

const coveredCallPayload: OrderRequestPayload = {
  symbol: "TRK",
  strategyKey: "covered_call",
  legs: [
    { role: "stock", action: "BUY" as never, symbol: "TRK", quantity: 100, unitPrice: 50 },
    { role: "option", action: "SELL" as never, symbol: "TRK", quantity: 1, unitPrice: 2 },
  ],
};

async function insertOrder(overrides: Record<string, unknown> = {}): Promise<{ id: string; ibkrOrderId: number }> {
  const ibkrOrderId = (overrides.ibkr_order_id as number | undefined) ?? nextIbkrOrderId();
  const [order] = await testDb("order_requests")
    .insert({ requested_by_user_id: userId, request_type: "open_covered_call", payload: coveredCallPayload, status: "submitted", ibkr_order_id: ibkrOrderId, ...overrides })
    .returning(["id"]);
  createdOrderIds.push(order.id);
  return { id: order.id, ibkrOrderId };
}

const rowOf = (orderId: string) => testDb("order_requests").where({ id: orderId }).first();

async function createLeg(side: "long" | "short", conId: string, legType: "stock" | "option" = "stock"): Promise<{ legId: string; positionId: string }> {
  const [ticker] = await testDb("tickers").insert({ symbol: `TK${(counter += 1)}${Date.now() % 10_000}`, company_name: "Tracking Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  const [position] = await testDb("positions").insert({ strategy_key: "covered_call", ticker_id: ticker.id, status: "closed", closed_at: new Date() }).returning(["id"]);
  createdPositionIds.push(position.id);
  const [leg] = await testDb("position_legs")
    .insert({
      position_id: position.id,
      leg_type: legType,
      side,
      quantity: legType === "stock" ? 100 : 1,
      multiplier: legType === "stock" ? 1 : 100,
      option_type: legType === "option" ? "call" : null,
      strike_price: legType === "option" ? 55 : null,
      expiry_date: legType === "option" ? "2031-03-21" : null,
      entry_price: 10,
      entry_at: daysAgo(5),
      ibkr_contract_id: conId,
    })
    .returning(["id"]);
  return { legId: leg.id, positionId: position.id };
}

async function insertTrade(legId: string, orderRequestId: string, quantity: number) {
  await testDb("trades").insert({ position_leg_id: legId, ibkr_exec_id: nextExecId(), side: "buy", quantity, price: 1, executed_at: new Date(), is_closing_trade: false, source_order_request_id: orderRequestId });
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `tracking_user_${Date.now()}`, display_name: "Tracking Test User", password_hash: "x" }).returning(["id"]);
  userId = user.id;
  const [otherUser] = await testDb("users").insert({ username: `tracking_other_${Date.now()}`, display_name: "Tracking Other User", password_hash: "x" }).returning(["id"]);
  otherUserId = otherUser.id;
});

beforeEach(() => {
  notifications.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  const legIds = (await testDb("position_legs").whereIn("position_id", createdPositionIds).select("id")).map((row) => row.id);
  await testDb("trades").whereIn("position_leg_id", legIds).del();
  await testDb("order_requests").whereIn("id", createdOrderIds).del();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb("users").whereIn("id", [userId, otherUserId]).del();
  await testDb.destroy();
});

describe("handleOrderStatusEvent", () => {
  const event = (orderId: number, status: string, filled = 0, remaining = 1, permId?: number) => ({ orderId, status, filled, remaining, permId });

  it("ignores a status that does not map to a request status", async () => {
    const { id, ibkrOrderId } = await insertOrder();
    await handleOrderStatusEvent(event(ibkrOrderId, "PendingSubmit"), dependencies);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(notifications).toEqual([]);
  });

  it("Inactive ends a submitted order as rejected with an explanation, or cancelled_partially_filled after a partial fill", async () => {
    const plain = await insertOrder();
    await handleOrderStatusEvent(event(plain.ibkrOrderId, "Inactive", 0, 1), dependencies);
    const plainRow = await rowOf(plain.id);
    expect(plainRow.status).toBe("rejected");
    expect(plainRow.error_message).toBeTruthy();
    const partial = await insertOrder({ status: "partially_filled", created_at: daysAgo(2) });
    await handleOrderStatusEvent(event(partial.ibkrOrderId, "Inactive", 1, 1), dependencies);
    expect((await rowOf(partial.id)).status).toBe("cancelled_partially_filled");
  });

  it("moves a submitted order to partially_filled when some but not all has filled, and publishes one notification", async () => {
    const { id, ibkrOrderId } = await insertOrder();
    await handleOrderStatusEvent(event(ibkrOrderId, "Submitted", 1, 2), dependencies);
    expect((await rowOf(id)).status).toBe("partially_filled");
    expect(notifications).toEqual([{ type: "order_status", orderId: id }]);
  });

  it("records a fill and clears a cancellation reason that a sweep had already set (the fill beat the cancel)", async () => {
    const { id, ibkrOrderId } = await insertOrder({ cancellation_reason: "not_filled_in_time" });
    await handleOrderStatusEvent(event(ibkrOrderId, "Filled", 3, 0), dependencies);
    expect(await rowOf(id)).toMatchObject({ status: "filled", cancellation_reason: null });
    expect(notifications).toHaveLength(1);
  });

  it("captures the permId on the first event for an order", async () => {
    const { id, ibkrOrderId } = await insertOrder();
    const permId = nextPermId();
    await handleOrderStatusEvent(event(ibkrOrderId, "Submitted", 0, 1, permId), dependencies);
    expect(await rowOf(id)).toMatchObject({ status: "submitted", ibkr_perm_id: permId });
    expect(notifications).toHaveLength(1);
  });

  it("skips an unchanged status that carries nothing new (IBKR re-fires it for a resting order): no write, no notification", async () => {
    const permId = nextPermId();
    const { id, ibkrOrderId } = await insertOrder({ ibkr_perm_id: permId });
    const before = await rowOf(id);
    await handleOrderStatusEvent(event(ibkrOrderId, "Submitted", 0, 1, permId), dependencies);
    await handleOrderStatusEvent(event(ibkrOrderId, "PreSubmitted", 0, 1, permId), dependencies);
    expect((await rowOf(id)).updated_at).toEqual(before.updated_at);
    expect(notifications).toEqual([]);
  });

  it("ignores an event whose permId differs from the one the row captured (a reused order id from another order)", async () => {
    const { id, ibkrOrderId } = await insertOrder({ ibkr_perm_id: nextPermId() });
    await handleOrderStatusEvent(event(ibkrOrderId, "Filled", 1, 0, nextPermId()), dependencies);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(notifications).toEqual([]);
  });

  it("never changes a row that is already final, so a reused order id cannot reopen or refill it", async () => {
    for (const finalStatus of ["filled", "cancelled", "cancelled_partially_filled", "rejected", "error"]) {
      const { id, ibkrOrderId } = await insertOrder({ status: finalStatus });
      await handleOrderStatusEvent(event(ibkrOrderId, "Submitted", 0, 1), dependencies);
      await handleOrderStatusEvent(event(ibkrOrderId, "Filled", 1, 0), dependencies);
      expect((await rowOf(id)).status).toBe(finalStatus);
    }
    expect(notifications).toEqual([]);
  });

  it("with a stale final row and a live row sharing an order id, only the live row changes", async () => {
    const sharedOrderId = nextIbkrOrderId();
    const stale = await insertOrder({ ibkr_order_id: sharedOrderId, status: "filled" });
    const live = await insertOrder({ ibkr_order_id: sharedOrderId, status: "submitted" });
    await handleOrderStatusEvent(event(sharedOrderId, "Filled", 1, 0), dependencies);
    expect((await rowOf(stale.id)).status).toBe("filled");
    expect((await rowOf(live.id)).status).toBe("filled");
    expect(notifications).toEqual([{ type: "order_status", orderId: live.id }]);
  });

  it("cancel: records the status and the reason together (an order from an earlier day expired at the close)", async () => {
    const { id, ibkrOrderId } = await insertOrder({ created_at: daysAgo(2) });
    await handleOrderStatusEvent(event(ibkrOrderId, "Cancelled", 0, 1), dependencies);
    expect(await rowOf(id)).toMatchObject({ status: "cancelled", cancellation_reason: "expired_at_close" });
    expect(notifications).toHaveLength(1);
  });

  it("cancel after a partial fill is cancelled_partially_filled", async () => {
    const { id, ibkrOrderId } = await insertOrder({ created_at: daysAgo(2) });
    await handleOrderStatusEvent(event(ibkrOrderId, "Cancelled", 1, 1), dependencies);
    expect((await rowOf(id)).status).toBe("cancelled_partially_filled");
  });

  it("cancel keeps a reason that was already set, and leaves the reason empty when a user asked for the cancel", async () => {
    const sweepOrder = await insertOrder({ created_at: daysAgo(2), cancellation_reason: "not_filled_in_time" });
    await handleOrderStatusEvent(event(sweepOrder.ibkrOrderId, "Cancelled"), dependencies);
    expect((await rowOf(sweepOrder.id)).cancellation_reason).toBe("not_filled_in_time");

    const userOrder = await insertOrder({ created_at: daysAgo(2), cancelled_by_user_id: userId });
    await handleOrderStatusEvent(event(userOrder.ibkrOrderId, "Cancelled"), dependencies);
    expect(await rowOf(userOrder.id)).toMatchObject({ status: "cancelled", cancellation_reason: null });
  });

  it("logs and carries on when the database fails, and never rejects", async () => {
    const failingDb = (() => {
      throw new Error("database is down");
    }) as unknown as Knex;
    await expect(handleOrderStatusEvent(event(nextIbkrOrderId(), "Filled", 1, 0), { db: failingDb, publishNotification })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("database is down"));
  });

  it("logs and carries on when publishing fails, after the status was saved", async () => {
    const { id, ibkrOrderId } = await insertOrder();
    await handleOrderStatusEvent(event(ibkrOrderId, "Filled", 1, 0), {
      db: testDb,
      publishNotification: async () => {
        throw new Error("channel down");
      },
    });
    expect((await rowOf(id)).status).toBe("filled");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("channel down"));
  });
});

describe("handleOrderErrorEvent", () => {
  it("ignores connection-status notices (request id -1)", async () => {
    await handleOrderErrorEvent(new Error("Market data farm is connecting"), 2104, -1, dependencies);
    expect(notifications).toEqual([]);
  });

  it.each([399, 2100, 2150, 2169])("treats code %i as informational: the order stays submitted", async (code) => {
    const { id, ibkrOrderId } = await insertOrder();
    await handleOrderErrorEvent(new Error("will not be placed until the next session open"), code, ibkrOrderId, dependencies);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(notifications).toEqual([]);
  });

  it("codes just outside the informational range are real errors (2099 and 2170)", async () => {
    for (const code of [2099, 2170]) {
      const { id, ibkrOrderId } = await insertOrder();
      await handleOrderErrorEvent(new Error("boom"), code, ibkrOrderId, dependencies);
      expect((await rowOf(id)).status).toBe("error");
    }
  });

  it("an IBKR refusal (201) ends a submitted order as rejected with IBKR's code and text, and publishes it", async () => {
    const { id, ibkrOrderId } = await insertOrder();
    await handleOrderErrorEvent(new Error("Order rejected - reason: price outside limits"), 201, ibkrOrderId, dependencies);
    expect(await rowOf(id)).toMatchObject({ status: "rejected", error_message: "IBKR error 201: Order rejected - reason: price outside limits" });
    expect(notifications).toEqual([{ type: "order_status", orderId: id }]);
  });

  it("a refusal after a partial fill keeps the fill: cancelled_partially_filled with a cancellation reason", async () => {
    const { id, ibkrOrderId } = await insertOrder({ status: "partially_filled", created_at: daysAgo(2) });
    await handleOrderErrorEvent(new Error("Order rejected"), 201, ibkrOrderId, dependencies);
    expect(await rowOf(id)).toMatchObject({ status: "cancelled_partially_filled", error_message: "IBKR error 201: Order rejected", cancellation_reason: "expired_at_close" });
  });

  it("an error code that is not a refusal still ends a submitted order as error", async () => {
    const { id, ibkrOrderId } = await insertOrder();
    await handleOrderErrorEvent(new Error("Unknown problem"), 10_999, ibkrOrderId, dependencies);
    expect((await rowOf(id)).status).toBe("error");
  });

  it("leaves an order that is not submitted alone (an old error naming a reused id)", async () => {
    for (const status of ["confirmed", "filled", "cancelled"]) {
      const { id, ibkrOrderId } = await insertOrder({ status });
      await handleOrderErrorEvent(new Error("boom"), 201, ibkrOrderId, dependencies);
      expect((await rowOf(id)).status).toBe(status);
    }
    expect(notifications).toEqual([]);
  });

  it("error 202 (order canceled) ends a working order as cancelled with IBKR's reason", async () => {
    const { id, ibkrOrderId } = await insertOrder({ created_at: daysAgo(2) });
    await handleOrderErrorEvent(new Error("Order Canceled - reason:Cancelled by exchange"), 202, ibkrOrderId, dependencies);
    expect(await rowOf(id)).toMatchObject({ status: "cancelled", error_message: "IBKR: Cancelled by exchange", cancellation_reason: "expired_at_close" });
    expect(notifications).toEqual([{ type: "order_status", orderId: id }]);
  });

  it("error 202 for an order that was partly filled is cancelled_partially_filled", async () => {
    const { id, ibkrOrderId } = await insertOrder({ status: "partially_filled", created_at: daysAgo(2) });
    await handleOrderErrorEvent(new Error("Order Canceled"), 202, ibkrOrderId, dependencies);
    expect((await rowOf(id)).status).toBe("cancelled_partially_filled");
  });

  it("error 202 for an order that fully executed changes nothing", async () => {
    const { id, ibkrOrderId } = await insertOrder();
    const { legId: stockLegId } = await createLeg("long", nextConId(), "stock");
    const { legId: optionLegId } = await createLeg("short", nextConId(), "option");
    await insertTrade(stockLegId, id, 100);
    await insertTrade(optionLegId, id, 1);
    await handleOrderErrorEvent(new Error("Order Canceled"), 202, ibkrOrderId, dependencies);
    expect((await rowOf(id)).status).toBe("submitted");
    expect(notifications).toEqual([]);
  });

  it("a second 202 after the order is already final changes nothing", async () => {
    const { id, ibkrOrderId } = await insertOrder({ created_at: daysAgo(2) });
    await handleOrderErrorEvent(new Error("Order Canceled"), 202, ibkrOrderId, dependencies);
    await handleOrderErrorEvent(new Error("Order Canceled"), 202, ibkrOrderId, dependencies);
    expect(notifications).toHaveLength(1);
    expect((await rowOf(id)).status).toBe("cancelled");
  });
});

describe("executedOutcomeForOrderRequest", () => {
  it("is none when nothing was recorded", async () => {
    const { id } = await insertOrder();
    expect(await executedOutcomeForOrderRequest(id, coveredCallPayload, testDb)).toBe("none");
  });

  it("is filled when every leg's executed quantity reaches its ordered quantity (summed over several fills)", async () => {
    const { id } = await insertOrder();
    const stock = await createLeg("long", nextConId(), "stock");
    const option = await createLeg("short", nextConId(), "option");
    await insertTrade(stock.legId, id, 60);
    await insertTrade(stock.legId, id, 40);
    await insertTrade(option.legId, id, 1);
    expect(await executedOutcomeForOrderRequest(id, coveredCallPayload, testDb)).toBe("filled");
  });

  it("is partially_filled when one leg is short of its quantity or missing", async () => {
    const { id } = await insertOrder();
    const stock = await createLeg("long", nextConId(), "stock");
    await insertTrade(stock.legId, id, 100);
    expect(await executedOutcomeForOrderRequest(id, coveredCallPayload, testDb)).toBe("partially_filled");

    const second = await insertOrder();
    const secondStock = await createLeg("long", nextConId(), "stock");
    const secondOption = await createLeg("short", nextConId(), "option");
    await insertTrade(secondStock.legId, second.id, 99);
    await insertTrade(secondOption.legId, second.id, 1);
    expect(await executedOutcomeForOrderRequest(second.id, coveredCallPayload, testDb)).toBe("partially_filled");
  });

  it("counts only the executions linked to this order", async () => {
    const mine = await insertOrder();
    const other = await insertOrder();
    const stock = await createLeg("long", nextConId(), "stock");
    await insertTrade(stock.legId, other.id, 100);
    expect(await executedOutcomeForOrderRequest(mine.id, coveredCallPayload, testDb)).toBe("none");
  });
});

describe("reconcileStaleOrderRequests", () => {
  // The sweep scans every working order; this handle shows it only this file's own orders.
  const scopedDb = new Proxy(testDb, {
    apply(target, thisArg, args: [string]) {
      const builder = Reflect.apply(target as unknown as (...inner: unknown[]) => Knex.QueryBuilder, thisArg, args);
      return args[0] === "order_requests" ? builder.where("requested_by_user_id", userId) : builder;
    },
  }) as Knex;

  const now = () => new Date();

  // The sweep settles every working order of this user, so each test starts with none left over from the one before.
  beforeEach(async () => {
    await testDb("order_requests").where({ requested_by_user_id: userId }).whereIn("status", ["submitted", "partially_filled", "cancel_requested"]).update({ status: "filled" });
  });

  const run = async (overrides: { openOrderIds?: number[]; completed?: { permId?: number; status: string }[]; ib?: IBApi | null } = {}) => {
    const fetchIbkrOpenOrders = vi.fn(async () => (overrides.openOrderIds ?? []).map((orderId) => ({ orderId })));
    const fetchIbkrCompletedOrders = vi.fn(async () => overrides.completed ?? []);
    await reconcileStaleOrderRequests({
      db: scopedDb,
      publishNotification,
      getIb: () => (overrides.ib === undefined ? ({} as IBApi) : overrides.ib),
      fetchIbkrOpenOrders: fetchIbkrOpenOrders as never,
      fetchIbkrCompletedOrders: fetchIbkrCompletedOrders as never,
      now,
    });
    return { fetchIbkrOpenOrders, fetchIbkrCompletedOrders };
  };

  it("does nothing without a connection", async () => {
    const { id } = await insertOrder();
    const { fetchIbkrOpenOrders } = await run({ ib: null });
    expect(fetchIbkrOpenOrders).not.toHaveBeenCalled();
    expect((await rowOf(id)).status).toBe("submitted");
  });

  it("leaves an order that IBKR still lists as open", async () => {
    const { id, ibkrOrderId } = await insertOrder({ created_at: daysAgo(3) });
    await run({ openOrderIds: [ibkrOrderId] });
    expect((await rowOf(id)).status).toBe("submitted");
    expect(notifications).toEqual([]);
  });

  it("ignores orders that are not working (confirmed, filled) and orders without an IBKR id", async () => {
    const confirmed = await insertOrder({ status: "confirmed" });
    const filled = await insertOrder({ status: "filled" });
    const noIbkrId = await insertOrder({ ibkr_order_id: null });
    await run();
    expect((await rowOf(confirmed.id)).status).toBe("confirmed");
    expect((await rowOf(filled.id)).status).toBe("filled");
    expect((await rowOf(noIbkrId.id)).status).toBe("submitted");
  });

  it("does not even ask IBKR when there is nothing to settle", async () => {
    await testDb("order_requests").where({ requested_by_user_id: userId, status: "submitted" }).update({ status: "filled" });
    const { fetchIbkrOpenOrders } = await run();
    expect(fetchIbkrOpenOrders).not.toHaveBeenCalled();
  });

  it("settles an order IBKR's completed list shows as filled, matched on permId", async () => {
    const permId = nextPermId();
    const { id } = await insertOrder({ ibkr_perm_id: permId });
    await run({ completed: [{ permId, status: "Filled" }] });
    expect((await rowOf(id)).status).toBe("filled");
    expect(notifications).toEqual([{ type: "order_status", orderId: id }]);
  });

  it("settles a completed cancelled order as cancelled with a reason, or cancelled_partially_filled when it had executions", async () => {
    const plainPermId = nextPermId();
    const plain = await insertOrder({ ibkr_perm_id: plainPermId, created_at: daysAgo(2) });
    const partialPermId = nextPermId();
    const partial = await insertOrder({ ibkr_perm_id: partialPermId, created_at: daysAgo(2) });
    const stock = await createLeg("long", nextConId(), "stock");
    await insertTrade(stock.legId, partial.id, 100);
    await run({ completed: [{ permId: plainPermId, status: "Cancelled" }, { permId: partialPermId, status: "Cancelled" }] });
    expect(await rowOf(plain.id)).toMatchObject({ status: "cancelled", cancellation_reason: "expired_at_close" });
    expect(await rowOf(partial.id)).toMatchObject({ status: "cancelled_partially_filled" });
  });

  it("settles a completed Inactive order as rejected, or cancelled_partially_filled when it had executions", async () => {
    const plainPermId = nextPermId();
    const plain = await insertOrder({ ibkr_perm_id: plainPermId });
    const partialPermId = nextPermId();
    const partial = await insertOrder({ ibkr_perm_id: partialPermId, created_at: daysAgo(2) });
    const stock = await createLeg("long", nextConId(), "stock");
    await insertTrade(stock.legId, partial.id, 100);
    await run({ completed: [{ permId: plainPermId, status: "Inactive" }, { permId: partialPermId, status: "Inactive" }] });
    const plainRow = await rowOf(plain.id);
    expect(plainRow.status).toBe("rejected");
    expect(plainRow.error_message).toBeTruthy();
    expect(plainRow.cancellation_reason).toBeNull();
    expect(await rowOf(partial.id)).toMatchObject({ status: "cancelled_partially_filled", cancellation_reason: "expired_at_close" });
  });

  it("never matches the completed list on the session-scoped order id: an order with no permId is not settled from it", async () => {
    const { id } = await insertOrder({ ibkr_perm_id: null });
    await run({ completed: [{ permId: nextPermId(), status: "Filled" }] });
    expect((await rowOf(id)).status).toBe("error");
  });

  it("settles from the order's own recorded executions when IBKR no longer lists it (a same-day order)", async () => {
    const filledOrder = await insertOrder();
    const stock = await createLeg("long", nextConId(), "stock");
    const option = await createLeg("short", nextConId(), "option");
    await insertTrade(stock.legId, filledOrder.id, 100);
    await insertTrade(option.legId, filledOrder.id, 1);
    const partialOrder = await insertOrder();
    const partialStock = await createLeg("long", nextConId(), "stock");
    await insertTrade(partialStock.legId, partialOrder.id, 100);
    await run();
    expect((await rowOf(filledOrder.id)).status).toBe("filled");
    expect((await rowOf(partialOrder.id)).status).toBe("partially_filled");
  });

  it("settles a DAY order from an earlier session as expired: cancelled, cancelled_partially_filled or filled by what executed", async () => {
    const noFills = await insertOrder({ created_at: daysAgo(3) });
    const someFills = await insertOrder({ created_at: daysAgo(3) });
    const someStock = await createLeg("long", nextConId(), "stock");
    await insertTrade(someStock.legId, someFills.id, 100);
    const allFills = await insertOrder({ created_at: daysAgo(3) });
    const allStock = await createLeg("long", nextConId(), "stock");
    const allOption = await createLeg("short", nextConId(), "option");
    await insertTrade(allStock.legId, allFills.id, 100);
    await insertTrade(allOption.legId, allFills.id, 1);
    await run();
    expect(await rowOf(noFills.id)).toMatchObject({ status: "cancelled", cancellation_reason: "expired_at_close" });
    expect((await rowOf(someFills.id)).status).toBe("cancelled_partially_filled");
    expect((await rowOf(allFills.id)).status).toBe("filled");
  });

  it("flags an order nothing can account for as an error, frees its order id, and publishes it", async () => {
    const { id } = await insertOrder();
    await run();
    const row = await rowOf(id);
    expect(row.status).toBe("error");
    expect(row.ibkr_order_id).toBeNull();
    expect(row.error_message).toContain("IBKR no longer reports this order as open, completed or executed");
    expect(notifications).toEqual([{ type: "order_status", orderId: id }]);
  });

  it("does not touch another user's working orders", async () => {
    const [foreign] = await testDb("order_requests").insert({ requested_by_user_id: otherUserId, request_type: "open_covered_call", payload: coveredCallPayload, status: "submitted", ibkr_order_id: nextIbkrOrderId() }).returning(["id"]);
    createdOrderIds.push(foreign.id);
    await run();
    expect((await rowOf(foreign.id)).status).toBe("submitted");
  });
});

describe("execution recorder", () => {
  let reconciliationRequests = 0;
  let accountMismatch = false;
  let recorder: ReturnType<typeof createExecutionRecorder>;

  beforeEach(() => {
    reconciliationRequests = 0;
    accountMismatch = false;
    recorder = createExecutionRecorder({ db: testDb, isAccountBindingMismatch: () => accountMismatch, requestReconciliation: () => void (reconciliationRequests += 1) });
  });

  const contractOf = (conId: string): Contract => ({ conId: Number(conId) }) as Contract;
  const executionOf = (overrides: Partial<Execution> = {}): Execution => ({ execId: nextExecId(), orderId: 7, permId: undefined, side: "BOT", shares: 100, price: 12.5, time: "20261006 10:30:00 America/New_York", ...overrides }) as Execution;
  const tradeOf = (execId: string) => testDb("trades").where({ ibkr_exec_id: execId }).first();
  const tradeCount = async (execId: string) => (await testDb("trades").where({ ibkr_exec_id: execId })).length;

  it("ignores an execution with no execId or no contract id", async () => {
    await recorder.recordExecution(contractOf(nextConId()), executionOf({ execId: undefined }));
    await recorder.recordExecution({} as Contract, executionOf());
    expect(reconciliationRequests).toBe(0);
  });

  it("ignores every execution while the account binding is mismatched", async () => {
    const conId = nextConId();
    await createLeg("long", conId);
    accountMismatch = true;
    const execution = executionOf({ side: "SLD" });
    await recorder.recordExecution(contractOf(conId), execution);
    expect(await tradeCount(execution.execId!)).toBe(0);
    expect(reconciliationRequests).toBe(0);
  });

  it("is idempotent: the same execId recorded twice is one trade and one reconciliation", async () => {
    const conId = nextConId();
    await createLeg("long", conId);
    const execution = executionOf({ side: "SLD" });
    await recorder.recordExecution(contractOf(conId), execution);
    await recorder.recordExecution(contractOf(conId), execution);
    expect(await tradeCount(execution.execId!)).toBe(1);
    expect(reconciliationRequests).toBe(1);
  });

  it("buffers an opening fill that has no open leg yet, and writes nothing until the leg exists", async () => {
    const conId = nextConId();
    const execution = executionOf();
    await recorder.recordExecution(contractOf(conId), execution);
    expect(await tradeCount(execution.execId!)).toBe(0);
    expect(recorder.bufferedOpeningExecutionCount(conId)).toBe(1);
  });

  it("asks for one reconciliation once a burst of opening fills has settled, not at the first fill of a combo", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (const conId of [nextConId(), nextConId(), nextConId()]) await recorder.recordExecution(contractOf(conId), executionOf());
      expect(reconciliationRequests).toBe(0);
      vi.advanceTimersByTime(openingFillReconciliationDelayMs - 1);
      expect(reconciliationRequests).toBe(0);
      vi.advanceTimersByTime(1);
      expect(reconciliationRequests).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a combo's own execution: its legs arrive separately and no leg ever carries the combo's conId", async () => {
    const conId = nextConId();
    const execution = executionOf();
    await recorder.recordExecution({ conId: Number(conId), secType: "BAG" } as Contract, execution);
    expect(recorder.bufferedOpeningExecutionCount(conId)).toBe(0);
    expect(await tradeCount(execution.execId!)).toBe(0);
  });

  it("a drained fill keeps IBKR's execution time; one IBKR's time cannot be read keeps the time it reached the worker, not the drain time", async () => {
    const conId = nextConId();
    const readable = executionOf({ time: "20261007-14:14:54" });
    const unreadable = executionOf({ time: "not a time" });
    const beforeArrival = Date.now();
    await recorder.recordExecution(contractOf(conId), readable);
    await recorder.recordExecution(contractOf(conId), unreadable);
    const afterArrival = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { legId } = await createLeg("long", conId);
    await recorder.drainPendingOpeningExecutions(conId, legId);
    expect(new Date((await tradeOf(readable.execId!)).executed_at).toISOString()).toBe("2026-10-07T14:14:54.000Z");
    const fallback = new Date((await tradeOf(unreadable.execId!)).executed_at).getTime();
    expect(fallback).toBeGreaterThanOrEqual(beforeArrival);
    expect(fallback).toBeLessThanOrEqual(afterArrival);
  });

  it("drains the buffered fills into opening trades when the reconciliation creates the leg, linked to the order by permId", async () => {
    const conId = nextConId();
    const permId = nextPermId();
    const order = await insertOrder({ ibkr_perm_id: permId });
    const first = executionOf({ permId, shares: 60, price: 10.1, side: "BOT" });
    const second = executionOf({ permId, shares: 40, price: 10.2, side: "BOT" });
    await recorder.recordExecution(contractOf(conId), first);
    await recorder.recordExecution(contractOf(conId), second);
    const { legId } = await createLeg("long", conId);

    await recorder.drainPendingOpeningExecutions(conId, legId);

    expect(recorder.bufferedOpeningExecutionCount(conId)).toBe(0);
    expect(await tradeOf(first.execId!)).toMatchObject({ position_leg_id: legId, side: "buy", quantity: 60, is_closing_trade: false, source_order_request_id: order.id, ibkr_order_id: "7" });
    expect(Number((await tradeOf(first.execId!)).price)).toBe(10.1);
    expect(await tradeOf(second.execId!)).toMatchObject({ quantity: 40, is_closing_trade: false });
  });

  it("draining a contract with nothing buffered is a no-op", async () => {
    await expect(recorder.drainPendingOpeningExecutions(nextConId(), "00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
  });

  it("an add-on fill to a tracked leg is an opening trade, and asks for a reconciliation", async () => {
    const conId = nextConId();
    const { legId } = await createLeg("long", conId);
    const execution = executionOf({ side: "BOT" });
    await recorder.recordExecution(contractOf(conId), execution);
    expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: legId, side: "buy", is_closing_trade: false });
    expect(reconciliationRequests).toBe(1);
  });

  it.each([
    ["selling a long leg", "long", "SLD", "sell"],
    ["buying back a short leg", "short", "BOT", "buy"],
  ] as const)("%s is a closing trade that leaves the leg open for the reconciliation to close", async (_label, legSide, executionSide, tradeSide) => {
    const conId = nextConId();
    const { legId } = await createLeg(legSide, conId);
    const execution = executionOf({ side: executionSide, shares: 30, price: 1.75 });
    await recorder.recordExecution(contractOf(conId), execution);
    expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: legId, side: tradeSide, quantity: 30, is_closing_trade: true });
    expect(Number((await tradeOf(execution.execId!)).price)).toBe(1.75);
    const leg = await testDb("position_legs").where({ id: legId }).first();
    expect(leg.exit_at).toBeNull();
    expect(leg.exit_price).toBeNull();
    expect(reconciliationRequests).toBe(1);
  });

  it("selling a short leg or buying a long leg adds to it rather than closing it", async () => {
    const shortConId = nextConId();
    await createLeg("short", shortConId);
    const sold = executionOf({ side: "SLD" });
    await recorder.recordExecution(contractOf(shortConId), sold);
    expect((await tradeOf(sold.execId!)).is_closing_trade).toBe(false);
  });

  it("converts IBKR's execution time to the right instant, and falls back to now when it is unreadable", async () => {
    const conId = nextConId();
    await createLeg("long", conId);
    const readable = executionOf({ side: "SLD", time: "20261006 10:30:00 America/New_York" });
    const unreadable = executionOf({ side: "SLD", time: "not a time" });
    const before = Date.now();
    await recorder.recordExecution(contractOf(conId), readable);
    await recorder.recordExecution(contractOf(conId), unreadable);
    expect(new Date((await tradeOf(readable.execId!)).executed_at).toISOString()).toBe("2026-10-06T14:30:00.000Z");
    expect(new Date((await tradeOf(unreadable.execId!)).executed_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("an execution from outside the app has no source order", async () => {
    const conId = nextConId();
    await createLeg("long", conId);
    const execution = executionOf({ side: "SLD", permId: nextPermId() });
    await recorder.recordExecution(contractOf(conId), execution);
    expect((await tradeOf(execution.execId!)).source_order_request_id).toBeNull();
  });

  describe("which position's leg a fill belongs to when one stock contract is open on several positions", () => {
    // Covered calls on the same ticker share IBKR's one stock contract. INTC 2026-10-15: the $94 buy-write's 100 shares
    // were recorded on the $98 position's stock leg, the oldest open leg of the contract.
    async function siblingStockLegs(stockConId: string) {
      const older = await createLeg("long", stockConId);
      const newer = await createLeg("long", stockConId);
      await testDb("position_legs").where({ id: newer.legId }).update({ entry_at: daysAgo(1) });
      return { older, newer };
    }
    const stockContractOf = (conId: string): Contract => ({ conId: Number(conId), secType: "STK" }) as Contract;

    async function coveredCallOrderWithCallFillOn(callLegId: string | null) {
      const permId = nextPermId();
      const order = await insertOrder({ ibkr_perm_id: permId, status: "filled" });
      if (callLegId) await insertTrade(callLegId, order.id, 1);
      return { order, permId };
    }

    it("shares a covered-call order bought go to the position holding that order's call", async () => {
      const stockConId = nextConId();
      const { newer } = await siblingStockLegs(stockConId);
      const [callLeg] = await testDb("position_legs")
        .insert({ position_id: newer.positionId, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: "call", strike_price: 94, expiry_date: "2031-03-21", entry_price: 1.14, entry_at: daysAgo(1), ibkr_contract_id: nextConId() })
        .returning(["id"]);
      const { order, permId } = await coveredCallOrderWithCallFillOn(callLeg.id);

      const execution = executionOf({ permId, side: "BOT", shares: 100, price: 92.43 });
      await recorder.recordExecution(stockContractOf(stockConId), execution);

      expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: newer.legId, is_closing_trade: false, source_order_request_id: order.id });
    });

    it("while that position has no stock leg yet, the shares wait instead of joining another position's leg, and drain only onto their own position's", async () => {
      const stockConId = nextConId();
      const { older } = await siblingStockLegs(stockConId);
      const { legId: callLegId, positionId: ownPositionId } = await createLeg("short", nextConId(), "option");
      const { permId } = await coveredCallOrderWithCallFillOn(callLegId);

      const execution = executionOf({ permId, side: "BOT", shares: 100, price: 92.43 });
      await recorder.recordExecution(stockContractOf(stockConId), execution);
      expect(await tradeCount(execution.execId!)).toBe(0);
      expect(recorder.bufferedOpeningExecutionCount(stockConId)).toBe(1);

      // A stock leg created for any other position does not take them.
      await recorder.drainPendingOpeningExecutions(stockConId, older.legId);
      expect(await tradeCount(execution.execId!)).toBe(0);
      expect(recorder.bufferedOpeningExecutionCount(stockConId)).toBe(1);

      const [ownStockLeg] = await testDb("position_legs")
        .insert({ position_id: ownPositionId, leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 97.48, entry_at: new Date(), ibkr_contract_id: stockConId })
        .returning(["id"]);
      await recorder.drainPendingOpeningExecutions(stockConId, ownStockLeg.id);
      expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: ownStockLeg.id, is_closing_trade: false });
      expect(recorder.bufferedOpeningExecutionCount(stockConId)).toBe(0);
    });

    it("a sale by a close order goes to the leg the order names, not the contract's oldest open leg", async () => {
      const stockConId = nextConId();
      const { newer } = await siblingStockLegs(stockConId);
      const permId = nextPermId();
      await insertOrder({
        ibkr_perm_id: permId,
        request_type: "close_position",
        payload: { symbol: "TRK", strategyKey: "covered_call", legs: [{ role: "stock", action: "SELL", symbol: "TRK", quantity: 100, unitPrice: 93, positionLegId: newer.legId }] },
      });

      const execution = executionOf({ permId, side: "SLD", shares: 100, price: 93 });
      await recorder.recordExecution(stockContractOf(stockConId), execution);

      expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: newer.legId, is_closing_trade: true });
    });

    it("shares of a covered-call order adding to an existing Covered Call wait until the call's fill is recorded, then join that position's stock leg", async () => {
      const stockConId = nextConId();
      const { newer } = await siblingStockLegs(stockConId);
      const [callLeg] = await testDb("position_legs")
        .insert({ position_id: newer.positionId, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: "call", strike_price: 94, expiry_date: "2031-03-21", entry_price: 1.14, entry_at: daysAgo(1), ibkr_contract_id: nextConId() })
        .returning(["id"]);
      const { order, permId } = await coveredCallOrderWithCallFillOn(null);

      const shares = executionOf({ permId, side: "BOT", shares: 100, price: 92.43 });
      await recorder.recordExecution(stockContractOf(stockConId), shares);
      expect(recorder.bufferedOpeningExecutionCount(stockConId)).toBe(1);

      await insertTrade(callLeg.id, order.id, 1);
      await recorder.attributeWaitingCoveredCallShareBuys();
      expect(await tradeOf(shares.execId!)).toMatchObject({ position_leg_id: newer.legId, is_closing_trade: false });
      expect(recorder.bufferedOpeningExecutionCount(stockConId)).toBe(0);
    });

    it("a fill no app order explains (an assignment, a trade placed at IBKR) keeps the contract's oldest open leg", async () => {
      const stockConId = nextConId();
      const { older } = await siblingStockLegs(stockConId);
      const execution = executionOf({ permId: nextPermId(), side: "SLD", shares: 100, price: 94 });
      await recorder.recordExecution(stockContractOf(stockConId), execution);
      expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: older.legId, is_closing_trade: true });
    });
  });

  describe("an assignment's stock fill (no app order) goes to the position whose option was assigned", () => {
    const stockContractOf = (conId: string): Contract => ({ conId: Number(conId), secType: "STK" }) as Contract;
    const yesterdayIso = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const inAWeekIso = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const nowAsIbkrTime = () => new Date().toISOString().replace(/\.\d{3}Z$/, "").replace(/-/g, "").replace("T", "-");

    async function positionOn(tickerId: string, strategyKey: string): Promise<string> {
      const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status: "open" }).returning(["id"]);
      createdPositionIds.push(position.id);
      return position.id;
    }
    async function stockLegOn(positionId: string, conId: string, entryAt: Date): Promise<string> {
      const [leg] = await testDb("position_legs").insert({ position_id: positionId, leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 97.48, entry_at: entryAt, ibkr_contract_id: conId }).returning(["id"]);
      return leg.id;
    }
    async function shortOptionOn(positionId: string, optionType: "call" | "put", strike: number, expiryIso: string): Promise<string> {
      const [leg] = await testDb("position_legs")
        .insert({ position_id: positionId, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: optionType, strike_price: strike, expiry_date: expiryIso, entry_price: 1, entry_at: daysAgo(3), ibkr_contract_id: nextConId() })
        .returning(["id"]);
      return leg.id;
    }
    // INTC-shaped: the $98 covered call's shares were opened first, the $94 covered call's after.
    async function siblingCoveredCalls(the94Expiry: string) {
      const [ticker] = await testDb("tickers").insert({ symbol: `AS${(counter += 1)}${Date.now() % 10_000}`, company_name: "Assignment Test Co", sector: "Technology" }).returning(["id"]);
      createdTickerIds.push(ticker.id);
      const stockConId = nextConId();
      const the98Id = await positionOn(ticker.id, "covered_call");
      const the98StockLegId = await stockLegOn(the98Id, stockConId, daysAgo(2));
      await shortOptionOn(the98Id, "call", 98, inAWeekIso());
      const the94Id = await positionOn(ticker.id, "covered_call");
      const the94StockLegId = await stockLegOn(the94Id, stockConId, daysAgo(1));
      await shortOptionOn(the94Id, "call", 94, the94Expiry);
      return { tickerId: ticker.id, stockConId, the98StockLegId, the94StockLegId };
    }

    it("the $94 call assigned: the 100 shares sold at $94 close the $94 position's stock, not the older $98 position's", async () => {
      const { stockConId, the94StockLegId } = await siblingCoveredCalls(yesterdayIso());
      const execution = executionOf({ side: "SLD", shares: 100, price: 94, time: nowAsIbkrTime() });
      await recorder.recordExecution(stockContractOf(stockConId), execution);
      expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: the94StockLegId, is_closing_trade: true });
    });

    it("an early assignment (the call's expiry still ahead) goes to that call's position too", async () => {
      const { stockConId, the94StockLegId } = await siblingCoveredCalls(inAWeekIso());
      const execution = executionOf({ side: "SLD", shares: 100, price: 94, time: nowAsIbkrTime() });
      await recorder.recordExecution(stockContractOf(stockConId), execution);
      expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: the94StockLegId, is_closing_trade: true });
    });

    it("a sale at no option's strike keeps the contract's oldest open leg", async () => {
      const { stockConId, the98StockLegId } = await siblingCoveredCalls(inAWeekIso());
      const execution = executionOf({ side: "SLD", shares: 100, price: 95.5, time: nowAsIbkrTime() });
      await recorder.recordExecution(stockContractOf(stockConId), execution);
      expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: the98StockLegId });
    });

    it("the assigned call's shares already closed by the reconciliation: the sale closes that leg at the strike, not the open sibling's", async () => {
      const { stockConId, the94StockLegId, the98StockLegId } = await siblingCoveredCalls(yesterdayIso());
      await testDb("position_legs").where({ id: the94StockLegId }).update({ exit_at: new Date(Date.now() - 3_600_000), exit_price: 97.48 });
      const execution = executionOf({ side: "SLD", shares: 100, price: 94, time: nowAsIbkrTime() });
      await recorder.recordExecution(stockContractOf(stockConId), execution);
      expect(await tradeOf(execution.execId!)).toMatchObject({ position_leg_id: the94StockLegId, is_closing_trade: true });
      expect(Number((await testDb("position_legs").where({ id: the94StockLegId }).first()).exit_price)).toBe(94);
      expect(await testDb("trades").where({ position_leg_id: the98StockLegId })).toHaveLength(0);
    });

    it("an early-assigned call the reconciliation closed with no exit ends at 0 once its stock fill arrives", async () => {
      const { tickerId, stockConId, the94StockLegId } = await siblingCoveredCalls(inAWeekIso());
      const the94CallLeg = await testDb("position_legs").join("positions", "positions.id", "position_legs.position_id").where({ "positions.ticker_id": tickerId, "position_legs.strike_price": 94 }).first("position_legs.id");
      await testDb("position_legs").where({ id: the94CallLeg.id }).update({ exit_at: new Date(Date.now() - 600_000), exit_price: null });
      await recorder.recordExecution(stockContractOf(stockConId), executionOf({ side: "SLD", shares: 100, price: 94, time: nowAsIbkrTime() }));
      const settledCallLeg = await testDb("position_legs").where({ id: the94CallLeg.id }).first();
      expect(settledCallLeg.exit_price === null ? null : Number(settledCallLeg.exit_price)).toBe(0);
      expect(await testDb("trades").where({ position_leg_id: the94StockLegId })).toHaveLength(1);
    });

    it("a put assigned while covered calls hold the stock: the shares wait for the leftover-stock position, or join it when it exists", async () => {
      const { tickerId, stockConId, the98StockLegId, the94StockLegId } = await siblingCoveredCalls(inAWeekIso());
      const cspId = await positionOn(tickerId, "cash_secured_put");
      await shortOptionOn(cspId, "put", 100, yesterdayIso());

      const waiting = executionOf({ side: "BOT", shares: 100, price: 100, time: nowAsIbkrTime() });
      await recorder.recordExecution(stockContractOf(stockConId), waiting);
      expect(await tradeCount(waiting.execId!)).toBe(0);
      expect(recorder.bufferedOpeningExecutionCount(stockConId)).toBe(1);

      const leftoverId = await positionOn(tickerId, "unstructured");
      const leftoverStockLegId = await stockLegOn(leftoverId, stockConId, new Date());
      const joining = executionOf({ side: "BOT", shares: 100, price: 100, time: nowAsIbkrTime() });
      await recorder.recordExecution(stockContractOf(stockConId), joining);
      expect(await tradeOf(joining.execId!)).toMatchObject({ position_leg_id: leftoverStockLegId, is_closing_trade: false });
      expect(await testDb("trades").whereIn("position_leg_id", [the98StockLegId, the94StockLegId])).toHaveLength(0);
    });
  });

  describe("commissions", () => {
    const report = (execId: string | undefined, commission: number | undefined): CommissionReport => ({ execId, commission }) as CommissionReport;

    it("writes a commission onto an existing trade", async () => {
      const conId = nextConId();
      await createLeg("long", conId);
      const execution = executionOf({ side: "SLD" });
      await recorder.recordExecution(contractOf(conId), execution);
      await recorder.recordCommission(report(execution.execId, 1.3));
      expect(Number((await tradeOf(execution.execId!)).commission)).toBe(1.3);
      expect(recorder.pendingCommissionCount()).toBe(0);
    });

    it("holds a commission that arrives before its trade and applies it when the trade is written", async () => {
      const conId = nextConId();
      const execution = executionOf({ side: "BOT" });
      await recorder.recordCommission(report(execution.execId, 0.65));
      expect(recorder.pendingCommissionCount()).toBe(1);

      await recorder.recordExecution(contractOf(conId), execution);
      const { legId } = await createLeg("long", conId);
      await recorder.drainPendingOpeningExecutions(conId, legId);

      expect(Number((await tradeOf(execution.execId!)).commission)).toBe(0.65);
      expect(recorder.pendingCommissionCount()).toBe(0);
    });

    it("applies a held commission to a closing trade as it is written", async () => {
      const conId = nextConId();
      await createLeg("long", conId);
      const execution = executionOf({ side: "SLD" });
      await recorder.recordCommission(report(execution.execId, 2.1));
      await recorder.recordExecution(contractOf(conId), execution);
      expect(Number((await tradeOf(execution.execId!)).commission)).toBe(2.1);
    });

    it("ignores a report with no execId and values IBKR sends for 'not known yet' or that are not real amounts", async () => {
      await recorder.recordCommission(report(undefined, 1));
      for (const commission of [Number.MAX_VALUE, 1e9, -0.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
        await recorder.recordCommission(report(nextExecId(), commission));
      }
      expect(recorder.pendingCommissionCount()).toBe(0);
    });

    it("accepts a zero commission", async () => {
      await recorder.recordCommission(report(nextExecId(), 0));
      expect(recorder.pendingCommissionCount()).toBe(1);
    });

    it("keeps the latest value when the same held commission is reported twice", async () => {
      const conId = nextConId();
      await createLeg("long", conId);
      const execution = executionOf({ side: "SLD" });
      await recorder.recordCommission(report(execution.execId, 1));
      await recorder.recordCommission(report(execution.execId, 1.5));
      expect(recorder.pendingCommissionCount()).toBe(1);
      await recorder.recordExecution(contractOf(conId), execution);
      expect(Number((await tradeOf(execution.execId!)).commission)).toBe(1.5);
    });

    it(`holds at most ${maxPendingCommissions} and drops the oldest first`, async () => {
      const firstExecId = nextExecId();
      await recorder.recordCommission(report(firstExecId, 1));
      for (let index = 0; index < maxPendingCommissions; index++) await recorder.recordCommission(report(nextExecId(), 1));
      expect(recorder.pendingCommissionCount()).toBe(maxPendingCommissions);

      const conId = nextConId();
      await createLeg("long", conId);
      await recorder.recordExecution(contractOf(conId), { ...executionOf({ side: "SLD" }), execId: firstExecId });
      expect((await tradeOf(firstExecId)).commission).toBeNull();
    });
  });
});
