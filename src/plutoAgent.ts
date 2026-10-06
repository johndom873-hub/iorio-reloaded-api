import "dotenv/config";
import { installCrashHandlers } from "./lib/installCrashHandlers.js";
import { db } from "./db/connection.js";
import { PlutoAgent } from "./pluto/agent.js";
import { decidePlutoStart } from "./pluto/config.js";
import { configureMarketDataPoolReservation } from "./ibkr/marketDataPool.js";
import { plutoLineHolder } from "./pluto/marketWatch.js";

// Pluto's process entry (Procfile `agent`). The existence layer decides whether this process
// does anything at all; when it declines, the process exits cleanly so a scaled-up dyno in the
// wrong environment sits idle instead of crash-looping.

installCrashHandlers("pluto_agent");

const decision = decidePlutoStart();
if (!decision.start) {
  console.log(`Pluto agent not starting: ${decision.reason}.`);
  await db.destroy();
  process.exit(0);
}

// Pluto's quote pool books its own priority row in the line ledger, never the web dyno's.
configureMarketDataPoolReservation({ holder: plutoLineHolder, priority: true });

const agent = new PlutoAgent(decision.config);
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Pluto agent received ${signal} — stopping.`);
  await agent.stop();
  await db.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await agent.start();
