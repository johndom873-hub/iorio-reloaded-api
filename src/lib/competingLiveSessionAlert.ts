import { db } from "../db/connection.js";
import type { CompetingLiveSessionProbeResult } from "../ibkr/probeCompetingLiveSession.js";
import { formatDurationHuman } from "./formatDurationHuman.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";

// Telegram side of the IBKR 10197 check, run by the 10-minute IBKR health check
// (probeCompetingLiveSession.ts). State-based (throttledAlert.ts): one message
// when data gets blocked, hourly reminders, one when it flows again. "unknown"
// (the probe got neither a price nor the error) changes nothing.
const competingLiveSessionAlertKey = "ibkr_competing_live_session";
const competingLiveSessionReminderIntervalMs = 60 * 60_000;

/** 10197 survived a fresh Gateway login, so the stale-session explanation is ruled out. */
export const blockedAfterReloginMessage =
  "⚠️ Real-time market data is blocked: IBKR error 10197 persists after a fresh Gateway login, so another session on the live IBKR username (johndom873) is probably using the market data (TWS, IBKR Mobile or Client Portal). The health check won't restart the Gateway again for this; it clears once that session ends.";

/** No restart was possible on this run, so the likelier cause (a stale session) is still unresolved. */
export function blockedRestartDeferredMessage(reason: string): string {
  return `⚠️ Real-time market data is blocked: IBKR error 10197. Usually the Gateway's session went stale after IBKR dropped and silently restored its connection; a Gateway restart (fresh login) clears it. Not restarted on this run: ${reason}.`;
}

/** True once this 10197 episode already survived a Gateway restart — the health check restarts the Gateway only once per episode. */
export async function competingLiveSessionSurvivedRestart(): Promise<boolean> {
  const row: { last_message: string } | undefined = await db("alert_state").where({ alert_key: competingLiveSessionAlertKey }).first("last_message");
  return row?.last_message === blockedAfterReloginMessage;
}

/** Returns true when it sent the "flowing again" message (an alerted episode just cleared). */
export async function reportCompetingLiveSession(result: CompetingLiveSessionProbeResult, blockedMessage: string): Promise<boolean> {
  if (result === "blocked") {
    await notifyDownThrottled(competingLiveSessionAlertKey, blockedMessage, competingLiveSessionReminderIntervalMs);
  } else if (result === "flowing") {
    const blockedForMs = await clearDownState(competingLiveSessionAlertKey);
    if (blockedForMs !== null) {
      await notifyTelegram(`✅ Real-time market data is flowing again (IBKR error 10197 cleared after ~${formatDurationHuman(blockedForMs)}).`);
      return true;
    }
  }
  return false;
}
