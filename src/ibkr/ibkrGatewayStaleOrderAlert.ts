import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "./ibkrGatewayOrderPayload.js";

// A row sitting in "confirmed"/"cancel_requested" this long without the
// worker picking it up is never normal (processing is near-instant once
// connected) -- treated as an incident, not a queue backlog. Chosen to be
// comfortably longer than the 30s poll fallback plus a few IBKR reconnect
// cycles, so a routine reconnect blip doesn't false-alarm.
export const staleOrderAlertThresholdMs = 5 * 60_000;

export interface StaleOrderAlertDependencies {
  notify(message: string): Promise<void>;
  now(): Date;
}

/**
 * Staleness runs from updated_at, the moment the row entered its current status. created_at would count the time an
 * order spent resting at IBKR, so every cancel of an order older than the threshold alerted for the second it was
 * cancel_requested.
 */
export async function alertOnStaleOrderRequests(dependencies: StaleOrderAlertDependencies): Promise<void> {
  const nowMs = dependencies.now().getTime();
  const thresholdCutoff = new Date(nowMs - staleOrderAlertThresholdMs);

  const newlyStale = await db("order_requests")
    .whereIn("status", ["confirmed", "cancel_requested"])
    .andWhere("updated_at", "<", thresholdCutoff)
    .whereNull("stale_alert_sent_at")
    .select("id", "status", "updated_at", "payload");
  for (const row of newlyStale) {
    const symbol = (row.payload as OrderRequestPayload | null)?.symbol ?? "unknown symbol";
    const stuckMinutes = Math.round((nowMs - new Date(row.updated_at).getTime()) / 60_000);
    await db("order_requests").where({ id: row.id }).update({ stale_alert_sent_at: db.fn.now() });
    await dependencies.notify(
      `⚠️ Order request stuck: ${symbol} (${row.status}) has not been picked up by the worker for ${stuckMinutes}+ minute(s) (id ${row.id}). Check the iorio-worker service on the VPS.`,
    );
  }

  const nowResolved = await db("order_requests")
    .whereNotIn("status", ["confirmed", "cancel_requested"])
    .whereNotNull("stale_alert_sent_at")
    .select("id", "status", "payload");
  for (const row of nowResolved) {
    const symbol = (row.payload as OrderRequestPayload | null)?.symbol ?? "unknown symbol";
    await db("order_requests").where({ id: row.id }).update({ stale_alert_sent_at: null });
    await dependencies.notify(`✅ Previously stuck order request resolved: ${symbol} is now "${row.status}" (id ${row.id}).`);
  }
}
