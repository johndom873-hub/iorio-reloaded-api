// Outcome rule for scripts/run-daily-pnl-snapshot-job.ts. The account-level row is the night's P&L record and the position
// rows depend on one price fetch, so losing either is a failed run; a narrower gap (some positions, the greeks, the Flex
// reconcile, an account value) leaves the rest usable and completes with errors.

import type { JobResult } from "./runJob.js";

export interface PnlSnapshotProblem {
  message: string;
  /** How many errors this problem counts for (one per skipped position or leg without greeks, one otherwise). */
  errorCount: number;
  /** True when the night's record is missing: no account-level row, or no position snapshots at all. */
  nothingUsable: boolean;
}

export function buildPnlSnapshotJobOutcome(problems: PnlSnapshotProblem[]): Pick<JobResult, "failureMessage" | "completedWithErrors"> {
  if (problems.length === 0) return {};
  const message = problems.map((problem) => problem.message).join("; ");
  if (problems.some((problem) => problem.nothingUsable)) return { failureMessage: message };
  return { completedWithErrors: { errorCount: problems.reduce((total, problem) => total + problem.errorCount, 0), message } };
}
