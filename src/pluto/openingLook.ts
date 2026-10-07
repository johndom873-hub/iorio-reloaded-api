// The opening look (design item 74; timing agreed 2026-10-07): one round over every enabled ticker once today's data
// is in. "In" means today's day_signals_seed job finished (success or failure): it runs after every capture, fit and
// retry, so the first fitted ticker is not enough. A ticker with no usable fit is refused by the usual filters, never
// waited for. If the seed still has not finished at 10:30 ET (it normally does by about 10:07) the look runs anyway on
// whatever is there, recorded as incomplete and alerted, and one more full round follows once the seed does finish.

export const openingLookFallbackEtMinutes = 10 * 60 + 30;

export interface OpeningLookProgress {
  /** Trading date (YYYY-MM-DD) whose opening look has run, complete or not. */
  doneFor: string | null;
  /** Trading date whose opening look ran before the seed finished (the late-seed round is still owed). */
  incompleteFor: string | null;
}

export type OpeningLookDecision = "wait" | "run_complete" | "run_incomplete" | "run_after_late_seed" | "done";

export function decideOpeningLook(input: { todayIso: string; nowEtMinutes: number; seedFinished: boolean; progress: OpeningLookProgress }): OpeningLookDecision {
  const { todayIso, nowEtMinutes, seedFinished, progress } = input;
  if (progress.doneFor === todayIso) return progress.incompleteFor === todayIso && seedFinished ? "run_after_late_seed" : "done";
  if (seedFinished) return "run_complete";
  return nowEtMinutes >= openingLookFallbackEtMinutes ? "run_incomplete" : "wait";
}

export function advanceOpeningLook(progress: OpeningLookProgress, todayIso: string, decision: OpeningLookDecision): OpeningLookProgress {
  if (decision === "run_complete") return { doneFor: todayIso, incompleteFor: null };
  if (decision === "run_incomplete") return { doneFor: todayIso, incompleteFor: todayIso };
  if (decision === "run_after_late_seed") return { doneFor: todayIso, incompleteFor: null };
  return progress;
}
