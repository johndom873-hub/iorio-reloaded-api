// job_runs.status. "completed_with_errors": the run did its work but part of it had errors (TWST without IV, the other
// 25 of 26 tickers complete), so the output is usable with gaps. "failure": the run crashed or produced nothing usable.
export type JobRunStatus = "running" | "success" | "failure" | "completed_with_errors";

/** "1 error" / "3 errors": the stored error_message of a completed_with_errors run starts with it. */
export function formatJobErrorCount(errorCount: number): string {
  return errorCount === 1 ? "1 error" : `${errorCount} errors`;
}
