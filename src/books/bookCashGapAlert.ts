import { db } from "../db/connection.js";
import { readAppEnvironment } from "../lib/appEnvironment.js";
import { clearDownState, notifyDownThrottled } from "../lib/throttledAlert.js";
import { notifyTelegramTracked } from "../lib/undeliveredAlerts.js";
import { loadBooksLiveState } from "./bookFigures.js";

// The books' cash against IBKR's live cash (Marcelo 2026-11-05, D6: an alert only, nothing is blocked). Checked by the
// 10-minute IBKR health check: a gap above $500 that lasts 30 minutes alerts, with a reminder at most hourly, and one
// message when it clears. Example: IBKR's cash $278,613, the books' $278,678 → a gap of −$65, no alert.
// Prod only: staging's paper account holds SGD cash against a USD debt, so its USD cash moves with the exchange rate.

export const bookCashGapAlertDollars = 500;
export const bookCashGapAlertAfterMs = 30 * 60_000;
const bookCashGapReminderIntervalMs = 60 * 60_000;
const alertKey = "books_cash_gap";
/** alert_state row holding when the gap first went above the limit (no message is sent for it). */
const overSinceKey = "books_cash_gap_over_since";

export const bookCashGapMessage = "⚠️ The Pluto and Manual books' cash has differed from IBKR's by more than $500 for over 30 minutes. Check the books on Risk & Limits.";
export const bookCashGapClearedMessage = "✅ The books' cash agrees with IBKR's again.";

export const bookCashGapAlertsRunHere = () => readAppEnvironment() === "production";

/** What the gap check found, for the health check's details; null when it did not run or could not tell. */
export async function checkBooksCashGap(now: Date = new Date()): Promise<string | null> {
  if (!bookCashGapAlertsRunHere()) return null;
  const state = await loadBooksLiveState({ now });
  // Before the start, or with IBKR's cash unknown, nothing is known: the state is left as it is.
  if (!state.ready || state.cashGapAgainstIbkr === null) return null;
  const gap = state.cashGapAgainstIbkr;
  if (Math.abs(gap) <= bookCashGapAlertDollars) {
    await db("alert_state").where({ alert_key: overSinceKey }).del();
    if ((await clearDownState(alertKey)) !== null) await notifyTelegramTracked(bookCashGapClearedMessage);
    return null;
  }
  await db("alert_state").insert({ alert_key: overSinceKey, first_alerted_at: now, last_alerted_at: now, last_message: "" }).onConflict("alert_key").ignore();
  const row: { first_alerted_at: Date } | undefined = await db("alert_state").where({ alert_key: overSinceKey }).first("first_alerted_at");
  const overForMs = row ? now.getTime() - new Date(row.first_alerted_at).getTime() : 0;
  if (overForMs >= bookCashGapAlertAfterMs) await notifyDownThrottled(alertKey, bookCashGapMessage, bookCashGapReminderIntervalMs);
  return `the books' cash differs from IBKR's by ${gap.toFixed(2)} (for ${Math.round(overForMs / 60_000)} min)`;
}
