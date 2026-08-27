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
  | { type: "position_closed"; positionId: string; symbol: string; message: string };

export async function publishNotification(notification: AppNotification): Promise<void> {
  await db.raw("SELECT pg_notify(?, ?)", [appNotificationsChannel, JSON.stringify(notification)]);
}
