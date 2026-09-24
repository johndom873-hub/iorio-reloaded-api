import { db } from "../db/connection.js";
import { loadDaySignalExpiries } from "./daySignalsStore.js";
import { formatDurationHuman } from "./formatDurationHuman.js";
import { computeMarketSessionStatus, easternDateIso } from "./marketSessionStatus.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";

// Liveness of the Day Signals loop, checked by the 10-minute IBKR health-check
// job (the daily watchdog runs after the close, too late for an intraday
// loop). The loop heartbeats into worker_health as "day_signals_loop"
// (daySignalsLoop.ts). A silent death is only a problem while it should be
// running: market open and today's pool seeded. State-based alerting
// (throttledAlert.ts): one message when it goes down, hourly reminders, one
// when it recovers.

export const daySignalsHeartbeatStaleAfterMs = 5 * 60_000;
const daySignalsDownAlertKey = "day_signals_loop_down";
const daySignalsDownReminderIntervalMs = 60 * 60_000;

export interface DaySignalsLivenessInput {
  now: Date;
  marketOpen: boolean;
  poolSeededToday: boolean;
  heartbeat: { updatedAt: Date; connected: boolean } | null;
}

/** Pure: the problem to report, or null when the loop is fine or not expected to run right now. */
export function evaluateDaySignalsLiveness(input: DaySignalsLivenessInput): string | null {
  if (!input.marketOpen || !input.poolSeededToday) return null;
  if (!input.heartbeat) return "Day Signals loop has never reported a heartbeat although today's pool is seeded and the market is open (is DAY_SIGNALS_LOOP_ENABLED=true on the web dyno?).";
  const ageMs = input.now.getTime() - input.heartbeat.updatedAt.getTime();
  if (ageMs > daySignalsHeartbeatStaleAfterMs) return `Day Signals loop heartbeat is ${Math.round(ageMs / 60_000)} min old — the loop is not running.`;
  if (!input.heartbeat.connected) return "Day Signals loop is idle although the market is open and today's pool is seeded — check its reason on System Health.";
  return null;
}

/** Runs the check against the real tables and sends/clears the throttled alert. Returns the problem text, if any. */
export async function reportDaySignalsLoopLiveness(now: Date = new Date()): Promise<string | null> {
  const [session, pool, heartbeatRow] = await Promise.all([
    computeMarketSessionStatus(now),
    loadDaySignalExpiries(easternDateIso(now)),
    db("worker_health").where({ process_name: "day_signals_loop" }).first("updated_at", "connected"),
  ]);
  const problem = evaluateDaySignalsLiveness({
    now,
    marketOpen: session.state === "open",
    poolSeededToday: pool.length > 0,
    heartbeat: heartbeatRow ? { updatedAt: new Date(heartbeatRow.updated_at), connected: Boolean(heartbeatRow.connected) } : null,
  });
  if (problem) {
    await notifyDownThrottled(daySignalsDownAlertKey, `⚠️ ${problem}`, daySignalsDownReminderIntervalMs);
  } else {
    const downForMs = await clearDownState(daySignalsDownAlertKey);
    if (downForMs !== null) await notifyTelegram(`✅ Day Signals loop is refreshing again (was down ~${formatDurationHuman(downForMs)}).`);
  }
  return problem;
}
