import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../config/env.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run Pluto realized P&L tests.");
}

// The read-time join against the real test database: a Pluto CSP that expired (closed leg),
// a Pluto roll (owns the leg it opened; the closed leg stays with the opener), a Pluto close of
// human-opened shares (closer owns it), and an open leg that contributes nothing yet.
const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });

let userId: string;
let tickerId: string;
let passId: string;
const positionIds: string[] = [];
const orderIds: string[] = [];

async function order(): Promise<string> {
  const [row] = await db("order_requests").insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify({}), status: "filled" }).returning("id");
  orderIds.push(row.id);
  return row.id;
}
async function position(): Promise<string> {
  const [row] = await db("positions").insert({ strategy_key: "cash_secured_put", ticker_id: tickerId, status: "closed" }).returning("id");
  positionIds.push(row.id);
  return row.id;
}
async function leg(positionId: string, input: { side: "short" | "long"; legType?: "option" | "stock"; entry: number; exit: number | null; quantity?: number; multiplier?: number }): Promise<string> {
  const [row] = await db("position_legs")
    .insert({ position_id: positionId, leg_type: input.legType ?? "option", option_type: input.legType === "stock" ? null : "put", side: input.side, quantity: input.quantity ?? 1, multiplier: input.multiplier ?? (input.legType === "stock" ? 1 : 100), entry_price: input.entry, entry_at: db.fn.now(), exit_price: input.exit, exit_at: input.exit === null ? null : db.fn.now(), strike_price: input.legType === "stock" ? null : 100, expiry_date: input.legType === "stock" ? null : "2026-10-16" })
    .returning("id");
  return row.id;
}
async function trade(legId: string, orderId: string, closing: boolean, commission = 0): Promise<void> {
  await db("trades").insert({ position_leg_id: legId, ibkr_order_id: `t-${Date.now()}-${Math.random()}`, side: closing ? "buy" : "sell", quantity: 1, price: 1, commission, executed_at: db.fn.now(), is_closing_trade: closing, source_order_request_id: orderId });
}
async function action(orderId: string | null, kind = "open_cash_secured_put"): Promise<string> {
  const [row] = await db("pluto_actions").insert({ pass_id: passId, kind, symbol: "PLT", ticker_id: tickerId, outcome: "filled", order_request_id: orderId }).returning("id");
  return row.id;
}

beforeAll(async () => {
  const [user] = await db("users").insert({ username: `pluto-pnl-${Date.now()}`, display_name: "Pluto P&L Test", password_hash: "x" }).returning("id");
  userId = user.id;
  const [ticker] = await db("tickers").insert({ symbol: `PLP${Date.now() % 100000}`, company_name: "Pluto P&L Co", sector: "Technology" }).returning("id");
  tickerId = ticker.id;
  const [pass] = await db("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ test: true }) }).returning("id");
  passId = pass.id;
});

afterAll(async () => {
  await db("pluto_passes").where({ id: passId }).del();
  for (const positionId of positionIds) {
    await db("trades").whereIn("position_leg_id", db("position_legs").select("id").where({ position_id: positionId })).del();
    await db("position_legs").where({ position_id: positionId }).del();
    await db("positions").where({ id: positionId }).del();
  }
  await db("order_requests").whereIn("id", orderIds).del();
  await db("tickers").where({ id: tickerId }).del();
  await db("users").where({ id: userId }).del();
  await db.destroy();
});

describe("loadRealizedPnlByActionId", () => {
  it("attributes each leg to the Pluto action that opened it, or to the closer when a human opened it", async () => {
    const { loadRealizedPnlByActionId } = await import("./actionRealizedPnl.js");

    // 1. Pluto sold a put at 2.00 that expired worthless: +200 for the opening action, minus 0 closing commission.
    const expiredPosition = await position();
    const expiredLeg = await leg(expiredPosition, { side: "short", entry: 2.0, exit: 0 });
    const openOrder = await order();
    await trade(expiredLeg, openOrder, false, 1.05);
    const openAction = await action(openOrder);

    // 2. Pluto rolled: bought back a human-opened put at 1.50 (entry 3.00, commission 1.00) and sold a new one at 2.50, still open.
    const rolledPosition = await position();
    const oldLeg = await leg(rolledPosition, { side: "short", entry: 3.0, exit: 1.5 });
    const newLeg = await leg(rolledPosition, { side: "short", entry: 2.5, exit: null });
    const rollOrder = await order();
    await trade(oldLeg, rollOrder, true, 1.0);
    await trade(newLeg, rollOrder, false, 1.0);
    const rollAction = await action(rollOrder, "roll");

    // 3. Pluto closed 100 human-opened shares: bought 90, sold 95, commission 0.35.
    const sharesPosition = await position();
    const sharesLeg = await leg(sharesPosition, { side: "long", legType: "stock", entry: 90, exit: 95, quantity: 100 });
    const closeOrder = await order();
    await trade(sharesLeg, closeOrder, true, 0.35);
    const closeAction = await action(closeOrder, "close_shares");

    // 4. A blocked action never had an order.
    const blockedAction = await action(null);

    const realized = await loadRealizedPnlByActionId([openAction, rollAction, closeAction, blockedAction], db);
    expect(realized.get(openAction)).toEqual({ realizedPnl: 200, closedLegCount: 1, openLegCount: 0 });
    // The roll owns only the leg it opened (still open) — the bought-back leg had no Pluto opener, so the roll action owns that too: (3.00 − 1.50) × 100 − 1.00 = 149.
    expect(realized.get(rollAction)).toEqual({ realizedPnl: 149, closedLegCount: 1, openLegCount: 1 });
    expect(realized.get(closeAction)).toEqual({ realizedPnl: 499.65, closedLegCount: 1, openLegCount: 0 });
    expect(realized.has(blockedAction)).toBe(false);
  });

  it("gives a Pluto-opened leg to its opener, not to the Pluto action that later closed it", async () => {
    const { loadRealizedPnlByActionId } = await import("./actionRealizedPnl.js");
    const positionId = await position();
    const legId = await leg(positionId, { side: "short", entry: 2.0, exit: 0.5 });
    const openOrder = await order();
    const closeOrder = await order();
    await trade(legId, openOrder, false);
    await trade(legId, closeOrder, true, 0.5);
    const opener = await action(openOrder);
    const closer = await action(closeOrder, "close_leg");
    const realized = await loadRealizedPnlByActionId([opener, closer], db);
    expect(realized.get(opener)).toEqual({ realizedPnl: 149.5, closedLegCount: 1, openLegCount: 0 });
    expect(realized.has(closer)).toBe(false);
  });
});
