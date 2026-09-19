import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { subscribeToNotifications } from "../lib/notificationBroadcaster.js";
import { publishNotification, fetchRecentNotificationEvents } from "../lib/notificationChannel.js";
import * as presenceTracker from "../lib/presenceTracker.js";
import { recordUserLastSeen } from "../lib/userLastSeen.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const heartbeatIntervalMs = 20_000;
const recentEventsLimit = 30;

// Backs the Pulse dashboard's Latest Events panel on load — the SSE stream
// below only ever carries events from the moment a tab connects, so without
// this the panel is always empty on a fresh page load.
notificationsRouter.get("/recent", async (_request, response) => {
  const events = await fetchRecentNotificationEvents(recentEventsLimit);
  response.json({ events });
});

// Long-lived SSE stream, one per open browser tab — stays open for the
// lifetime of the tab (BackgroundJobsContext opens it once at app mount),
// forwarding whatever notificationBroadcaster receives from Postgres NOTIFY.
// Replaces the old client-side 2s order-status poll (see
// BackgroundJobsContext.tsx) and is also how a position close or an
// order placed outside this browser (e.g. via Genosuke chat) reaches the
// toast stack — the old polling only ever tracked orders this browser
// itself started.
notificationsRouter.get("/stream", (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  // Pulse frames (topology animation only, see pulseEmitter.ts) are frequent,
  // so only the Pulse page's own stream asks for them (?pulses=1) — every
  // other tab would just wake up for nothing.
  const wantsPulses = request.query.pulses === "1";
  const unsubscribe = subscribeToNotifications((notification) => {
    if (response.writableEnded) return;
    if (notification.type === "pulse" && !wantsPulses) return;
    response.write(`data: ${JSON.stringify(notification)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, heartbeatIntervalMs);

  // Presence for Iorio Pulse's Front End node (see presenceTracker.ts) —
  // this stream is the natural connect/disconnect hook since every
  // authenticated page already opens it. Non-null assertion: requireAuth
  // (line 8) already rejects the request with 401 before this handler runs
  // if session.userId isn't set — express-session's own types make every
  // SessionData field optional (Partial<SessionData>) regardless of the
  // module augmentation in session.ts, which TS can't narrow across a
  // separate middleware function.
  const userId = request.session.userId!;
  const onlineAfterConnect = presenceTracker.connect(userId);
  // Stamp before publishing so the dashboards' refetch on the presence frame
  // already sees the new last_seen_at.
  recordUserLastSeen(userId)
    .catch((error) => console.error("recordUserLastSeen (connect) failed:", error))
    .then(() => publishNotification({ type: "presence", onlineUserIds: onlineAfterConnect }))
    .catch(() => {});

  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    const onlineAfterDisconnect = presenceTracker.disconnect(userId);
    recordUserLastSeen(userId)
      .catch((error) => console.error("recordUserLastSeen (disconnect) failed:", error))
      .then(() => publishNotification({ type: "presence", onlineUserIds: onlineAfterDisconnect }))
      .catch(() => {});
  });
});
