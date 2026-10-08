import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Audit C (2026-10-07): Pluto's book is every open position on a bot-enabled shortlist ticker except hedges, whoever
// opened it; plutoOpenedPositionIds labels the Pluto-opened ones; managedNotional = Pluto orders + any order on an
// enabled ticker. Open positions here live only for the length of one test (created and deleted inside it), because
// the reconcile test file sweeps open positions on the shared test DB.

vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the Pluto book audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));

const { db } = await import("../db/connection.js");
const testDb: Knex = db;
const { loadPlutoBook, loadInFlightNotionals, loadOccupiedContracts } = await import("./book.js");

let counter = Date.now() % 100_000;
let userId: string;
let passId: string;
const tickerIds: string[] = [];
const positionIds: string[] = [];
const orderIds: string[] = [];
const actionIds: string[] = [];

async function createTicker(entry: { botEnabled: boolean; removed?: boolean } | null): Promise<{ id: string; symbol: string }> {
  const symbol = `AB${(counter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Audit C Book Co", sector: "Technology" }).returning(["id"]);
  tickerIds.push(ticker.id);
  if (entry) await testDb("shortlist_entries").insert({ ticker_id: ticker.id, added_by_user_id: userId, signals_enabled: true, bot_enabled: entry.botEnabled, removed_at: entry.removed ? new Date() : null });
  return { id: ticker.id, symbol };
}

async function createPosition(tickerId: string, strategyKey: string, status: "open" | "closed", leg: Record<string, unknown>): Promise<{ positionId: string; legId: string }> {
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status, closed_at: status === "closed" ? new Date() : null }).returning(["id"]);
  positionIds.push(position.id);
  const [row] = await testDb("position_legs").insert({ position_id: position.id, multiplier: 100, entry_at: new Date(Date.now() - 86_400_000), ...leg }).returning(["id"]);
  return { positionId: position.id, legId: row.id };
}

const put = (strike: number) => ({ leg_type: "option", side: "short", quantity: 1, option_type: "put", strike_price: strike, expiry_date: "2031-03-21", entry_price: 1 });
const stock = (shares: number, price: number) => ({ leg_type: "stock", side: "long", quantity: shares, multiplier: 1, entry_price: price });

async function plutoAction(symbol: string): Promise<string> {
  const [action] = await testDb("pluto_actions").insert({ pass_id: passId, kind: "open_cash_secured_put", symbol, outcome: "filled" }).returning(["id"]);
  actionIds.push(action.id);
  return action.id;
}

async function fillFromPlutoOrder(legId: string, symbol: string): Promise<void> {
  const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "open_cash_secured_put", payload: JSON.stringify({ symbol, legs: [] }), status: "filled", pluto_action_id: await plutoAction(symbol) }).returning(["id"]);
  orderIds.push(order.id);
  await testDb("trades").insert({ position_leg_id: legId, ibkr_exec_id: `audit-c-book-${legId}`, side: "sell", quantity: 1, price: 1, executed_at: new Date(Date.now() - 86_400_000), is_closing_trade: false, source_order_request_id: order.id });
}

async function insertOrder(symbol: string, status: string, options: { pluto?: boolean; strike?: number; quantity?: number; requestType?: string } = {}): Promise<string> {
  const payload = { symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", strike: options.strike ?? 50, quantity: options.quantity ?? 1, expiry: "20310321", right: "P", unitPrice: 1 }] };
  const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: options.requestType ?? "open_cash_secured_put", payload: JSON.stringify(payload), status, pluto_action_id: options.pluto ? await plutoAction(symbol) : null }).returning(["id"]);
  orderIds.push(order.id);
  return order.id;
}

async function deletePositions(): Promise<void> {
  if (positionIds.length === 0) return;
  await testDb("trades").whereIn("position_leg_id", testDb("position_legs").whereIn("position_id", positionIds).select("id")).delete();
  await testDb("position_share_sources").whereIn("position_id", positionIds).orWhereIn("source_position_id", positionIds).delete();
  await testDb("position_legs").whereIn("position_id", positionIds).delete();
  await testDb("positions").whereIn("id", positionIds).delete();
  positionIds.length = 0;
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `audit-c-book-${Date.now()}`, display_name: "Audit C book", password_hash: "x" }).returning(["id"]);
  userId = user.id;
  const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ test: "audit-c-book" }), model_called: false }).returning(["id"]);
  passId = pass.id;
});

afterAll(async () => {
  await deletePositions();
  if (orderIds.length > 0) await testDb("order_requests").whereIn("id", orderIds).delete();
  if (actionIds.length > 0) await testDb("pluto_actions").whereIn("id", actionIds).delete();
  if (passId) await testDb("pluto_passes").where({ id: passId }).delete();
  if (tickerIds.length > 0) {
    await testDb("shortlist_entries").whereIn("ticker_id", tickerIds).delete();
    await testDb("tickers").whereIn("id", tickerIds).delete();
  }
  if (userId) await testDb("users").where({ id: userId }).delete();
  await testDb.destroy();
});

describe("loadPlutoBook (test DB)", () => {
  it("scopes the book to open, non-hedge positions on bot-enabled, not-removed shortlist tickers, and labels Pluto's own", async () => {
    try {
      const enabled = await createTicker({ botEnabled: true });
      const disabled = await createTicker({ botEnabled: false });
      const removed = await createTicker({ botEnabled: true, removed: true });
      const notListed = await createTicker(null);

      const human = await createPosition(enabled.id, "cash_secured_put", "open", put(40));
      const plutoOwn = await createPosition(enabled.id, "cash_secured_put", "open", put(45));
      await fillFromPlutoOrder(plutoOwn.legId, enabled.symbol);
      // Shares that came from Pluto's put (assignment) are Pluto's too, transitively.
      const fromPluto = await createPosition(enabled.id, "unstructured", "open", stock(100, 45));
      await testDb("position_share_sources").insert({ position_id: fromPluto.positionId, source_position_id: plutoOwn.positionId });
      const hedge = await createPosition(enabled.id, "hedge", "open", { leg_type: "option", side: "long", quantity: 2, option_type: "call", strike_price: 60, expiry_date: "2031-12-19", entry_price: 3 });
      const closed = await createPosition(enabled.id, "cash_secured_put", "closed", put(35));
      const plutoOnDisabled = await createPosition(disabled.id, "cash_secured_put", "open", put(40));
      await fillFromPlutoOrder(plutoOnDisabled.legId, disabled.symbol);
      const onRemoved = await createPosition(removed.id, "cash_secured_put", "open", put(40));
      const onNotListed = await createPosition(notListed.id, "cash_secured_put", "open", put(40));

      const book = await loadPlutoBook();
      const ids = book.openPositions.map((position) => position.positionId);
      expect(ids).toEqual(expect.arrayContaining([human.positionId, plutoOwn.positionId, fromPluto.positionId]));
      for (const excluded of [hedge, closed, plutoOnDisabled, onRemoved, onNotListed]) expect(ids).not.toContain(excluded.positionId);
      // No duplicates from the shortlist join.
      expect(new Set(ids).size).toBe(ids.length);

      expect(book.plutoOpenedPositionIds.has(plutoOwn.positionId)).toBe(true);
      expect(book.plutoOpenedPositionIds.has(fromPluto.positionId)).toBe(true);
      expect(book.plutoOpenedPositionIds.has(human.positionId)).toBe(false);
      // A Pluto-opened position outside the book is not labelled either (the set is a subset of openPositions).
      expect(book.plutoOpenedPositionIds.has(plutoOnDisabled.positionId)).toBe(false);
      for (const id of book.plutoOpenedPositionIds) expect(ids).toContain(id);

      // The person's put counts in the budget like Pluto's: strike × 100.
      const byId = new Map(book.openPositions.map((position) => [position.positionId, position]));
      expect(byId.get(human.positionId)!.capitalAtRisk).toBeCloseTo(4000, 6);
      expect(byId.get(plutoOwn.positionId)!.capitalAtRisk).toBeCloseTo(4500, 6);
      expect(byId.get(fromPluto.positionId)!.capitalAtRisk).toBeCloseTo(4500, 6);
      expect(book.committedDollars).toBeCloseTo(book.openPositions.reduce((sum, position) => sum + position.capitalAtRisk, 0), 6);
      expect(book.openSymbols.has(enabled.symbol)).toBe(true);
      expect(book.openSymbols.has(disabled.symbol)).toBe(false);
      expect(book.lastFilledActionAtBySymbol.has(enabled.symbol)).toBe(true);
    } finally {
      await deletePositions();
    }
  });

  it("disabling a ticker hands every position on it back, Pluto's own included", async () => {
    try {
      const ticker = await createTicker({ botEnabled: true });
      const plutoOwn = await createPosition(ticker.id, "cash_secured_put", "open", put(40));
      await fillFromPlutoOrder(plutoOwn.legId, ticker.symbol);
      expect((await loadPlutoBook()).openPositions.map((position) => position.positionId)).toContain(plutoOwn.positionId);
      await testDb("shortlist_entries").where({ ticker_id: ticker.id }).update({ bot_enabled: false });
      const after = await loadPlutoBook();
      expect(after.openPositions.map((position) => position.positionId)).not.toContain(plutoOwn.positionId);
      expect(after.plutoOpenedPositionIds.has(plutoOwn.positionId)).toBe(false);
    } finally {
      await deletePositions();
    }
  });

  it("workingOrderSymbols are Pluto's active orders only", async () => {
    const ticker = await createTicker({ botEnabled: true });
    const other = await createTicker({ botEnabled: true });
    await insertOrder(ticker.symbol, "submitted", { pluto: true });
    await insertOrder(other.symbol, "submitted");
    const book = await loadPlutoBook();
    expect(book.workingOrderSymbols.has(ticker.symbol)).toBe(true);
    expect(book.workingOrderSymbols.has(other.symbol)).toBe(false);
  });
});

describe("loadInFlightNotionals (test DB)", () => {
  it("managedNotional = Pluto orders anywhere + anyone's order on an enabled ticker; pending and final orders never count", async () => {
    const enabled = await createTicker({ botEnabled: true });
    const disabled = await createTicker({ botEnabled: false });
    const removed = await createTicker({ botEnabled: true, removed: true });
    const before = await loadInFlightNotionals(enabled.symbol);

    await insertOrder(enabled.symbol, "confirmed", { strike: 50, quantity: 2 }); // person, enabled: 10,000 managed
    await insertOrder(disabled.symbol, "submitted", { strike: 30 }); // person, disabled: 3,000 not managed
    await insertOrder(disabled.symbol, "partially_filled", { strike: 20, pluto: true }); // Pluto, disabled: 2,000 managed
    await insertOrder(removed.symbol, "cancel_requested", { strike: 10 }); // person, removed entry: 1,000 not managed
    await insertOrder(enabled.symbol, "pending_confirmation", { strike: 70 }); // not in flight yet
    const filledOrderId = await insertOrder(enabled.symbol, "filled", { strike: 80 }); // done (past the fill wait)
    await testDb("order_requests").where({ id: filledOrderId }).update({ updated_at: new Date(Date.now() - 10 * 60_000) });
    await insertOrder(enabled.symbol, "confirmed", { strike: 90, requestType: "close_position" }); // a close adds nothing

    const after = await loadInFlightNotionals(enabled.symbol);
    expect(after.totalNotional - before.totalNotional).toBeCloseTo(10_000 + 3_000 + 2_000 + 1_000, 6);
    expect(after.tickerNotional - before.tickerNotional).toBeCloseTo(10_000, 6);
    expect(after.managedNotional - before.managedNotional).toBeCloseTo(10_000 + 2_000, 6);
  });
});

describe("an order IBKR reported filled whose fills are not recorded yet (test DB, 2026-10-08)", () => {
  it("still takes its contract, counts as a working Pluto order and stays in flight; past the fill wait it is done", async () => {
    const enabled = await createTicker({ botEnabled: true });
    const orderId = await insertOrder(enabled.symbol, "filled", { strike: 61, quantity: 2, pluto: true });
    expect(await loadOccupiedContracts(enabled.symbol)).toEqual([expect.objectContaining({ expiry: "2031-03-21", strike: 61 })]);
    expect((await loadPlutoBook()).workingOrderSymbols.has(enabled.symbol)).toBe(true);
    expect((await loadInFlightNotionals(enabled.symbol)).tickerNotional).toBeCloseTo(61 * 100 * 2, 6);

    await testDb("order_requests").where({ id: orderId }).update({ updated_at: new Date(Date.now() - 10 * 60_000) });
    expect(await loadOccupiedContracts(enabled.symbol)).toEqual([]);
    expect((await loadPlutoBook()).workingOrderSymbols.has(enabled.symbol)).toBe(false);
    expect((await loadInFlightNotionals(enabled.symbol)).tickerNotional).toBe(0);
  });
});
