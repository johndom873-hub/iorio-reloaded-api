import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../config/env.js";
import { loadPlutoOrderRequestsByActionId } from "./actionExposure.js";
import { loadPlutoOrdersTodayBreakdown } from "./counters.js";
import { loadPlutoWorkingOrders } from "./orders.js";

if (!environment.testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must be set to run Pluto screen data tests.");
}

// The loaders behind the redesigned Pluto screen's status card and orders table, against the real test database:
// today's order breakdown, the working-orders list and the order request each action is matched with for EXP $.
// Each loader takes the connection, as the state store does, so the test's own knex points them at the test DB.

const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });
const symbol = `PLS${Date.now() % 100000}`;
let passId: string;
let userId: string;
const actionIds: string[] = [];

beforeAll(async () => {
  const [user] = await db("users").insert({ username: `pluto-screen-${Date.now()}`, display_name: "Screen Test", password_hash: "x" }).returning("id");
  userId = user.id;
  const [pass] = await db("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ test: true }), model_called: true }).returning("id");
  passId = pass.id;
  const insertAction = async (kind: string, outcome: string, quantity: number | null) => {
    const [row] = await db("pluto_actions").insert({ pass_id: passId, kind, symbol, contract: JSON.stringify({ strategyKey: "cash_secured_put", expiry: "2026-12-18", strike: 24, right: "P" }), gate_results: "[]", quantity, limit_price: 0.62, outcome }).returning("id");
    actionIds.push(row.id);
    return row.id as string;
  };
  const working = await insertAction("open_cash_secured_put", "confirmed", 2);
  await insertAction("open_cash_secured_put", "filled", 1);
  await insertAction("open_cash_secured_put", "blocked", 3);
  await insertAction("no_trade", "no_trade", null);
  await db("order_requests").insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify({ symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", right: "P", action: "SELL", expiry: "20261218", strike: 24, quantity: 2, unitPrice: 0.62 }] }), status: "submitted", pluto_action_id: working });
});

afterAll(async () => {
  await db("order_requests").whereIn("pluto_action_id", actionIds).del();
  await db("pluto_actions").whereIn("id", actionIds).del();
  await db("pluto_passes").where({ id: passId }).del();
  await db("users").where({ id: userId }).del();
  await db.destroy();
});

describe("loadPlutoOrdersTodayBreakdown", () => {
  it("counts sent, filled, working and blocked separately; no-trade rows count nowhere", async () => {
    const breakdown = await loadPlutoOrdersTodayBreakdown(new Date(), db);
    expect(breakdown.sent).toBeGreaterThanOrEqual(2);
    expect(breakdown.filled).toBeGreaterThanOrEqual(1);
    expect(breakdown.working).toBeGreaterThanOrEqual(1);
    expect(breakdown.blocked).toBeGreaterThanOrEqual(1);
    expect(breakdown.sent).toBeGreaterThanOrEqual(breakdown.filled + breakdown.working);
  });
});

describe("loadPlutoWorkingOrders", () => {
  it("lists the action behind every order IBKR may still be working, with its contract and prices", async () => {
    const orders = await loadPlutoWorkingOrders(db);
    const mine = orders.find((order) => order.symbol === symbol);
    expect(mine).toMatchObject({ kind: "open_cash_secured_put", quantity: 2, limitPrice: 0.62, status: "submitted" });
    expect(mine?.contract).toMatchObject({ strike: 24, right: "P" });
    expect(mine?.orderRequestId).toBeTruthy();
  });
});

describe("loadPlutoOrderRequestsByActionId", () => {
  it("matches each action with its order request; actions without one are absent", async () => {
    const requests = await loadPlutoOrderRequestsByActionId(actionIds, db);
    expect(requests.size).toBe(1);
    const [actionId, request] = [...requests.entries()][0]!;
    expect(actionId).toBe(actionIds[0]);
    expect(request.requestType).toBe("open_cash_secured_put");
    expect(request.payload.legs[0]?.strike).toBe(24);
    expect(await loadPlutoOrderRequestsByActionId([], db)).toEqual(new Map());
  });
});
