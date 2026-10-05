import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary from "knex";

// Runs the real order_requests conditional UPDATE and the reason check constraint against the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run unfilled order sweep database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { requestCancelOfUnfilledOrders } = await import("./ibkrGatewayUnfilledOrderSweep.js");
const { recordIbkrCancellationReason } = await import("./ibkrGatewayCancellationRecording.js");

const now = new Date("2026-10-05T15:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const payload = { symbol: "INTC", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "INTC", quantity: 1, unitPrice: 1.31, strike: 110, expiry: "20261009", right: "P" }] };
let userId: string;
const createdOrderIds: string[] = [];

async function insertOrder(fields: Record<string, unknown>): Promise<string> {
  const [row] = await db("order_requests")
    .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify(payload), status: "submitted", ibkr_order_id: 991000 + createdOrderIds.length, ...fields })
    .returning("id");
  createdOrderIds.push(row.id);
  return row.id;
}
const sweepAt = (minutes: number) => requestCancelOfUnfilledOrders({ loadMinutes: async () => minutes, now: () => now });
const read = (id: string) => db("order_requests").where({ id }).first();

beforeAll(async () => {
  const [user] = await db("users").insert({ username: `sweep-${Date.now()}`, display_name: "Sweep Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});
afterEach(async () => {
  await db("order_requests").whereIn("id", createdOrderIds.splice(0)).del();
});
afterAll(async () => {
  await db("users").where({ id: userId }).del();
  await db.destroy();
});

describe("requestCancelOfUnfilledOrders", () => {
  it("moves an order resting past the limit to cancel_requested with its reason, and leaves a younger one alone", async () => {
    const old = await insertOrder({ placed_at: minutesAgo(16) });
    const young = await insertOrder({ placed_at: minutesAgo(14) });
    expect(await sweepAt(15)).toEqual([old]);
    expect(await read(old)).toMatchObject({ status: "cancel_requested", cancellation_reason: "not_filled_in_time", cancelled_by_user_id: null });
    expect(await read(young)).toMatchObject({ status: "submitted", cancellation_reason: null });
  });

  it("also cancels the rest of a partly filled order, and only once", async () => {
    const id = await insertOrder({ status: "partially_filled", placed_at: minutesAgo(40) });
    expect(await sweepAt(15)).toEqual([id]);
    expect(await sweepAt(15)).toEqual([]);
    expect((await read(id)).status).toBe("cancel_requested");
  });

  it("does nothing when the limit is 0 (never)", async () => {
    const id = await insertOrder({ placed_at: minutesAgo(600) });
    expect(await sweepAt(0)).toEqual([]);
    expect((await read(id)).status).toBe("submitted");
  });

  it("ignores orders not yet placed, already final, or never sent (no placed_at / ibkr_order_id / other status)", async () => {
    const noPlacedAt = await insertOrder({ placed_at: null });
    const confirmed = await insertOrder({ status: "confirmed", ibkr_order_id: null, placed_at: minutesAgo(60) });
    const filled = await insertOrder({ status: "filled", placed_at: minutesAgo(60) });
    expect(await sweepAt(15)).toEqual([]);
    for (const id of [noPlacedAt, confirmed, filled]) expect((await read(id)).cancellation_reason).toBeNull();
  });
});

describe("the sweep's reason", () => {
  it("is kept when IBKR confirms the cancel (the clock-based guess must not replace it)", async () => {
    const id = await insertOrder({ placed_at: minutesAgo(16) });
    await sweepAt(15);
    await db("order_requests").where({ id }).update({ status: "cancelled" });
    await recordIbkrCancellationReason(id, db, new Date("2026-10-05T20:30:00Z"));
    expect((await read(id)).cancellation_reason).toBe("not_filled_in_time");
  });
});
