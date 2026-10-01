import "./lib/installWebCrashAlert.js";
import { app } from "./app.js";
import { environment, ibkrMarketDataLinesEnabled, requireEnvironmentVariable } from "./config/env.js";
import { startStalePendingOrderSweep } from "./lib/stalePendingOrders.js";
import { startGenosuke } from "./genosuke/bot.js";
import { sharedLiveConnection, sharedReadConnection } from "./ibkr/sharedReadConnection.js";
import { installShutdownHandler } from "./lib/installShutdownHandler.js";
import { startNotificationBroadcaster } from "./lib/notificationBroadcaster.js";
import { startDaySignalsLoop } from "./lib/daySignalsLoop.js";
import { startOpsMonitor } from "./lib/opsMonitor.js";
import { announceWebDynoStart } from "./lib/webDynoStartNotice.js";
import { readAppEnvironment } from "./lib/appEnvironment.js";

installShutdownHandler("web");

// Only the web dyno gets a $PORT from Heroku — read lazily here rather than
// eagerly in the shared `environment` object, so the worker dyno (which
// imports environment.ts for IBKR config but never binds a port) doesn't
// crash on a missing PORT.
const port = Number(requireEnvironmentVariable("PORT"));

// Explicit on/off, never defaulted: local dev and staging share one IBKR
// login but not a line-reservation table, so an always-on loop would cost
// 10 market-data lines per running environment (see daySignalsLoop.ts).
const daySignalsLoopFlag = requireEnvironmentVariable("DAY_SIGNALS_LOOP_ENABLED");
if (daySignalsLoopFlag !== "true" && daySignalsLoopFlag !== "false") {
  throw new Error(`DAY_SIGNALS_LOOP_ENABLED must be "true" or "false", got: ${daySignalsLoopFlag}`);
}

// Validated at boot so a deploy without it fails here, not silently at the
// first reservation — see ibkrMarketDataLinesEnabled() in config/env.ts.
const marketDataLinesEnabled = ibkrMarketDataLinesEnabled();
if (!marketDataLinesEnabled) console.log("IBKR market-data lines disabled in this environment (IBKR_MARKET_DATA_LINES_ENABLED=false): live quotes, option chains and the Day Signals loop will not open lines.");

app.listen(port, () => {
  console.log(`Iorio Reloaded API listening on port ${port} (${readAppEnvironment()})`);
  // A killed process (out of memory, a Heroku platform restart) can never send its own alert, so every
  // start announces itself: an unexpected restart or a crash loop shows up as repeated messages.
  Promise.resolve()
    .then(() => {
      // A start notice must not be lost because the environment label is unreadable: say so in the message instead.
      let environmentLabel: string;
      try {
        environmentLabel = readAppEnvironment();
      } catch (error) {
        environmentLabel = `environment unreadable: ${error instanceof Error ? error.message : error}`;
      }
      return announceWebDynoStart({ subject: "API", environmentLabel });
    })
    .catch((error) => console.error(`Could not send the start notice: ${error instanceof Error ? error.message : error}`));
  startNotificationBroadcaster();
  startStalePendingOrderSweep();
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
  startOpsMonitor();
  if (daySignalsLoopFlag === "true") startDaySignalsLoop();
  else console.log("Day Signals loop disabled (DAY_SIGNALS_LOOP_ENABLED=false).");
});
