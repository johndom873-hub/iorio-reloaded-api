import { db } from "../db/connection.js";
import { publishNotification } from "../lib/notificationChannel.js";

// Pluto's own orders are the order_requests rows carrying pluto_action_id. Pause always
// drops the ones that never reached IBKR; "Pause and cancel working orders" also asks the
// worker to cancel the ones IBKR is working — the same transitions POST /positions/orders/:id/cancel
// makes, so the worker and the screens see nothing new.

const orderRequestsChannel = "order_requests_channel";

export interface CancelPlutoOrdersResult {
  cancelledLocally: string[];
  cancelRequested: string[];
}

export async function cancelPlutoOrders(userId: string | null, options: { includeWorking: boolean }): Promise<CancelPlutoOrdersResult> {
  const cancelledLocally: string[] = [];
  const cancelRequested: string[] = [];
  await db.transaction(async (trx) => {
    const local = await trx("order_requests")
      .whereNotNull("pluto_action_id")
      .whereIn("status", ["pending_confirmation", "confirmed"])
      .update({ status: "cancelled", cancelled_by_user_id: userId, updated_at: trx.fn.now() })
      .returning(["id"]);
    cancelledLocally.push(...local.map((row) => row.id as string));

    if (options.includeWorking) {
      const working = await trx("order_requests")
        .whereNotNull("pluto_action_id")
        .whereIn("status", ["submitted", "partially_filled"])
        .update({ status: "cancel_requested", cancelled_by_user_id: userId, updated_at: trx.fn.now() })
        .returning(["id"]);
      cancelRequested.push(...working.map((row) => row.id as string));
      for (const id of cancelRequested) await trx.raw("SELECT pg_notify(?, ?)", [orderRequestsChannel, id]);
    }
  });
  for (const id of [...cancelledLocally, ...cancelRequested]) await publishNotification({ type: "order_status", orderId: id });
  if (cancelledLocally.length > 0) {
    await db("pluto_actions").whereIn("order_request_id", cancelledLocally).update({ outcome: "cancelled", updated_at: db.fn.now() });
  }
  return { cancelledLocally, cancelRequested };
}

/** Pluto orders IBKR may still be working (for the screen and for the pause confirm text). */
export async function countPlutoWorkingOrders(): Promise<{ pending: number; working: number }> {
  const rows: { status: string; count: string }[] = await db("order_requests")
    .whereNotNull("pluto_action_id")
    .whereIn("status", ["pending_confirmation", "confirmed", "submitted", "partially_filled", "cancel_requested"])
    .groupBy("status")
    .select("status")
    .count("* as count");
  let pending = 0;
  let working = 0;
  for (const row of rows) {
    if (row.status === "pending_confirmation" || row.status === "confirmed") pending += Number(row.count);
    else working += Number(row.count);
  }
  return { pending, working };
}
