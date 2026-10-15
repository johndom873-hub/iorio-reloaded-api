import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { publishNotification } from "./notificationChannel.js";

// A frozen ticker (tickers.trading_frozen_at) is not traded by anyone: the order route refuses it, Pluto skips it, and the
// position sync leaves its holdings alone. A detected stock split freezes its ticker until a person has rewritten its records
// to the new basis (split:rewrite) and unfrozen it (ticker:unfreeze); see stockSplits.ts and stockSplitRewrite.ts.

const orderRequestsChannel = "order_requests_channel";

export interface FrozenTicker {
  tickerId: string;
  symbol: string;
  frozenAt: Date;
  reason: string;
}

export async function isTickerFrozen(tickerId: string, connection: Knex = db): Promise<boolean> {
  const row = await connection("tickers").where({ id: tickerId }).whereNotNull("trading_frozen_at").first("id");
  return row !== undefined;
}

export async function loadFrozenTickers(connection: Knex = db): Promise<FrozenTicker[]> {
  const rows: { tickerId: string; symbol: string; frozenAt: Date; reason: string | null }[] = await connection("tickers")
    .whereNotNull("trading_frozen_at")
    .orderBy("symbol")
    .select("id as tickerId", "symbol", "trading_frozen_at as frozenAt", "trading_frozen_reason as reason");
  return rows.map((row) => ({ ...row, reason: row.reason ?? "" }));
}

export async function frozenSymbolSet(connection: Knex = db): Promise<Set<string>> {
  return new Set((await loadFrozenTickers(connection)).map((ticker) => ticker.symbol));
}

/**
 * Freezes the ticker and cancels its orders of every origin: the ones not yet at IBKR are cancelled, the ones IBKR is working
 * are asked to cancel (the same transitions as POST /positions/orders/:id/cancel). A ticker already frozen keeps its first
 * reason. Returns whether this call froze it.
 */
export async function freezeTicker(tickerId: string, reason: string, connection: Knex = db): Promise<boolean> {
  const cancelled: string[] = [];
  const frozeNow = await inTransaction(connection, async (trx) => {
    const frozen = await trx("tickers").where({ id: tickerId }).whereNull("trading_frozen_at").update({ trading_frozen_at: trx.fn.now(), trading_frozen_reason: reason }).returning(["symbol"]);
    const ticker = await trx("tickers").where({ id: tickerId }).first("symbol");
    if (!ticker) return false;
    cancelled.push(...(await cancelOrdersOnSymbol(ticker.symbol, trx)));
    return frozen.length > 0;
  });
  for (const id of cancelled) await publishNotification({ type: "order_status", orderId: id });
  return frozeNow;
}

export async function unfreezeTicker(tickerId: string, connection: Knex = db): Promise<boolean> {
  const updated = await connection("tickers").where({ id: tickerId }).whereNotNull("trading_frozen_at").update({ trading_frozen_at: null, trading_frozen_reason: null }).returning(["id"]);
  return updated.length > 0;
}

/** Cancels every active order on the symbol; returns the order ids whose status changed. */
async function cancelOrdersOnSymbol(symbol: string, trx: Knex.Transaction): Promise<string[]> {
  const local = await trx("order_requests")
    .whereRaw("payload->>'symbol' = ?", [symbol])
    .whereIn("status", ["pending_confirmation", "confirmed"])
    .update({ status: "cancelled", cancellation_reason: "ticker_frozen", updated_at: trx.fn.now() })
    .returning(["id"]);
  const working = await trx("order_requests")
    .whereRaw("payload->>'symbol' = ?", [symbol])
    .whereIn("status", ["submitted", "partially_filled"])
    .update({ status: "cancel_requested", cancellation_reason: "ticker_frozen", updated_at: trx.fn.now() })
    .returning(["id"]);
  const localIds = local.map((row) => row.id as string);
  const workingIds = working.map((row) => row.id as string);
  for (const id of workingIds) await trx.raw("SELECT pg_notify(?, ?)", [orderRequestsChannel, id]);
  if (localIds.length > 0) await trx("pluto_actions").whereIn("order_request_id", localIds).update({ outcome: "cancelled", updated_at: trx.fn.now() });
  return [...localIds, ...workingIds];
}

async function inTransaction<T>(connection: Knex, work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return connection.isTransaction ? work(connection as Knex.Transaction) : connection.transaction(work);
}
