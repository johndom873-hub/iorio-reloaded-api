import { formatDurationHuman } from "./formatDurationHuman.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";
import { clearDownState, notifyRateLimited } from "./throttledAlert.js";

// Failures inside the web dyno's background work (the Day Signals loop, the Signals streams, the shared
// IBKR connection) used to reach only console.error, where nobody reads them. This turns them into a
// Telegram alert without letting a repeating failure page every few seconds: at most one alert per
// source per hour (approved 2026-09-30). Never throws and never blocks the caller.

export const backgroundFailureIntervalMs = 60 * 60_000;
const backgroundFailureKeyPrefix = "bg_failure:";

/** Fire-and-forget. `source` names the failing area ("day-signals:quote-write"); the message is what the alert says. */
export function reportBackgroundFailure(source: string, message: string): void {
  notifyRateLimited(`${backgroundFailureKeyPrefix}${source}`, `⚠️ ${message}`, backgroundFailureIntervalMs).catch((error) => console.error(`Could not report background failure "${source}": ${error instanceof Error ? error.message : error}`));
}

/** Sends a "recovered" message only if a failure alert for this source was actually sent before. Fire-and-forget. */
export function reportBackgroundRecovery(source: string, message: string): void {
  clearDownState(`${backgroundFailureKeyPrefix}${source}`)
    .then((downForMs) => (downForMs === null ? undefined : notifyTelegramTracked(`✅ ${message} (was failing ~${formatDurationHuman(downForMs)}).`)))
    .catch((error) => console.error(`Could not report background recovery "${source}": ${error instanceof Error ? error.message : error}`));
}
