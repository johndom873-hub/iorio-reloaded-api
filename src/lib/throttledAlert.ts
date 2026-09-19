import { db } from "../db/connection.js";
import { notifyTelegram } from "./notifyTelegram.js";
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
    await notifyTelegram(message);
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
  await notifyTelegram(`${message}\n\n(Still down after ~${formatDurationHuman(downForMs)}. Reminders are sent at most every ${formatDurationHuman(reminderIntervalMs)}.)`);
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
