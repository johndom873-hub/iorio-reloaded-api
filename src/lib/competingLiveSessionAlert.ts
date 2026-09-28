import type { CompetingLiveSessionProbeResult } from "../ibkr/probeCompetingLiveSession.js";
import { formatDurationHuman } from "./formatDurationHuman.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";

// Telegram side of the competing-live-session check, run by the 10-minute IBKR
// health check (probeCompetingLiveSession.ts). State-based (throttledAlert.ts):
// one message when data gets blocked, hourly reminders, one when it flows again.
// "unknown" (the probe got neither a price nor the error) changes nothing.
const competingLiveSessionAlertKey = "ibkr_competing_live_session";
const competingLiveSessionReminderIntervalMs = 60 * 60_000;

export const competingLiveSessionBlockedMessage =
  "⚠️ Real-time market data is blocked: IBKR error 10197 (competing live session). " +
  "Someone is logged into the live IBKR account (johndom873) in TWS, IBKR Mobile or Client Portal; ask them to log out. " +
  "Not a Gateway problem, a restart won't fix it.";

export async function reportCompetingLiveSession(result: CompetingLiveSessionProbeResult): Promise<void> {
  if (result === "blocked") {
    await notifyDownThrottled(competingLiveSessionAlertKey, competingLiveSessionBlockedMessage, competingLiveSessionReminderIntervalMs);
  } else if (result === "flowing") {
    const blockedForMs = await clearDownState(competingLiveSessionAlertKey);
    if (blockedForMs !== null) await notifyTelegram(`✅ Real-time market data is flowing again (was blocked by a competing live session for ~${formatDurationHuman(blockedForMs)}).`);
  }
}
