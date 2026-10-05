import { db } from "../db/connection.js";
import { formatDurationHuman } from "./formatDurationHuman.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";

// The 10-minute health check already confirms the VPS worker's systemd unit is active, but a worker can be
// "active" and hung (a stuck IBKR call, a dead event loop): it then places no orders and reconciles nothing
// while every check stays green. The worker upserts worker_health every 45 s; a heartbeat this old with the
// service reported active is a hung worker. Threshold approved 2026-09-30 (the trading gate's own 2-minute
// "offline" state is for the UI; alerting waits for 5 so a reconnect blip does not page). State-based
// alerting like the other liveness checks: once, hourly reminders, one recovery message.

export const workerProcessName = "ibkr_gateway_worker";
export const workerHeartbeatAlertAfterMs = 5 * 60_000;
const workerHungAlertKey = "worker_heartbeat_stale";
const workerHungReminderIntervalMs = 60 * 60_000;

/** Pure: the problem to report, or null. `restartedJustNow` gives a freshly restarted worker time to write its first beat. */
export function evaluateWorkerHeartbeat(input: { now: Date; heartbeatAt: Date | null; serviceActive: boolean | null; restartedJustNow: boolean }): string | null {
  // serviceActive === false: the systemd probe already reports a stopped service, so a stale heartbeat is expected.
  // null: the probe did not run this time (an earlier step failed), so the service state is unknown.
  if (input.serviceActive === false || input.restartedJustNow) return null;
  const subject = input.serviceActive === null ? "The VPS worker heartbeat (the service state was not checked this run, because an earlier step failed)" : "The VPS worker service is active but its heartbeat";
  if (input.heartbeatAt === null) return `${subject} has never been written to worker_health.`;
  const ageMs = input.now.getTime() - input.heartbeatAt.getTime();
  if (ageMs > workerHeartbeatAlertAfterMs) {
    return `${subject} is over ${workerHeartbeatAlertAfterMs / 60_000} min old (it beats every 45 s): the worker is ${input.serviceActive === null ? "hung or stopped" : "hung"}, so orders are not being placed or reconciled.`;
  }
  return null;
}

/** Runs the check against worker_health and sends/clears the throttled alert. Returns the problem text, if any. */
export async function reportWorkerHeartbeat(input: { serviceActive: boolean | null; restartedJustNow: boolean }, now: Date = new Date()): Promise<string | null> {
  const row = await db("worker_health").where({ process_name: workerProcessName }).first("updated_at");
  const problem = evaluateWorkerHeartbeat({ now, heartbeatAt: row ? new Date(row.updated_at) : null, ...input });
  if (problem) {
    await notifyDownThrottled(workerHungAlertKey, `⚠️ ${problem}`, workerHungReminderIntervalMs);
  } else {
    const downForMs = await clearDownState(workerHungAlertKey);
    if (downForMs !== null) await notifyTelegram(`✅ The VPS worker heartbeat is back (was stale ~${formatDurationHuman(downForMs)}).`);
  }
  return problem;
}
