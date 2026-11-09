import { db } from "../db/connection.js";
import { loadOrderUnfilledCancelMinutes } from "../lib/tradingSettingsStore.js";

// Runs on the VPS worker: orders that have rested unfilled at IBKR longer than the Risk & Limits limit are put into
// cancel_requested, which the worker's normal cancel path then sends to IBKR (Marcelo 2026-10-05). They were sent as DAY
// orders, so without this a mid limit would sit until the close, and fill when the price had moved against it.
// Pluto's in-the-money Call buybacks are left alone (Marcelo 2026-11-09): sent in the window's last minutes, a cancel 15
// minutes later would leave the Call to be assigned with half an hour of trading still to go; Pluto's own watch
// cancels them 2 minutes before the close.

const workingStatuses = ["submitted", "partially_filled"];

/** The kind of Pluto action its in-the-money Call buyback records (src/pluto/volFarmerV4Round.ts buyBackCallsInTheMoney). */
export const plutoCallBuyBackActionKind = "close_leg";

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
    .whereNotExists(
      db("pluto_actions as action").whereRaw("action.id = order_requests.pluto_action_id").where("action.kind", plutoCallBuyBackActionKind).whereRaw("action.contract->>'right' = 'C'"),
    )
    .update({ status: "cancel_requested", cancellation_reason: "not_filled_in_time", updated_at: db.fn.now() })
    .returning(["id"]);
  return rows.map((row) => row.id);
}
