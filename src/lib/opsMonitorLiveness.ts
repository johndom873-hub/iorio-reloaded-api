import { db } from "../db/connection.js";
import { formatDurationHuman } from "./formatDurationHuman.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";

// The ops monitor (opsMonitor.ts) watches every Heroku Scheduler job; this is the reverse: the
// 10-minute ibkr_health_check, itself a Scheduler job, confirms the monitor is still beating.
// Each side covers the other's failure, so neither can die silently on its own.

export const opsMonitorProcessName = "ops_monitor";
export const opsMonitorHeartbeatStaleAfterMs = 5 * 60_000;
const opsMonitorDownAlertKey = "ops_monitor_down";
const opsMonitorDownReminderIntervalMs = 60 * 60_000;

/** Pure: the problem to report, or null when the monitor is fine. */
export function evaluateOpsMonitorLiveness(input: { now: Date; heartbeatAt: Date | null }): string | null {
  if (input.heartbeatAt === null) return "The ops monitor has never reported a heartbeat (is the web dyno running?).";
  const ageMs = input.now.getTime() - input.heartbeatAt.getTime();
  if (ageMs > opsMonitorHeartbeatStaleAfterMs) return `The ops monitor heartbeat is over ${opsMonitorHeartbeatStaleAfterMs / 60_000} min old: job deadline alerts and the morning digest are not running.`;
  return null;
}

/** Sends/clears the throttled alert. Returns the problem text, if any. */
export async function reportOpsMonitorLiveness(now: Date = new Date()): Promise<string | null> {
  const row = await db("worker_health").where({ process_name: opsMonitorProcessName }).first("updated_at");
  const problem = evaluateOpsMonitorLiveness({ now, heartbeatAt: row ? new Date(row.updated_at) : null });
  if (problem) {
    await notifyDownThrottled(opsMonitorDownAlertKey, `⚠️ ${problem}`, opsMonitorDownReminderIntervalMs);
  } else {
    const downForMs = await clearDownState(opsMonitorDownAlertKey);
    if (downForMs !== null) await notifyTelegram(`✅ The ops monitor is beating again (was down ~${formatDurationHuman(downForMs)}).`);
  }
  return problem;
}
