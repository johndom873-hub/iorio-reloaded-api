import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary from "knex";

// Runs the real order_requests queries and stale_alert_sent_at bookkeeping against the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run stale order alert database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { alertOnStaleOrderRequests } = await import("./ibkrGatewayStaleOrderAlert.js");

const now = new Date("2026-10-05T17:21:37Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const payload = { symbol: "HOOD", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "HOOD", quantity: 4, unitPrice: 2.24, strike: 112, expiry: "20261009", right: "P" }] };
let userId: string;
const createdOrderIds: string[] = [];
const sentMessages: string[] = [];

async function insertOrder(fields: Record<string, unknown>): Promise<string> {
  const [row] = await db("order_requests")
    .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify(payload), status: "confirmed", ...fields })
    .returning("id");
  createdOrderIds.push(row.id);
  return row.id;
}
const runAlert = () =>
  alertOnStaleOrderRequests({
    notify: async (message) => {
      sentMessages.push(message);
    },
    now: () => now,
  });
const mentioning = (id: string) => sentMessages.filter((message) => message.includes(id));

beforeAll(async () => {
  const [user] = await db("users").insert({ username: `stale-alert-${Date.now()}`, display_name: "Stale Alert Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});
afterEach(async () => {
  sentMessages.length = 0;
  await db("order_requests").whereIn("id", createdOrderIds.splice(0)).del();
});
afterAll(async () => {
  await db("users").where({ id: userId }).del();
  await db.destroy();
});

describe("alertOnStaleOrderRequests", () => {
  it("does not alert for an old order that only just entered cancel_requested", async () => {
    const id = await insertOrder({ status: "cancel_requested", created_at: minutesAgo(16), updated_at: minutesAgo(0.01) });
    await runAlert();
    expect(mentioning(id)).toEqual([]);
    expect((await db("order_requests").where({ id }).first()).stale_alert_sent_at).toBeNull();
  });

  it("alerts once when cancel_requested has sat unpicked past the threshold, counting from the status change", async () => {
    const id = await insertOrder({ status: "cancel_requested", created_at: minutesAgo(60), updated_at: minutesAgo(6) });
    await runAlert();
    await runAlert();
    expect(mentioning(id)).toEqual([`⚠️ Order request stuck: HOOD (cancel_requested) has not been picked up by the worker for 6+ minute(s) (id ${id}). Check the iorio-worker service on the VPS.`]);
  });

  it("alerts for a confirmed order not picked up past the threshold, and not before it", async () => {
    const stale = await insertOrder({ status: "confirmed", updated_at: minutesAgo(5.5) });
    const fresh = await insertOrder({ status: "confirmed", updated_at: minutesAgo(4.5) });
    await runAlert();
    expect(mentioning(stale)).toHaveLength(1);
    expect(mentioning(fresh)).toEqual([]);
  });

  it("sends the resolved message once the row leaves the stuck statuses, and clears the flag", async () => {
    const id = await insertOrder({ status: "cancel_requested", updated_at: minutesAgo(6) });
    await runAlert();
    await db("order_requests").where({ id }).update({ status: "cancelled", updated_at: db.fn.now() });
    await runAlert();
    await runAlert();
    expect(mentioning(id)).toHaveLength(2);
    expect(mentioning(id)[1]).toBe(`✅ Previously stuck order request resolved: HOOD is now "cancelled" (id ${id}).`);
    expect((await db("order_requests").where({ id }).first()).stale_alert_sent_at).toBeNull();
  });
});
