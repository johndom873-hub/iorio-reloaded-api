import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import knexLibrary from "knex";

// Runs the real order_requests updates (status, cancellation_reason, the check constraint) against the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run cancellation recording database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { recordIbkrCancellationReason, recordIbkrOrderCanceled } = await import("./ibkrGatewayCancellationRecording.js");
type ExecutedOutcome = import("./ibkrGatewayCancellationRecording.js").ExecutedOutcome;

const createdAt = new Date("2026-09-29T14:29:00Z"); // 10:29 ET
const afterClose = new Date("2026-09-29T20:30:35Z"); // 16:30 ET
const beforeClose = new Date("2026-09-29T18:00:00Z"); // 14:00 ET
const payload = { symbol: "INTC", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "INTC", quantity: 2, unitPrice: 1.31, strike: 110, expiry: "20261002", right: "P" }] };
let userId: string;
const createdOrderIds: string[] = [];

async function insertOrder(fields: Record<string, unknown>): Promise<string> {
  const [row] = await db("order_requests")
    .insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify(payload), created_at: createdAt, updated_at: createdAt, ...fields })
    .returning("id");
  createdOrderIds.push(row.id);
  return row.id;
}

function dependencies(outcome: ExecutedOutcome, now: Date) {
  const notified: string[] = [];
  return { notified, deps: { executedOutcome: async () => outcome, notify: async (id: string) => void notified.push(id), now: () => now } };
}

beforeAll(async () => {
  const [user] = await db("users").insert({ username: `cancel-rec-${Date.now()}`, display_name: "Cancel Recording Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
});
afterEach(async () => {
  await db("order_requests").whereIn("id", createdOrderIds.splice(0)).del();
});
afterAll(async () => {
  await db("users").where({ id: userId }).del();
  await db.destroy();
});

describe("recordIbkrOrderCanceled (error 202)", () => {
  it("ends a working order as cancelled, expired at the close, once, with no error message", async () => {
    const id = await insertOrder({ status: "submitted", ibkr_order_id: 990001 });
    const { notified, deps } = dependencies("none", afterClose);
    await recordIbkrOrderCanceled(990001, "Order Canceled - reason:", deps);
    await recordIbkrOrderCanceled(990001, "Order Canceled - reason:", deps);
    const row = await db("order_requests").where({ id }).first();
    expect(row).toMatchObject({ status: "cancelled", cancellation_reason: "expired_at_close", error_message: null });
    expect(notified).toEqual([id]);
  });

  it("keeps IBKR's reason and calls an earlier cancel IBKR's own", async () => {
    const id = await insertOrder({ status: "submitted", ibkr_order_id: 990002 });
    await recordIbkrOrderCanceled(990002, "Order Canceled - reason:Not enough buying power", dependencies("none", beforeClose).deps);
    expect(await db("order_requests").where({ id }).first()).toMatchObject({ status: "cancelled", cancellation_reason: "cancelled_by_ibkr", error_message: "IBKR: Not enough buying power" });
  });

  it("leaves a user's cancel without a reason (cancelled_by_user_id already says who)", async () => {
    const id = await insertOrder({ status: "cancel_requested", ibkr_order_id: 990003, cancelled_by_user_id: userId });
    await recordIbkrOrderCanceled(990003, "Order Canceled - reason:", dependencies("none", afterClose).deps);
    expect(await db("order_requests").where({ id }).first()).toMatchObject({ status: "cancelled", cancellation_reason: null });
  });

  it("records a cancel after a partial fill as its own status", async () => {
    const id = await insertOrder({ status: "submitted", ibkr_order_id: 990004 });
    await recordIbkrOrderCanceled(990004, "Order Canceled - reason:", dependencies("partially_filled", afterClose).deps);
    expect(await db("order_requests").where({ id }).first()).toMatchObject({ status: "cancelled_partially_filled", cancellation_reason: "expired_at_close" });
  });

  it("does not touch a fully executed order or one already final", async () => {
    const filled = await insertOrder({ status: "submitted", ibkr_order_id: 990005 });
    await recordIbkrOrderCanceled(990005, "Order Canceled - reason:", dependencies("filled", afterClose).deps);
    expect((await db("order_requests").where({ id: filled }).first()).status).toBe("submitted");
    const final = await insertOrder({ status: "error", ibkr_order_id: 990006, error_message: "something else" });
    await recordIbkrOrderCanceled(990006, "Order Canceled - reason:", dependencies("none", afterClose).deps);
    expect(await db("order_requests").where({ id: final }).first()).toMatchObject({ status: "error", cancellation_reason: null, error_message: "something else" });
  });
});

describe("recordIbkrCancellationReason", () => {
  it("calls an order from an earlier Eastern date expired, whatever the time now", async () => {
    const id = await insertOrder({ status: "cancelled", ibkr_order_id: 990007 });
    await recordIbkrCancellationReason(id, db, new Date("2026-09-30T13:35:00Z"));
    expect((await db("order_requests").where({ id }).first()).cancellation_reason).toBe("expired_at_close");
  });

  it("refuses a value outside the allowed reasons (check constraint)", async () => {
    const id = await insertOrder({ status: "cancelled" });
    await expect(db("order_requests").where({ id }).update({ cancellation_reason: "something_else" })).rejects.toThrow(/order_requests_cancellation_reason_check/);
  });
});
