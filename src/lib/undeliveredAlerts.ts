import { db } from "../db/connection.js";
import { notifyTelegram } from "./notifyTelegram.js";

// An alert whose Telegram send failed (after notifyTelegram's own retry) is kept in
// alert_state under an "undelivered:" key, so the morning digest (opsMonitor.ts) can list
// it instead of the failure living only in a console.error nobody reads.

const undeliveredKeyPrefix = "undelivered:";

/** Sends the alert; when Telegram could not deliver it, records it for the morning digest. */
export async function notifyTelegramTracked(message: string): Promise<void> {
  const delivered = await notifyTelegram(message);
  if (delivered) return;
  await db("alert_state")
    .insert({ alert_key: `${undeliveredKeyPrefix}${Date.now()}`, first_alerted_at: db.fn.now(), last_alerted_at: db.fn.now(), last_message: message })
    .onConflict("alert_key")
    .ignore()
    .catch((error) => console.error(`Could not record an undelivered alert: ${error instanceof Error ? error.message : error}`));
}

export async function loadUndeliveredAlerts(): Promise<{ alertKey: string; alertedAt: Date; message: string }[]> {
  const rows: { alert_key: string; first_alerted_at: Date; last_message: string }[] = await db("alert_state")
    .where("alert_key", "like", `${undeliveredKeyPrefix}%`)
    .orderBy("first_alerted_at", "asc")
    .select("alert_key", "first_alerted_at", "last_message");
  return rows.map((row) => ({ alertKey: row.alert_key, alertedAt: new Date(row.first_alerted_at), message: row.last_message }));
}

export async function clearUndeliveredAlerts(alertKeys: string[]): Promise<void> {
  if (alertKeys.length === 0) return;
  await db("alert_state").whereIn("alert_key", alertKeys).del();
}
