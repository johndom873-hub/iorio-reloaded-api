// Repeated round failures (Marcelo, 2026-10-07): one Telegram alert after this many failed rounds in a row, one message
// when a round next completes. A skipped round completed; only an exception is a failure.

export const consecutiveFailedRoundsBeforeAlert = 3;

export const roundFailureAlertText = `⚠️ Pluto: ${consecutiveFailedRoundsBeforeAlert} analysis rounds in a row have failed. The error is in the Pluto screen's Event log (System warnings).`;
export const roundFailureRecoveryText = "✅ Pluto: analysis rounds are completing again.";

export interface RoundFailureState {
  consecutiveFailures: number;
  alerted: boolean;
}

export function recordRoundOutcome(state: RoundFailureState, completed: boolean): { state: RoundFailureState; send: "alert" | "recovery" | null } {
  if (completed) return { state: { consecutiveFailures: 0, alerted: false }, send: state.alerted ? "recovery" : null };
  const consecutiveFailures = state.consecutiveFailures + 1;
  const alert = !state.alerted && consecutiveFailures >= consecutiveFailedRoundsBeforeAlert;
  return { state: { consecutiveFailures, alerted: state.alerted || alert }, send: alert ? "alert" : null };
}

/** A failed forced round is retried once, this long after it failed; the opening look is retried by housekeeping instead. */
export const forcedRoundRetryDelayMs = 60_000;

export function shouldRetryForcedRound(round: { trigger: string; retried?: boolean }): boolean {
  return round.trigger !== "opening_analysis" && !round.retried;
}
