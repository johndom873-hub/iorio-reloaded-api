import { db } from "../db/connection.js";
import { loadOrderUnfilledCancelMinutes } from "../lib/tradingSettingsStore.js";

// Runs on the VPS worker: orders that have rested unfilled at IBKR longer than the Risk & Limits limit are put into
// cancel_requested, which the worker's normal cancel path then sends to IBKR (Marcelo 2026-10-05). They were sent as DAY
// orders, so without this a mid limit would sit until the close, and fill when the price had moved against it.

const workingStatuses = ["submitted", "partially_filled"];

export interface UnfilledOrderSweepDependencies {
  loadMinutes(): Promise<number>;
  now(): Date;
}

/** Ids of the orders just moved to cancel_requested (reason not_filled_in_time); empty when the limit is 0 (never). */
export async function requestCancelOfUnfilledOrders(
  dependencies: UnfilledOrderSweepDependencies = { loadMinutes: loadOrderUnfilledCancelMinutes, now: () => new Date() },
): Promise<string[]> {
  const minutes = await dependencies.loadMinutes();
  if (!(minutes > 0)) return [];
  const cutoff = new Date(dependencies.now().getTime() - minutes * 60_000);
  // One conditional UPDATE: an order that filled a moment ago no longer matches, so it is never asked to cancel.
  const rows: { id: string }[] = await db("order_requests")
    .whereIn("status", workingStatuses)
    .whereNotNull("ibkr_order_id")
    .whereNotNull("placed_at")
    .where("placed_at", "<", cutoff)
    .update({ status: "cancel_requested", cancellation_reason: "not_filled_in_time", updated_at: db.fn.now() })
    .returning(["id"]);
  return rows.map((row) => row.id);
}
