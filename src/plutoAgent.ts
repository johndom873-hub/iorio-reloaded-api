import "dotenv/config";
import { installCrashHandlers } from "./lib/installCrashHandlers.js";
import { db } from "./db/connection.js";
import { notifyPlutoTelegram } from "./lib/notifyTelegram.js";
import { currentRelease, PlutoAgent } from "./pluto/agent.js";
import { agentLeaseRetryIntervalMs, PlutoAgentLease, type AgentLeaseTaken } from "./pluto/agentLease.js";
import { plutoStartMessage, plutoStopMessage, type PlutoStopReason } from "./pluto/agentLifecycleMessages.js";
import { decidePlutoStart } from "./pluto/config.js";
import { recordPlutoEvent } from "./pluto/ledger.js";
import { loadPlutoState } from "./pluto/stateStore.js";
import { configureMarketDataPoolReservation } from "./ibkr/marketDataPool.js";
import { plutoLineHolder } from "./pluto/marketWatch.js";

// Pluto's process entry (Procfile `agent`). The existence layer decides whether this process
// does anything at all; when it declines, the process exits cleanly so a scaled-up dyno in the
// wrong environment sits idle instead of crash-looping. Then only the process holding the agent
// lease (pluto/agentLease.ts) runs the agent: a second one waits until the first has stopped.

installCrashHandlers("pluto_agent");

const decision = decidePlutoStart();
if (!decision.start) {
  console.log(`Pluto agent not starting: ${decision.reason}.`);
  await db.destroy();
  process.exit(0);
}

// Pluto's quote pool books its own priority row in the line ledger, never the web dyno's.
configureMarketDataPoolReservation({ holder: plutoLineHolder, priority: true });

const stopLogText: Record<PlutoStopReason, string> = { sigterm: "received SIGTERM", sigint: "received SIGINT", lease_lost: "lost its lease to another agent" };

const lease = new PlutoAgentLease();
let agent: PlutoAgent | null = null;
let stopping = false;
async function shutdown(reason: PlutoStopReason): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Pluto agent ${stopLogText[reason]} — stopping.`);
  lease.cancelWait();
  // Only an agent that ran says it is stopping: one still waiting for the lease never ran Pluto. Sent alongside the stop, so
  // it goes out even if the stop outlasts Heroku's 30 s before SIGKILL.
  const stopNotice = agent ? notifyPlutoTelegram(plutoStopMessage(reason)).catch(() => false) : null;
  await agent?.stop();
  await stopNotice;
  await lease.release().catch((error) => console.warn(`Pluto agent lease: release failed — ${error instanceof Error ? error.message : error}`));
  await db.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("sigterm"));
process.on("SIGINT", () => void shutdown("sigint"));

async function stopAfterLosingLease(): Promise<void> {
  await recordPlutoEvent("warning", { message: "another Pluto agent took over the agent lease: this agent stopped" }).catch(() => {});
  await shutdown("lease_lost");
}

async function announceStart(taken: AgentLeaseTaken, previousRelease: string | null): Promise<void> {
  try {
    await notifyPlutoTelegram(plutoStartMessage({ release: currentRelease(), previousRelease, lease: taken, state: await loadPlutoState() }));
  } catch (error) {
    console.warn(`Pluto agent: start message failed — ${error instanceof Error ? error.message : error}`);
  }
}

const leaseTaken = await lease.waitUntilTaken((current) =>
  console.log(`Pluto agent waiting: another agent (${current.holder}) holds the agent lease until ${current.leaseUntil.toISOString()}; trying again every ${agentLeaseRetryIntervalMs / 1000} s.`),
);
if (leaseTaken !== null && !stopping) {
  if (leaseTaken.waitedMs > 0 || leaseTaken.tookOverFrom !== null) {
    console.log(`Pluto agent took the agent lease after ${Math.round(leaseTaken.waitedMs / 1000)} s${leaseTaken.tookOverFrom !== null ? `, from ${leaseTaken.tookOverFrom}, which had stopped renewing it` : ""}.`);
  }
  // Read before the agent's boot guard records this release.
  const previousRelease = (await loadPlutoState()).lastSeenRelease;
  lease.startRenewing(() => void stopAfterLosingLease());
  agent = new PlutoAgent(decision.config, lease);
  await agent.start();
  await announceStart(leaseTaken, previousRelease);
}
