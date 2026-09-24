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
  | { type: "job_started"; jobName: string }
  | { type: "job_completed"; jobName: string; status: "success" | "failure" }
  | { type: "alert_generated"; strategyKey: string; symbol: string; annualizedYield: number }
  // Day Signals: a pooled contract's grade went up between two refresh cycles (daySignalsNotifications.ts).
  | { type: "signal_upgraded"; symbol: string; strategyKey: string; strike: number; expiry: string; dte: number; previousGrade: string; grade: string; netEdge: number; edgeDollars: number; annualizedYield: number }
  // Roll Signals: a (held leg, replacement) roll's grade went up between two refresh cycles.
  | { type: "roll_signal_upgraded"; symbol: string; strategyKey: string; legId: string; heldStrike: number; heldExpiry: string; strike: number; expiry: string; dte: number; previousGrade: string; grade: string; netRollEdge: number; netRollEdgeDollars: number; netCreditPerShare: number }
  | { type: "genosuke_reply"; preview: string }
  | { type: "presence"; onlineUserIds: string[] }
  // Animation-only signal for the Pulse topology map's otherwise-silent lines
  // (see pulseEmitter.ts / publishPulse below) — never persisted, never shown
  // in Latest Events.
  | { type: "pulse"; edgeId: PulseEdgeId };

export type PulseEdgeId = "ibkr-gateway" | "heroku-browser" | "heroku-db" | "genosuke-db" | "genosuke-llm";

// Kept small — the Pulse dashboard's Latest Events panel only ever shows the
// most recent EVENTS_LIMIT (30) on load; no need to retain history beyond a
// comfortable buffer for that.
const notificationEventsRetentionCount = 200;

export async function publishNotification(notification: AppNotification): Promise<void> {
  await db.raw("SELECT pg_notify(?, ?)", [appNotificationsChannel, JSON.stringify(notification)]);

  // "presence" is online/offline state, not a loggable event — Latest Events
  // has nothing to show for it.
  if (notification.type === "presence" || notification.type === "pulse") return;

  // ibkr_health_check runs every ~10 minutes and is never shown in Latest
  // Events (fetchRecentNotificationEvents filters it out, and so does the
  // live SSE handler in PulsePage.tsx). Skipping persistence — not just
  // display — means a long quiet stretch (e.g. a holiday weekend) can't let
  // the retention cleanup below evict real history in favor of noise.
  if ((notification.type === "job_started" || notification.type === "job_completed") && notification.jobName === "ibkr_health_check") return;

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
    .whereRaw(`NOT (payload->>'type' IN (?, ?) AND payload->>'jobName' = ?)`, ["job_started", "job_completed", "ibkr_health_check"])
    .orderBy("occurred_at", "desc")
    .limit(limit);
  return rows.map((row) => ({ notification: row.payload as AppNotification, occurredAt: row.occurred_at.toISOString() }));
}

const minimumPublishIntervalMs = 500;
const lastPulsePublishedAtByEdge = new Map<PulseEdgeId, number>();

/**
 * Cross-process pulse for an edge whose activity happens outside the web dyno
 * (the VPS worker's IBKR traffic). Goes over the same NOTIFY channel as every
 * other notification but skips persistence, and is throttled per edge so a
 * burst of IBKR callbacks doesn't flood every open Pulse tab. Web-dyno-side
 * edges use pulseEmitter.ts's in-process emitPulse instead, which needs no
 * database round trip (and so can't itself trigger the heroku-db pulse).
 */
export async function publishPulse(edgeId: PulseEdgeId): Promise<void> {
  const now = Date.now();
  if (now - (lastPulsePublishedAtByEdge.get(edgeId) ?? 0) < minimumPublishIntervalMs) return;
  lastPulsePublishedAtByEdge.set(edgeId, now);
  await publishNotification({ type: "pulse", edgeId });
}

export interface RecentNotificationEventWithOrder {
  notification: AppNotification;
  occurredAt: string;
  /** Only on order_status events: the order's current status and payload (null if the order no longer exists). */
  order?: { status: string; payload: unknown } | null;
}

/**
 * Same as fetchRecentNotificationEvents, but every order_status event also
 * carries its order's status and payload, looked up in ONE query. Latest
 * Events used to fetch each order separately from the browser — 18 parallel
 * authenticated requests per Pulse load that exhausted Postgres connections
 * (2026-09-19).
 */
export async function fetchRecentNotificationEventsWithOrders(limit: number): Promise<RecentNotificationEventWithOrder[]> {
  const events = await fetchRecentNotificationEvents(limit);
  const orderIds = [...new Set(events.flatMap((event) => (event.notification.type === "order_status" ? [event.notification.orderId] : [])))];
  if (orderIds.length === 0) return events;

  const orderRows: { id: string; status: string; payload: unknown }[] = await db("order_requests").whereIn("id", orderIds).select("id", "status", "payload");
  const orderById = new Map(orderRows.map((row) => [row.id, { status: row.status, payload: row.payload }]));
  return events.map((event) =>
    event.notification.type === "order_status" ? { ...event, order: orderById.get(event.notification.orderId) ?? null } : event,
  );
}
