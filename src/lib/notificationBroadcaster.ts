import { Client as PgClient } from "pg";
import { environment } from "../config/env.js";
import { appNotificationsChannel, type AppNotification } from "./notificationChannel.js";

// Web-dyno-only: holds one dedicated Postgres LISTEN connection (knex's
// pooled connections aren't suited to a long-lived LISTEN — same reasoning
// as ibkrGatewayWorker.ts's own PgClient for order_requests_channel) and
// fans out every notification it receives to every currently-connected
// browser tab's SSE stream (routes/notifications.ts). Works whether the
// NOTIFY came from this same process (positions.ts on confirm/cancel) or
// from the separate worker process on the VPS (order fills, position
// closes) — Postgres NOTIFY doesn't care which session sent it, only that
// something is LISTENing.
type Subscriber = (notification: AppNotification) => void;

const subscribers = new Set<Subscriber>();
const reconnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000];

export function subscribeToNotifications(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

async function connect(attempt = 0): Promise<void> {
  const client = new PgClient({
    connectionString: environment.databaseUrl,
    ssl: environment.nodeEnvironment === "production" ? { rejectUnauthorized: false } : undefined,
  });

  client.on("notification", (message) => {
    if (message.channel !== appNotificationsChannel || !message.payload) return;
    let notification: AppNotification;
    try {
      notification = JSON.parse(message.payload);
    } catch {
      return;
    }
    subscribers.forEach((subscriber) => subscriber(notification));
  });

  client.on("error", (error) => {
    console.error(`notificationBroadcaster: LISTEN connection error: ${error.message}`);
    client.end().catch(() => {});
    scheduleReconnect(attempt);
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${appNotificationsChannel}`);
    console.log("notificationBroadcaster: listening for app notifications.");
  } catch (error) {
    console.error(`notificationBroadcaster: failed to connect: ${error instanceof Error ? error.message : error}`);
    scheduleReconnect(attempt);
  }
}

function scheduleReconnect(attempt: number): void {
  const delay = reconnectDelaysMs[Math.min(attempt, reconnectDelaysMs.length - 1)]!;
  setTimeout(() => connect(attempt + 1), delay);
}

export function startNotificationBroadcaster(): void {
  connect().catch((error) => console.error(`notificationBroadcaster: initial connect failed: ${error}`));
}
