// Pure decisions for the release phase (scripts/run-release-phase.ts), kept apart from its
// database/SSH/Heroku I/O so they are unit-testable.

/** What the trading worker on the VPS is running after the release's worker step. */
export type WorkerStateAfterStep =
  /** The deploy never started (no SSH session, or no deploy needed): the worker runs the previous code. */
  | "untouched"
  /** The VPS deploy script reported rolled_back: the worker switched itself back to the previous build. */
  | "reverted"
  /** The SSH session broke or timed out mid-deploy, or gave no result line: the worker may run either build. */
  | "unknown";

export type WorkerDeployResultKind = "deployed" | "skipped_no_new_commit" | "rolled_back" | "unparseable";

export interface WorkerDeployResult {
  kind: WorkerDeployResultKind;
  /** The rest of the DEPLOY_RESULT line, e.g. "PREVIOUS=… CURRENT=…". */
  detail: string;
  /** The commit the worker runs after a successful step (CURRENT=), null otherwise. */
  runningCommit: string | null;
}

/** Reads the `DEPLOY_RESULT=<kind> KEY=value…` line the VPS deploy scripts print last. */
export function parseWorkerDeployResult(output: string): WorkerDeployResult {
  const resultLine = output.match(/^DEPLOY_RESULT=(\S+)(.*)$/m);
  const rawKind = resultLine?.[1];
  const detail = resultLine?.[2]?.trim() ?? "";
  const kind: WorkerDeployResultKind = rawKind === "deployed" || rawKind === "skipped_no_new_commit" || rawKind === "rolled_back" ? rawKind : "unparseable";
  const runningCommit = kind === "deployed" || kind === "skipped_no_new_commit" ? (detail.match(/(?:^|\s)CURRENT=(\S+)/)?.[1] ?? null) : null;
  return { kind, detail, runningCommit };
}

const connectionLevelErrorCodes = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

/**
 * An SSH failure before the session started leaves the worker untouched (the VPS never ran the
 * deploy script). Anything else (our own timeout, a reset mid-session) may have interrupted a
 * build or a swap, so the worker's state is unknown.
 */
export function workerStateAfterSshError(error: unknown, timeoutMessage: string): WorkerStateAfterStep {
  if (!(error instanceof Error)) return "unknown";
  if (error.message === timeoutMessage) return "unknown";
  const code = (error as { code?: unknown }).code;
  const level = (error as { level?: unknown }).level;
  if (typeof code === "string" && connectionLevelErrorCodes.has(code)) return "untouched";
  if (level === "client-authentication" || /handshake/i.test(error.message)) return "untouched";
  return "unknown";
}

export type RestoreDecision = { restore: true } | { restore: false; reason: string };

/**
 * After a failure that follows the migrations, restore the backup only when doing so cannot lose
 * real trading records or leave the worker on code that expects the new schema.
 */
export function decideRestoreAfterFailedRelease(inputs: { workerState: WorkerStateAfterStep; tradingRowsWrittenSinceBackup: number }): RestoreDecision {
  if (inputs.workerState === "unknown") {
    return { restore: false, reason: "the worker deploy was interrupted, so the worker may already run the new code, which needs the new database" };
  }
  if (inputs.tradingRowsWrittenSinceBackup > 0) {
    return { restore: false, reason: `${inputs.tradingRowsWrittenSinceBackup} order/trade record(s) were written after the backup, and restoring would erase them` };
  }
  return { restore: true };
}

export const injectedReleaseFailureVariable = "RELEASE_PHASE_TEST_FAILURE";

/**
 * Staging-only switch that makes the release fail right after the migrations, to exercise the
 * backup restore end to end. Ignored outside staging; an unknown value fails the release on
 * staging instead of being silently ignored.
 */
export function readInjectedReleaseFailure(value: string | undefined, appEnvironment: string): "after_migrations" | null {
  if (!value || appEnvironment !== "staging") return null;
  if (value === "after_migrations") return value;
  throw new Error(`${injectedReleaseFailureVariable} must be "after_migrations" or unset, got: ${value}`);
}
