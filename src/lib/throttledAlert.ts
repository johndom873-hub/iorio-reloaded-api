import { db } from "../db/connection.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";
import { formatDurationHuman } from "./formatDurationHuman.js";

// State-based alerting for things that can stay broken for hours (IBKR
// Gateway outages, e.g. weekend maintenance): announce once when it goes
// down, remind at most once per reminderIntervalMs while it stays down, and
// announce once when it recovers -- instead of one message per failed
// attempt. State lives in the alert_state table (row present = already
// alerted); see its migration for why it's not in-memory.

/**
 * Sends `message` unless this alertKey was already alerted within the last
 * reminderIntervalMs with the same message. A different message (e.g. the
 * failure cause changed) always goes out. Returns whether anything was sent.
 * The insert / conditional update are single atomic statements, so two
 * concurrent callers can't both send.
 */
export async function notifyDownThrottled(alertKey: string, message: string, reminderIntervalMs: number): Promise<boolean> {
  const inserted = await db("alert_state")
    .insert({ alert_key: alertKey, first_alerted_at: db.fn.now(), last_alerted_at: db.fn.now(), last_message: message })
    .onConflict("alert_key")
    .ignore()
    .returning("alert_key");
  if (inserted.length > 0) {
    await notifyTelegramTracked(message);
    return true;
  }

  const reminderCutoff = new Date(Date.now() - reminderIntervalMs);
  const updated: { first_alerted_at: Date }[] = await db("alert_state")
    .where({ alert_key: alertKey })
    .andWhere((builder) => builder.where("last_alerted_at", "<=", reminderCutoff).orWhereNot({ last_message: message }))
    .update({ last_alerted_at: db.fn.now(), last_message: message })
    .returning("first_alerted_at");
  if (updated.length === 0) return false;

  const downForMs = Date.now() - new Date(updated[0]!.first_alerted_at).getTime();
  await notifyTelegramTracked(`${message}\n\n(Still down after ~${formatDurationHuman(downForMs)}. Reminders are sent at most every ${formatDurationHuman(reminderIntervalMs)}.)`);
  return true;
}

/**
 * Clears the "down" state for alertKey. Returns how long it had been down
 * (ms) if it was in the alerted state, or null if there was nothing to clear
 * -- callers use that to send a recovery message only when a down alert was
 * actually sent.
 */
export async function clearDownState(alertKey: string): Promise<number | null> {
  const cleared: { first_alerted_at: Date }[] = await db("alert_state").where({ alert_key: alertKey }).del().returning("first_alerted_at");
  if (cleared.length === 0) return null;
  return Date.now() - new Date(cleared[0]!.first_alerted_at).getTime();
}

/**
 * Sends `message` unless this alertKey already alerted within the last intervalMs. For failures that
 * can repeat every few seconds and have no clear "recovered" moment (per-viewer stream errors, a
 * failing background write): a fresh failure after the interval alerts again. One atomic statement,
 * so concurrent callers cannot both send. Returns whether anything was sent.
 */
export async function notifyRateLimited(alertKey: string, message: string, intervalMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - intervalMs);
  const recoveredQuietCutoff = new Date(Date.now() - recoveredQuietPeriodMs);
  // first_alerted_at restarts when a new alert follows a recovery, so "was failing ~X" measures this episode. After a
  // recovery the hourly limit is relaxed to a short quiet period (last_alerted_at holds the recovery time): a source that
  // flaps within it stays silent, but one that fails again and STAYS failing is announced instead of hiding for an hour.
  const result = await db.raw(
    `INSERT INTO alert_state (alert_key, first_alerted_at, last_alerted_at, last_message)
     VALUES (?, now(), now(), ?)
     ON CONFLICT (alert_key) DO UPDATE SET
       first_alerted_at = CASE WHEN alert_state.last_message = ? THEN now() ELSE alert_state.first_alerted_at END,
       last_alerted_at = now(),
       last_message = EXCLUDED.last_message
     WHERE alert_state.last_alerted_at <= ?
        OR (alert_state.last_message = ? AND alert_state.last_alerted_at <= ?)
     RETURNING alert_key`,
    [alertKey, message, recoveredMarker, cutoff, recoveredMarker, recoveredQuietCutoff],
  );
  if (result.rows.length === 0) return false;
  await notifyTelegramTracked(message);
  return true;
}

/** How long after a recovery a new failure of the same source stays silent (flapping); after it, a persisting failure alerts again. */
export const recoveredQuietPeriodMs = 10 * 60_000;

/** Stored in alert_state.last_message once a rate-limited source has recovered (and announced it). */
export const recoveredMarker = "RECOVERED";

/**
 * Marks a rate-limited source recovered WITHOUT deleting its row, so the hourly limit keeps applying:
 * a source that flaps (fails, recovers, fails again) must not send two messages per flap. Returns how
 * long the episode lasted, or null when there was no unrecovered alert (nothing to announce).
 */
export async function markRateLimitedRecovered(alertKey: string): Promise<number | null> {
  const updated: { first_alerted_at: Date }[] = await db("alert_state")
    .where({ alert_key: alertKey })
    .whereNot({ last_message: recoveredMarker })
    // last_alerted_at now records WHEN it recovered (see notifyRateLimited's quiet period).
    .update({ last_message: recoveredMarker, last_alerted_at: db.fn.now() })
    .returning("first_alerted_at");
  if (updated.length === 0) return null;
  return Date.now() - new Date(updated[0]!.first_alerted_at).getTime();
}
