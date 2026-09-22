// Pure step model for the new-ticker backfill pipeline (design agreed
// 2026-09-21). Kept free of DB/IBKR so progress math and status rules are
// unit-tested.

export type BackfillStepKey = "history" | "calendar" | "chain_warmup" | "first_snapshot";
export type BackfillStepStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type BackfillRunStatus = "running" | "complete" | "partial";

export interface BackfillStep {
  key: BackfillStepKey;
  label: string;
  status: BackfillStepStatus;
  message: string | null;
}

/** A 'running' run older than this is treated as dead (dyno restart) and no longer blocks the nightly jobs. */
export const staleBackfillRunMinutes = 30;

export function buildInitialBackfillSteps(): BackfillStep[] {
  return [
    { key: "history", label: "Price and implied-volatility history (5 years)", status: "pending", message: null },
    { key: "calendar", label: "Earnings and dividend calendar", status: "pending", message: null },
    { key: "chain_warmup", label: "Option chain strikes (0-90 days)", status: "pending", message: null },
    { key: "first_snapshot", label: "First option chain snapshot", status: "pending", message: null },
  ];
}

/** Each step is worth an equal share; a step counts once it is no longer pending/running. */
export function computeProgressPercent(steps: BackfillStep[]): number {
  if (steps.length === 0) return 0;
  const finished = steps.filter((step) => step.status === "done" || step.status === "skipped" || step.status === "failed").length;
  return Math.round((finished / steps.length) * 100);
}

export function updateStep(steps: BackfillStep[], key: BackfillStepKey, status: BackfillStepStatus, message: string | null): BackfillStep[] {
  return steps.map((step) => (step.key === key ? { ...step, status, message } : step));
}

/** Final status once every step has finished: partial if any step failed. */
export function deriveFinalRunStatus(steps: BackfillStep[]): Exclude<BackfillRunStatus, "running"> {
  return steps.some((step) => step.status === "failed") ? "partial" : "complete";
}
