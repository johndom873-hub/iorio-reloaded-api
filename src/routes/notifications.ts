import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { subscribeToNotifications } from "../lib/notificationBroadcaster.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const heartbeatIntervalMs = 20_000;

// Long-lived SSE stream, one per open browser tab — stays open for the
// lifetime of the tab (BackgroundJobsContext opens it once at app mount),
// forwarding whatever notificationBroadcaster receives from Postgres NOTIFY.
// Replaces the old client-side 2s order-status poll (see
// BackgroundJobsContext.tsx) and is also how a position close or an
// order placed outside this browser (e.g. via Genosuke chat) reaches the
// toast stack — the old polling only ever tracked orders this browser
// itself started.
notificationsRouter.get("/stream", (_request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const unsubscribe = subscribeToNotifications((notification) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(notification)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, heartbeatIntervalMs);

  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
