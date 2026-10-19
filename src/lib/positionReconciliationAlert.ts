import { formatDurationHuman } from "./formatDurationHuman.js";
import { notifyDownThrottled, clearDownState } from "./throttledAlert.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";

// Telegram side of the position reconciliation run by the 10-minute IBKR health check
// (checkPositionReconciliation.ts). State-based (throttledAlert.ts): one message when a problem
// starts, hourly reminders, one when it clears. A check that could not run is not a mismatch and
// says so; it alerts only when the previous check could not run either, since a single
// positions-request timeout is usually a Gateway hiccup and Pluto stays blocked meanwhile
// (pluto/systemChecks.ts fails its reconciliation check until a run completes).
const mismatchAlertKey = "position_reconciliation_mismatch";
const couldNotRunAlertKey = "position_reconciliation_could_not_run";
const reconciliationReminderIntervalMs = 60 * 60_000;

export type PositionReconciliationResult =
  | { kind: "clean" }
  | { kind: "mismatches"; mismatches: string[] }
  | { kind: "couldNotRun"; reason: string; previousRunAlsoCouldNotRun: boolean };

export function reconciliationMismatchMessage(mismatches: string[]): string {
  const count = mismatches.length === 1 ? "1 mismatch" : `${mismatches.length} mismatches`;
  return `⚠️ Position reconciliation: ${count} between IBKR and our records —\n${mismatches.map((mismatch) => `• ${mismatch}`).join("\n")}`;
}

export function reconciliationCouldNotRunMessage(reason: string): string {
  const cause = reason.startsWith("reqPositions timed out") ? "IBKR didn't return the positions list in time" : "it hit an error";
  return `⚠️ Position reconciliation couldn't run: ${cause}. Nothing was compared, so this is not a mismatch. Pluto won't trade until a check completes.\n(${reason})`;
}

export const reconciliationRanAgainMessage = "✅ Position reconciliation ran again: IBKR and our records agree.";

export function reconciliationAgreesAgainMessage(mismatchedForMs: number): string {
  return `✅ Position reconciliation: IBKR and our records agree again (after ~${formatDurationHuman(mismatchedForMs)}).`;
}

// Also the wording when the mismatch list changes (throttledAlert.ts sends a changed message as a reminder), so it never says "unchanged".
function reminderText(message: string, alertedFor: string, interval: string): string {
  return `${message}\n\n(First alerted ~${alertedFor} ago. Reminders are sent at most every ${interval}.)`;
}

export async function reportPositionReconciliation(result: PositionReconciliationResult): Promise<void> {
  if (result.kind === "couldNotRun") {
    // Says nothing about whether a mismatch alerted earlier still holds, so that state is left as it is.
    if (result.previousRunAlsoCouldNotRun) {
      await notifyDownThrottled(couldNotRunAlertKey, reconciliationCouldNotRunMessage(result.reason), reconciliationReminderIntervalMs, { reminderText });
    }
    return;
  }

  // The check ran. A mismatch alert below already says so, so "ran again" is only announced on a clean run.
  const couldNotRunForMs = await clearDownState(couldNotRunAlertKey);
  if (result.kind === "mismatches") {
    await notifyDownThrottled(mismatchAlertKey, reconciliationMismatchMessage(result.mismatches), reconciliationReminderIntervalMs, { reminderText });
    return;
  }

  const mismatchedForMs = await clearDownState(mismatchAlertKey);
  if (mismatchedForMs !== null) await notifyTelegramTracked(reconciliationAgreesAgainMessage(mismatchedForMs));
  else if (couldNotRunForMs !== null) await notifyTelegramTracked(reconciliationRanAgainMessage);
}
