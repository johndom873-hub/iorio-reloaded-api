import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Audit B (2026-10-07): the prompt's opened_by label (prompt.ts) comes from plutoOpenedPositionIdsCte. Checked here against
// the test database with a human-opened position on which a Pluto order only CLOSED a leg.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { plutoOpenedPositionIdsCte } = await import("./book.js");
const testDb: Knex = db;

let userId: string;
let tickerId: string;
let passId: string;
const positionIds: string[] = [];
const orderIds: string[] = [];

async function order(plutoActionId: string | null): Promise<string> {
  const [row] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "close_leg", payload: JSON.stringify({}), status: "filled", pluto_action_id: plutoActionId }).returning("id");
  orderIds.push(row.id);
  return row.id;
}
async function trade(legId: string, orderId: string, closing: boolean): Promise<void> {
  await testDb("trades").insert({ position_leg_id: legId, ibkr_order_id: `audit-b-${Date.now()}-${Math.random()}`, side: closing ? "buy" : "sell", quantity: 1, price: 1, commission: 0, executed_at: testDb.fn.now(), is_closing_trade: closing, source_order_request_id: orderId });
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `pluto-book-audit-b-${Date.now()}`, display_name: "Book Audit B", password_hash: "x" }).returning("id");
  userId = user.id;
  const [ticker] = await testDb("tickers").insert({ symbol: `ABK${Date.now() % 100000}`, company_name: "Book Audit Co" }).returning("id");
  tickerId = ticker.id;
  const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ auditB: true }) }).returning("id");
  passId = pass.id;
});

afterAll(async () => {
  for (const positionId of positionIds) {
    await testDb("trades").whereIn("position_leg_id", testDb("position_legs").select("id").where({ position_id: positionId })).del();
    await testDb("position_legs").where({ position_id: positionId }).del();
    await testDb("positions").where({ id: positionId }).del();
  }
  await testDb("order_requests").whereIn("id", orderIds).del();
  await testDb("pluto_actions").where({ pass_id: passId }).del();
  await testDb("pluto_passes").where({ id: passId }).del();
  await testDb("tickers").where({ id: tickerId }).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("plutoOpenedPositionIdsCte", () => {
  // BUG: the CTE takes every position a Pluto order traded on, closing trades included, so a person's covered call whose short
  // call Pluto bought back (shares still held) is labelled opened_by "pluto" in the prompt.
  it("does not label a human-opened position 'opened by Pluto' because a Pluto order closed one of its legs", async () => {
    const [position] = await testDb("positions").insert({ strategy_key: "covered_call", ticker_id: tickerId, status: "open" }).returning("id");
    positionIds.push(position.id);
    const [shares] = await testDb("position_legs").insert({ position_id: position.id, leg_type: "stock", side: "long", quantity: 100, multiplier: 1, entry_price: 40, entry_at: testDb.fn.now() }).returning("id");
    const [call] = await testDb("position_legs").insert({ position_id: position.id, leg_type: "option", option_type: "call", side: "short", quantity: 1, multiplier: 100, strike_price: 45, expiry_date: "2098-07-17", entry_price: 1, entry_at: testDb.fn.now(), exit_price: 0.2, exit_at: testDb.fn.now() }).returning("id");
    const humanOrder = await order(null);
    await trade(shares.id, humanOrder, false);
    await trade(call.id, humanOrder, false);
    const [action] = await testDb("pluto_actions").insert({ pass_id: passId, kind: "close_leg", symbol: "ABK", ticker_id: tickerId, outcome: "filled" }).returning("id");
    const plutoBuyback = await order(action.id);
    await trade(call.id, plutoBuyback, true);

    const rows = await testDb.raw(`WITH RECURSIVE ${plutoOpenedPositionIdsCte} SELECT id FROM pluto_opened_position_ids WHERE id = ?`, [position.id]);
    expect(rows.rows).toEqual([]);
  });

  it("labels a position Pluto's when a Pluto order opened a leg on it", async () => {
    const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: tickerId, status: "open" }).returning("id");
    positionIds.push(position.id);
    const [put] = await testDb("position_legs").insert({ position_id: position.id, leg_type: "option", option_type: "put", side: "short", quantity: 1, multiplier: 100, strike_price: 35, expiry_date: "2098-07-17", entry_price: 1, entry_at: testDb.fn.now() }).returning("id");
    const [action] = await testDb("pluto_actions").insert({ pass_id: passId, kind: "open_cash_secured_put", symbol: "ABK", ticker_id: tickerId, outcome: "filled" }).returning("id");
    await trade(put.id, await order(action.id), false);
    const rows = await testDb.raw(`WITH RECURSIVE ${plutoOpenedPositionIdsCte} SELECT id FROM pluto_opened_position_ids WHERE id = ?`, [position.id]);
    expect(rows.rows).toEqual([{ id: position.id }]);
  });
});
