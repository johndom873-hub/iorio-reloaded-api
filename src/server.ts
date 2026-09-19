import { app } from "./app.js";
import { environment, requireEnvironmentVariable } from "./config/env.js";
import { startGenosuke } from "./genosuke/bot.js";
import { sharedLiveConnection, sharedReadConnection } from "./ibkr/sharedReadConnection.js";
import { installCrashHandlers } from "./lib/installCrashHandlers.js";
import { installShutdownHandler } from "./lib/installShutdownHandler.js";
import { startNotificationBroadcaster } from "./lib/notificationBroadcaster.js";

installCrashHandlers("web");
installShutdownHandler("web");

// Only the web dyno gets a $PORT from Heroku — read lazily here rather than
// eagerly in the shared `environment` object, so the worker dyno (which
// imports environment.ts for IBKR config but never binds a port) doesn't
// crash on a missing PORT.
const port = Number(requireEnvironmentVariable("PORT"));

app.listen(port, () => {
  console.log(`Iorio Reloaded API listening on port ${port} (${environment.nodeEnvironment})`);
  startNotificationBroadcaster();
  // Open the shared IBKR read and live connections now (2026-09-19) rather than on the
  // first request after a deploy/restart, which otherwise pays the full
  // ~5s tunnel + handshake itself. borrow() starts the connect and keeps it
  // going even if this call gives up waiting; callers still fall back to
  // one-shot connections if it isn't ready.
  for (const [label, connection] of [
    ["read", sharedReadConnection],
    ["live", sharedLiveConnection],
  ] as const) {
    connection.borrow().catch((error) => {
      console.log(`Startup warm-up of the shared IBKR ${label} connection is still pending (${error instanceof Error ? error.message : error}).`);
    });
  }
  // No-ops until GENOSUKE_ENABLED + the rest of its config is set —
  // see genosuke/config.ts. Fire-and-forget, started after listen() so the
  // self-authenticating API client (genosuke/apiClient.ts) has a live
  // server to call.
  startGenosuke();
});
