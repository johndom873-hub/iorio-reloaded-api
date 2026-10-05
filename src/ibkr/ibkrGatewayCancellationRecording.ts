import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";
import { cancellationReasonForIbkrCancel, ibkrCancelReasonText, ibkrOrderCanceledErrorCode } from "./ibkrGatewayOrderStatus.js";

// Runs on the VPS worker: recording an order IBKR ended as cancelled, with why (order_requests.cancellation_reason).

export const workingOrderRequestStatuses = ["submitted", "partially_filled", "cancel_requested"];

export type ExecutedOutcome = "filled" | "partially_filled" | "none";

/** For a row IBKR just ended as cancelled: why, unless a user asked for the cancel (cancelled_by_user_id says so already). */
export async function recordIbkrCancellationReason(orderRequestId: string, connection: Knex = db, now: Date = new Date()): Promise<void> {
  const row: { created_at: Date; cancelled_by_user_id: string | null; cancellation_reason: string | null } | undefined = await connection("order_requests").where({ id: orderRequestId }).first("created_at", "cancelled_by_user_id", "cancellation_reason");
  // A reason already set (the unfilled-order sweep's) is the real one; the clock-based guess must not replace it.
  if (!row || row.cancelled_by_user_id || row.cancellation_reason) return;
  await connection("order_requests").where({ id: orderRequestId }).update({ cancellation_reason: cancellationReasonForIbkrCancel(new Date(row.created_at), now) });
}

export interface IbkrOrderCanceledDependencies {
  executedOutcome(orderRequestId: string, payload: OrderRequestPayload): Promise<ExecutedOutcome>;
  notify(orderRequestId: string): Promise<void>;
  now?(): Date;
}

// IBKR announces a cancel twice: orderStatus "Cancelled" and error 202 "Order Canceled - reason:<text>". Either one ends
// the row as cancelled (or cancelled after partly filling); the other then finds it final and changes nothing.
export async function recordIbkrOrderCanceled(ibkrOrderId: number, message: string, dependencies: IbkrOrderCanceledDependencies): Promise<void> {
  const rows: { id: string; status: string; payload: OrderRequestPayload }[] = await db("order_requests")
    .where({ ibkr_order_id: ibkrOrderId })
    .whereIn("status", workingOrderRequestStatuses)
    .select("id", "status", "payload");
  const ibkrReason = ibkrCancelReasonText(message);
  for (const row of rows) {
    const executed = await dependencies.executedOutcome(row.id, row.payload);
    if (executed === "filled") continue;
    const status = executed === "partially_filled" || row.status === "partially_filled" ? "cancelled_partially_filled" : "cancelled";
    const ended = await db.transaction(async (transaction) => {
      const endedRows = await transaction("order_requests")
        .where({ id: row.id })
        .whereIn("status", workingOrderRequestStatuses)
        .update({ status, updated_at: db.fn.now(), ...(ibkrReason ? { error_message: `IBKR: ${ibkrReason}` } : {}) })
        .returning("id");
      if (endedRows.length > 0) await recordIbkrCancellationReason(row.id, transaction, dependencies.now?.() ?? new Date());
      return endedRows.length > 0;
    });
    if (!ended) continue;
    console.log(`Order ${ibkrOrderId} cancelled by IBKR (error ${ibkrOrderCanceledErrorCode}): row ${row.id} -> ${status}.`);
    await dependencies.notify(row.id);
  }
}
