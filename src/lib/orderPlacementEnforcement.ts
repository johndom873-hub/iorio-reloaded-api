import { db } from "../db/connection.js";
import { publishNotification } from "./notificationChannel.js";
import { findOrderPlacementBlockReason, type StoredGateEvaluation } from "./orderPlacementGuard.js";
import { fetchTradingHalt } from "./platformControls.js";

export interface PlacementBlock {
  reason: string;
  /** False when the row was no longer `confirmed` by the time it was ended (a cancel landed first), so it keeps its own status. */
  ended: boolean;
}

/**
 * The worker's pre-placement check, with its effect: judges a confirmed order (orderPlacementGuard.ts) and, when it must not be
 * placed, ends it as an error for good. Null means the order may be placed. Fail closed: a failed halt read blocks the order.
 */
export async function endOrderIfPlacementBlocked(orderRequest: { id: string; gate_evaluation: StoredGateEvaluation | null }): Promise<PlacementBlock | null> {
  let reason: string | null;
  try {
    reason = findOrderPlacementBlockReason({ gateEvaluation: orderRequest.gate_evaluation, halt: await fetchTradingHalt() });
  } catch (error) {
    reason = `Could not read the trading-halt switch (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!reason) return null;

  // Conditioned on still being confirmed, like the worker's placement claim: a cancel that just landed keeps its own status.
  const endedRows = await db("order_requests")
    .where({ id: orderRequest.id, status: "confirmed" })
    .update({ status: "error", error_message: reason, updated_at: db.fn.now() })
    .returning("id");
  const ended = endedRows.length > 0;
  if (ended) await publishNotification({ type: "order_status", orderId: orderRequest.id }).catch(() => {});
  return { reason, ended };
}
