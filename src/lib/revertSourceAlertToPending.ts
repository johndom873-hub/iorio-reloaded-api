import { db } from "../db/connection.js";

// Bug found 2026-08-27: confirming an order tied to a trade alert flips
// trade_alerts.status to "approved" (positions.ts's /orders/:id/confirm),
// but nothing ever reverted that if the order was then cancelled/rejected
// without ever filling — the alert stayed permanently "approved" (not
// "pending"), so re-approving the same alert (e.g. to resubmit with a
// different quantity) failed with "Pending trade alert not found." Called
// from both the local-cancel path (positions.ts, order never reached IBKR)
// and the worker's orderStatus listener (ibkrGatewayWorker.ts, order was
// cancelled/rejected/errored at IBKR) — the two places an order can reach a
// terminal non-fill state.
export async function revertSourceAlertToPending(sourceAlertId: string | null | undefined): Promise<void> {
  if (!sourceAlertId) return;
  await db("trade_alerts")
    .where({ id: sourceAlertId, status: "approved" })
    .update({ status: "pending", resulting_position_id: null, reviewed_by_user_id: null, reviewed_at: null });
}
