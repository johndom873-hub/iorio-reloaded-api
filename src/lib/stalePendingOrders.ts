import { db } from "../db/connection.js";
import { pendingConfirmationMaxAgeMs } from "../routes/positions.js";
import { publishNotification } from "./notificationChannel.js";

// Built-but-never-confirmed orders (a review panel closed without Cancel, an
// assistant confirm that failed) used to sit in pending_confirmation forever
// and could be confirmed days later at a stale limit price. Approved
// 2026-09-24: panels cancel on close, confirm refuses past
// pendingConfirmationMaxAgeMs, and this sweep cancels whatever is left.
export const stalePendingOrderSweepIntervalMs = 60_000;

export async function cancelStalePendingConfirmations(): Promise<number> {
  const cutoff = new Date(Date.now() - pendingConfirmationMaxAgeMs);
  const rows: { id: string; source_alert_id: string | null }[] = await db("order_requests")
    .where({ status: "pending_confirmation" })
    .where("created_at", "<", cutoff)
    .update({ status: "cancelled", error_message: "Not confirmed within 15 minutes — cancelled automatically (limit prices would be stale).", updated_at: db.fn.now() })
    .returning(["id", "source_alert_id"]);
  for (const row of rows) {
    if (row.source_alert_id) {
      await db("trade_alerts").where({ id: row.source_alert_id, status: "approved" }).update({ status: "pending", reviewed_by_user_id: null, reviewed_at: null });
    }
    await publishNotification({ type: "order_status", orderId: row.id }).catch(() => {});
  }
  return rows.length;
}

export function startStalePendingOrderSweep(): void {
  const timer = setInterval(() => {
    cancelStalePendingConfirmations().catch((error) => console.warn(`stale pending-order sweep failed: ${error instanceof Error ? error.message : error}`));
  }, stalePendingOrderSweepIntervalMs);
  timer.unref?.();
}
