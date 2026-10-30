import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { activeOrderRequestStatuses } from "../lib/orderRequestStatuses.js";

// Pluto's Safety Limits (the safety* settings): the caps on orders and positions, the SPY stress breaker and the ticker
// cooldown hold every strategy Pluto runs, so the counts here take the orders of both together (Marcelo 2026-10-27:
// Vol Farmer v2's under the same caps as the CC + Put Ladder's).

export interface SafetyLimitCounts {
  workingOrders: number;
  ordersToday: number;
  openPositions: number;
}

/** Pluto's strategies, whose orders the Safety Limits count together. */
const strategiesUnderSafetyLimits = ["cc_put_ladder", "vol_farmer_v2"];

/** Pluto's open-order rows (open_* order requests of actions taken under its strategies) still working or not yet confirmed. */
function workingPlutoOpenOrderRows(connection: Knex) {
  return connection("order_requests as orq").join("pluto_actions as pa", "pa.id", "orq.pluto_action_id").whereIn("pa.execution_strategy", strategiesUnderSafetyLimits).whereIn("orq.status", [...activeOrderRequestStatuses]).whereRaw("orq.request_type like 'open_%'");
}

/** Pluto's orders sent on the Eastern date of `now`, under either strategy, on `symbol` or (null) across the book: every order built counts. */
export function plutoOrdersSentToday(now: Date, symbol: string | null, connection: Knex = db) {
  const query = connection("pluto_actions").whereIn("execution_strategy", strategiesUnderSafetyLimits).whereNotNull("order_request_id").whereRaw("(created_at at time zone 'America/New_York')::date = ?::date", [easternIsoDate(now)]);
  return (symbol === null ? query : query.where({ symbol })).count({ count: "*" }).first();
}

/** Pluto's orders sent today across the book, as the book's daily cap counts them (the screen's "Orders today"). */
export async function loadPlutoOrdersSentToday(now: Date, connection: Knex = db): Promise<number> {
  return Number((await plutoOrdersSentToday(now, null, connection))?.count ?? 0);
}

/** The book's counts: open positions on Pluto's tickers, Pluto's working orders on them, and its orders sent today. */
export async function loadSafetyLimitBookCounts(tickers: readonly { tickerId: string; symbol: string }[], now: Date, connection: Knex = db): Promise<SafetyLimitCounts> {
  const [working, ordersToday, openPositions] = await Promise.all([
    workingPlutoOpenOrderRows(connection).whereRaw("orq.payload->>'symbol' = any(?)", [tickers.map((ticker) => ticker.symbol)]).count({ count: "*" }).first(),
    plutoOrdersSentToday(now, null, connection),
    connection("positions").whereIn("ticker_id", tickers.map((ticker) => ticker.tickerId)).where({ status: "open" }).count({ count: "*" }).first(),
  ]);
  return { workingOrders: Number(working?.count ?? 0), ordersToday: Number(ordersToday?.count ?? 0), openPositions: Number(openPositions?.count ?? 0) };
}
