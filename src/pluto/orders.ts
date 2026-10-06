import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { activeOrderRequestStatuses } from "../lib/orderRequestStatuses.js";
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
    .whereIn("status", activeOrderRequestStatuses)
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

/** Pluto's orders IBKR may still be working (or that are still on their way there), newest first, for the status card. */
export interface PlutoWorkingOrder {
  actionId: string;
  orderRequestId: string;
  symbol: string;
  kind: string;
  contract: Record<string, unknown> | null;
  quantity: number | null;
  limitPrice: number | null;
  status: string;
  createdAt: string;
}

export async function loadPlutoWorkingOrders(connection: Knex = db): Promise<PlutoWorkingOrder[]> {
  const rows: { action_id: string; order_request_id: string; symbol: string; kind: string; contract: Record<string, unknown> | null; quantity: number | null; limit_price: string | null; status: string; created_at: Date }[] = await connection("order_requests as orq")
    .join("pluto_actions as pa", "pa.id", "orq.pluto_action_id")
    .whereIn("orq.status", activeOrderRequestStatuses)
    .orderBy("orq.created_at", "desc")
    .select("pa.id as action_id", "orq.id as order_request_id", "pa.symbol", "pa.kind", "pa.contract", "pa.quantity", "pa.limit_price", "orq.status", "orq.created_at");
  return rows.map((row) => ({
    actionId: row.action_id,
    orderRequestId: row.order_request_id,
    symbol: row.symbol,
    kind: row.kind,
    contract: row.contract ?? null,
    quantity: row.quantity === null ? null : Number(row.quantity),
    limitPrice: row.limit_price === null ? null : Number(row.limit_price),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
