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

/**
 * A forced round that completed but held back an order only for want of a live two-sided quote (Marcelo 2026-11-25) looks
 * again at those tickers once, this long after. A ticker with no option expiring today gets no band round, so without this
 * nothing would look at it again until another forced round (RKLB, 2026-11-25: 15 minutes, until it was switched on again).
 */
export const liveQuoteRetryDelayMs = 30_000;

/** How long a switched-on ticker's round waits for its first live stock quote (the agent's watchSwitchedOnTickers). */
export const switchedOnTickerQuoteWaitMs = 10_000;

/** The tickers a forced round's one retry looks at: those it held back for want of a live quote, unless it was itself a retry. */
export function liveQuoteRetrySymbols(round: { trigger: string; retried?: boolean }, result: string, quoteBlockedSymbols: readonly string[]): string[] {
  if (result !== "completed" || round.retried || round.trigger === "live_quote_retry") return [];
  return [...new Set(quoteBlockedSymbols)].sort();
}
