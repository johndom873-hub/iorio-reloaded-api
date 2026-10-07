import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Which orders the trading-events catch-all picks up, against the real order_requests and users tables of the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the order Telegram notice tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { createDatabaseDependencies } = await import("./orderTelegramNotices.js");
const testDb: Knex = db;

const createdOrderIds: string[] = [];
let requesterId: string;
let cancellerId: string;
const payload = {
  symbol: "OTN",
  strategyKey: "cash_secured_put",
  legs: [{ role: "option", action: "SELL", symbol: "OTN", quantity: 1, unitPrice: 1.25, strike: 50, expiry: "20311017", right: "P" }],
};

async function createOrder(fields: Record<string, unknown>): Promise<string> {
  const [order] = await testDb("order_requests")
    .insert({ requested_by_user_id: requesterId, request_type: "open_cash_secured_put", payload, status: "submitted", ...fields })
    .returning(["id"]);
  createdOrderIds.push(order.id);
  return order.id;
}

beforeAll(async () => {
  const suffix = Date.now();
  const [requester] = await testDb("users").insert({ username: `otn_requester_${suffix}`, display_name: "Requester", password_hash: "x" }).returning(["id"]);
  const [canceller] = await testDb("users").insert({ username: `otn_canceller_${suffix}`, display_name: "Canceller", password_hash: "x" }).returning(["id"]);
  requesterId = requester.id;
  cancellerId = canceller.id;
});

afterAll(async () => {
  await testDb("order_requests").whereIn("id", createdOrderIds).del();
  await testDb("users").whereIn("id", [requesterId, cancellerId]).del();
  await testDb.destroy();
});

describe("order Telegram notice database dependencies", () => {
  it("picks up an order once per status change, and never one that is old, internal, already told or cancelled before it was sent", async () => {
    const changed = await createOrder({});
    const cancelled = await createOrder({ status: "cancelled", cancelled_by_user_id: cancellerId, ibkr_order_id: 4242 });
    const staleUnconfirmed = await createOrder({ status: "cancelled", cancellation_reason: "not_confirmed_in_time" });
    const neverSent = await createOrder({ status: "cancelled", cancelled_by_user_id: cancellerId });
    const alreadyTold = await createOrder({ telegram_notified_status: "submitted" });
    const internal = await createOrder({ status: "pending_confirmation" });
    const old = await createOrder({ created_at: new Date(Date.now() - 49 * 3_600_000) });
    const dependencies = createDatabaseDependencies();

    const due = (await dependencies.loadOrdersNeedingNotice()).filter((order) => createdOrderIds.includes(order.id));
    expect(due.map((order) => order.id).sort()).toEqual([changed, cancelled, staleUnconfirmed].sort());
    expect(due.find((order) => order.id === changed)).toMatchObject({ symbol: "OTN", placedBy: "Requester, web", legs: payload.legs });
    expect(due.find((order) => order.id === cancelled)).toMatchObject({ cancelledByDisplayName: "Canceller" });
    expect([alreadyTold, internal, old, neverSent].some((id) => due.some((order) => order.id === id))).toBe(false);

    await dependencies.markNotified(changed, "submitted");
    const afterMark = (await dependencies.loadOrdersNeedingNotice()).map((order) => order.id);
    expect(afterMark).not.toContain(changed);

    await testDb("order_requests").where({ id: changed }).update({ status: "filled" });
    expect((await dependencies.loadOrdersNeedingNotice()).find((order) => order.id === changed)).toMatchObject({ status: "filled" });
  });
});
