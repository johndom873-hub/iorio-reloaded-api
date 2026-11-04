// The opening look (design item 74; timing agreed 2026-10-07): one round over every enabled ticker once today's data
// is in. "In" means the market quote loop has written today's first band quotes (since 2026-10-27; it was the 10:00
// Day Signals seed before). The agent only looks inside Pluto's window (window_start_et, 10:00 ET or later), by which
// time the loop, quoting from the 9:30 open, normally has them. If they are still missing at 10:30 ET the look runs
// anyway on whatever is there, recorded as incomplete and alerted, and one more full round follows once they arrive.
// On a day no ticker has an expiry the band covers (Options expiry "today" on a day none ends at the close: a Tuesday or
// Thursday on Mon/Wed/Fri chains) the band has nothing to quote, so the look runs at once without waiting for quotes and
// a notice says so (Marcelo 2026-11-04).

export const openingLookFallbackEtMinutes = 10 * 60 + 30;

export interface OpeningLookProgress {
  /** Trading date (YYYY-MM-DD) whose opening look has run, complete or not. */
  doneFor: string | null;
  /** Trading date whose opening look ran before the data was in (the late-data round is still owed). */
  incompleteFor: string | null;
}

export type OpeningLookDecision = "wait" | "run_complete" | "run_incomplete" | "run_after_late_seed" | "run_without_option_expiry" | "done";

/** `noBandExpiryToday`: no ticker has an expiry the band covers today, so no band quote will come. */
export function decideOpeningLook(input: { todayIso: string; nowEtMinutes: number; dataReady: boolean; noBandExpiryToday: boolean; progress: OpeningLookProgress }): OpeningLookDecision {
  const { todayIso, nowEtMinutes, dataReady, noBandExpiryToday, progress } = input;
  if (progress.doneFor === todayIso) return progress.incompleteFor === todayIso && dataReady ? "run_after_late_seed" : "done";
  if (dataReady) return "run_complete";
  if (noBandExpiryToday) return "run_without_option_expiry";
  return nowEtMinutes >= openingLookFallbackEtMinutes ? "run_incomplete" : "wait";
}

export function advanceOpeningLook(progress: OpeningLookProgress, todayIso: string, decision: OpeningLookDecision): OpeningLookProgress {
  if (decision === "run_complete" || decision === "run_without_option_expiry") return { doneFor: todayIso, incompleteFor: null };
  if (decision === "run_incomplete") return { doneFor: todayIso, incompleteFor: todayIso };
  if (decision === "run_after_late_seed") return { doneFor: todayIso, incompleteFor: null };
  return progress;
}
