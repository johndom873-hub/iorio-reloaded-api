import { db } from "../db/connection.js";

// Shared Postgres NOTIFY channel carrying real-time app events (order status
// changes, position closes) from whichever process caused them — the web
// dyno (order confirm/cancel) or the worker (IBKR-reported fills/expiries) —
// to the web dyno's SSE broadcaster (notificationBroadcaster.ts), which fans
// them out to every connected browser tab. Both processes only ever need
// the channel name to call pg_notify; only the web dyno actually LISTENs.
export const appNotificationsChannel = "app_notifications_channel";

export type AppNotification =
  | { type: "order_status"; orderId: string }
  | { type: "position_closed"; positionId: string; symbol: string; message: string }
  | { type: "position_opened"; positionId: string; symbol: string }
  // Iorio Pulse's live System Events feed / topology pulses — see
  // presenceTracker.ts (presence) and the publish call sites in runJob.ts,
  // runTradeAlertGeneration.ts, and genosuke/bot.ts.
  | { type: "job_completed"; jobName: string; status: "success" | "failure" }
  | { type: "alert_generated"; strategyKey: string; symbol: string; annualizedYield: number }
  | { type: "genosuke_reply"; preview: string }
  | { type: "presence"; onlineUserIds: string[] };

// Kept small — the Pulse dashboard's Latest Events panel only ever shows the
// most recent EVENTS_LIMIT (30) on load; no need to retain history beyond a
// comfortable buffer for that.
const notificationEventsRetentionCount = 200;

export async function publishNotification(notification: AppNotification): Promise<void> {
  await db.raw("SELECT pg_notify(?, ?)", [appNotificationsChannel, JSON.stringify(notification)]);

  // "presence" is online/offline state, not a loggable event — Latest Events
  // has nothing to show for it.
  if (notification.type === "presence") return;

  // ibkr_health_check runs every ~10 minutes and is never shown in Latest
  // Events (fetchRecentNotificationEvents filters it out, and so does the
  // live SSE handler in PulsePage.tsx). Skipping persistence — not just
  // display — means a long quiet stretch (e.g. a holiday weekend) can't let
  // the retention cleanup below evict real history in favor of noise.
  if (notification.type === "job_completed" && notification.jobName === "ibkr_health_check") return;

  await db("notification_events").insert({ payload: JSON.stringify(notification) });
  await db.raw(
    `DELETE FROM notification_events WHERE id NOT IN (
       SELECT id FROM notification_events ORDER BY occurred_at DESC LIMIT ?
     )`,
    [notificationEventsRetentionCount],
  );
}

export async function fetchRecentNotificationEvents(
  limit: number,
): Promise<Array<{ notification: AppNotification; occurredAt: string }>> {
  // ibkr_health_check runs every ~10 minutes and is excluded from the Pulse
  // dashboard's Latest Events panel (see PulsePage.tsx's fetchDescribedEvents
  // and its live SSE handler) — filtering it out here, before LIMIT, keeps
  // any quiet stretch of health-check-only activity from crowding out real
  // events that are still within the retention window.
  const rows = await db("notification_events")
    .select("payload", "occurred_at")
    .whereRaw(`NOT (payload->>'type' = ? AND payload->>'jobName' = ?)`, ["job_completed", "ibkr_health_check"])
    .orderBy("occurred_at", "desc")
    .limit(limit);
  return rows.map((row) => ({ notification: row.payload as AppNotification, occurredAt: row.occurred_at.toISOString() }));
}
