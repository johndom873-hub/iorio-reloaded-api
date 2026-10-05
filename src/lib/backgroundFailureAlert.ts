import { formatDurationHuman } from "./formatDurationHuman.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";
import { markRateLimitedRecovered, notifyRateLimited } from "./throttledAlert.js";

// Failures inside the web dyno's background work (the Day Signals loop, the Signals streams, the shared
// IBKR connection) used to reach only console.error, where nobody reads them. This turns them into a
// Telegram alert without letting a repeating failure page every few seconds: at most one alert per
// source per hour (approved 2026-09-30). Never throws and never blocks the caller.
//
// Three protections beyond the hourly limit (found in review):
// - An in-memory pre-filter: a source that fails every second must not cost one Postgres statement per
//   failure on a 4-connection pool, so the database is asked at most once per source per few minutes.
// - The alert must survive the database being the failing thing (quote-write and heartbeat failures are
//   DB failures by nature): if the limiter cannot reach Postgres, it falls back to an in-memory hourly
//   limit and sends directly.
// - A recovery keeps the row (marked recovered), so a flapping source is one alert per hour, not one
//   alert plus one recovery per flap.

export const backgroundFailureIntervalMs = 60 * 60_000;
export const databaseCheckPrefilterMs = 5 * 60_000;
const backgroundFailureKeyPrefix = "bg_failure:";

const lastDatabaseCheckAtBySource = new Map<string, number>();
const lastDirectSendAtBySource = new Map<string, number>();

const startsWithEmoji = (text: string): boolean => /^\p{Extended_Pictographic}/u.test(text);

/** Fire-and-forget. `source` names the failing area ("day-signals:quote-write"); the message is what the alert says. */
export function reportBackgroundFailure(source: string, message: string, now: number = Date.now()): void {
  const lastCheckAt = lastDatabaseCheckAtBySource.get(source);
  if (lastCheckAt !== undefined && now - lastCheckAt < databaseCheckPrefilterMs) return;
  lastDatabaseCheckAtBySource.set(source, now);

  const text = startsWithEmoji(message) ? message : `⚠️ ${message}`;
  notifyRateLimited(`${backgroundFailureKeyPrefix}${source}`, text, backgroundFailureIntervalMs).catch(async (error) => {
    console.error(`Background failure "${source}": the alert limiter could not reach the database (${error instanceof Error ? error.message : error}); using the in-memory limit.`);
    const lastSentAt = lastDirectSendAtBySource.get(source);
    if (lastSentAt !== undefined && now - lastSentAt < backgroundFailureIntervalMs) return;
    lastDirectSendAtBySource.set(source, now);
    await notifyTelegram(text);
  }).catch((error) => console.error(`Could not report background failure "${source}": ${error instanceof Error ? error.message : error}`));
}

/** Sends a "recovered" message only if an unrecovered failure alert for this source exists. Fire-and-forget. */
export function reportBackgroundRecovery(source: string, message: string): void {
  markRateLimitedRecovered(`${backgroundFailureKeyPrefix}${source}`)
    .then((downForMs) => (downForMs === null ? undefined : notifyTelegramTracked(`✅ ${message} (was failing ~${formatDurationHuman(downForMs)}).`)))
    .catch((error) => console.error(`Could not report background recovery "${source}": ${error instanceof Error ? error.message : error}`));
}

/** Test hook: forgets the in-memory limiter state. */
export function resetBackgroundFailureLimiterForTests(): void {
  lastDatabaseCheckAtBySource.clear();
  lastDirectSendAtBySource.clear();
}
