import { db } from "../db/connection.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";
import { formatDurationHuman } from "./formatDurationHuman.js";
import { formatEasternDateTime } from "./easternIsoDate.js";
import { publishNotification } from "./notificationChannel.js";
import { clearDownState, notifyDownThrottled } from "./throttledAlert.js";
import { formatJobErrorCount, type JobRunStatus } from "./jobRunStatus.js";

/** Telegram text when a new run finds the previous one still marked "running" long after it should have ended. Times are Eastern. */
export function buildJobDiedMidRunMessage(jobName: string, previousRunStartedAt: Date): string {
  return `⚠️ ${jobName} died mid-run: the run started ${formatEasternDateTime(previousRunStartedAt)} never finished (process killed or out of memory). A new run is starting.`;
}

/** Telegram text when a job succeeds after one or more failed attempts. Times are Eastern. */
export function buildJobRecoveredMessage(jobName: string, attempts: string, failingSince: Date, downtime: string): string {
  return `✅ ${jobName} recovered after ${attempts} (was down since ${formatEasternDateTime(failingSince)}, ~${downtime}).`;
}

/** Telegram text when a job runs clean after one or more runs that completed with errors. Times are Eastern. */
export function buildJobCompletedCleanAgainMessage(jobName: string, runsWithErrors: number, sinceStartedAt: Date): string {
  const previousRuns = runsWithErrors === 1 ? `the previous run (${formatEasternDateTime(sinceStartedAt)})` : `the previous ${runsWithErrors} runs (since ${formatEasternDateTime(sinceStartedAt)})`;
  return `✅ ${jobName} completed with no errors; ${previousRuns} completed with errors.`;
}

/** The text stored in job_runs.error_message for a completed_with_errors run, and the body of its alert. */
export function buildCompletedWithErrorsText(completedWithErrors: { errorCount: number; message: string }): string {
  return `${formatJobErrorCount(completedWithErrors.errorCount)}: ${completedWithErrors.message}`;
}

export interface JobResult {
  details?: Record<string, unknown>;
  /** If set, sent via Telegram on success — a short summary of what the run produced. Omit for quiet successes. */
  notify?: string;
  /**
   * Set when the job ran to the end but part of its work failed (e.g. some tickers): recorded as
   * a failure, with `details` kept and the usual failure alert, instead of a "success" that hides it.
   */
  failureMessage?: string;
  /**
   * Set when the job did its work but part of it had errors (one ticker of 26 without IV): recorded as
   * completed_with_errors, with the usual alert. `message` names the errors and how much was complete.
   * Use failureMessage instead when nothing usable was produced.
   */
  completedWithErrors?: { errorCount: number; message: string };
}

export interface RunJobOptions {
  triggeredBy?: "scheduler" | "manual";
  triggeredByUserId?: string;
  /**
   * For jobs that can keep failing for hours (e.g. ibkr_health_check during an
   * IBKR outage): alert on the first failure, then at most once per this many
   * ms while it keeps failing with the same message (see throttledAlert.ts).
   * Unset = alert on every failure (the default for once-a-day jobs).
   */
  failureAlertReminderIntervalMs?: number;
  /**
   * How long a "running" row may go without finishing before a new run treats
   * it as abandoned (crashed process) and supersedes it. Must exceed the
   * job's longest legitimate run, or a manual re-trigger mid-run starts a
   * second concurrent copy — the option_chain_capture takes ~20 minutes for
   * 21 tickers, so it passes its own ceiling. Unset = defaultStaleRunningJobThresholdMs.
   */
  staleRunningJobThresholdMs?: number;
}

// Thrown instead of starting a second concurrent run of the same job —
// overlapping runs of an IBKR-heavy job (a repeated "Run Now" click on top
// of the scheduled run) each request market data for the same contracts,
// enough to exhaust the login's shared line quota and starve every run.
export class JobAlreadyRunningError extends Error {
  constructor(jobName: string) {
    super(`${jobName} is already running.`);
    this.name = "JobAlreadyRunningError";
  }
}

// Errors runJob has already reported to Telegram, so the script-level catch (runScript.ts)
// does not send a second alert for the same failure.
const alertedErrors = new WeakSet<object>();

export function wasErrorAlerted(error: unknown): boolean {
  return typeof error === "object" && error !== null && alertedErrors.has(error);
}

function markErrorAlerted(error: unknown): void {
  if (typeof error === "object" && error !== null) alertedErrors.add(error);
}

/** An AggregateError (a refused connection) has an empty message: fall back to its code or name so an alert is never blank. */
function describeThrown(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return error.message || (typeof code === "string" ? code : "") || error.name;
}

/**
 * The failure alert must go out even when the database is the thing that failed: the throttled variant
 * needs alert_state, so if it throws, fall back to a plain send.
 */
async function sendFailureAlert(jobName: string, failureAlert: string, options: RunJobOptions): Promise<void> {
  if (options.failureAlertReminderIntervalMs === undefined) {
    await notifyTelegramTracked(failureAlert);
    return;
  }
  try {
    await notifyDownThrottled(`job_failure:${jobName}`, failureAlert, options.failureAlertReminderIntervalMs);
  } catch (error) {
    console.error(`${jobName}: throttled failure alert failed, sending it directly — ${error instanceof Error ? error.message : error}`);
    await notifyTelegram(failureAlert);
  }
}

// A scheduled run that never starts because the previous one still looks alive is a missed
// run, so it alerts; a manual "Run Now" already shows the error to the person who clicked.
async function alertScheduledRunSkipped(jobName: string, options: RunJobOptions): Promise<void> {
  if ((options.triggeredBy ?? "scheduler") !== "scheduler") return;
  const message = `⚠️ ${jobName} was skipped: its previous run is still marked "running", so this scheduled run did not start.`;
  if (options.failureAlertReminderIntervalMs !== undefined) await notifyDownThrottled(`job_skipped:${jobName}`, message, options.failureAlertReminderIntervalMs);
  else await notifyTelegramTracked(message);
}

async function throwJobAlreadyRunning(jobName: string, options: RunJobOptions): Promise<never> {
  const error = new JobAlreadyRunningError(jobName);
  await alertScheduledRunSkipped(jobName, options);
  markErrorAlerted(error);
  throw error;
}

/**
 * Shared wrapper for scheduled jobs — writes a job_runs row (fail-safe
 * ordering: DB write always happens first, Telegram attempted after, so a
 * Telegram outage can never mask a job result or crash the job itself —
 * see PROGRESS.md's Telegram notification rules). On failure, always
 * notifies (with a short summary — see telegramFailureSummary — while the
 * full message still lands in job_runs.error_message); same for a run that
 * completed with errors. On success, also notifies if this run ends a
 * contiguous run of failures or of runs with errors (see
 * findPrecedingProblemStreak), so a recovery is never silent; additionally
 * notifies if the job explicitly asks to (result.notify) — most jobs are
 * otherwise quiet unless there's something to act on.
 *
 * Refuses to start a second concurrent run of the same jobName — see
 * JobAlreadyRunningError above. Exception: a "running" row older than
 * staleRunningJobThresholdMs is treated as abandoned (left behind by a
 * process that died without reaching this function's own try/catch, e.g.
 * SIGKILL/OOM — the SIGTERM handler in installShutdownHandler.ts covers the
 * graceful-restart case, but nothing catches a hard kill) rather than a
 * real overlapping run, and is superseded instead of blocking the new one.
 */
export const defaultStaleRunningJobThresholdMs = 15 * 60 * 1000;

// Exported (alongside findPrecedingProblemStreak below) so a one-off replay
// script (e.g. tmp/simulateJobNotifications.ts) can reuse the exact same
// notification logic against real job_runs history instead of a hand-copied
// reimplementation that could silently drift from what actually ships.
//
// A failure message's diagnostic sentence sits before the first "): " —
// everything after that (a restart script's raw docker-log dump, in every
// case seen so far) is only useful for the job_runs record, not a phone
// notification. error_message in the DB always keeps the full text; this
// only shortens what's sent to Telegram. Falls back to the full message
// unchanged when there's no such marker (plain error messages with no
// appended dump), so this can never lose content, only trim noise.
export function telegramFailureSummary(message: string): string {
  const cutIndex = message.indexOf("): ");
  if (cutIndex === -1) return message;
  const summary = message.slice(0, cutIndex + 1);
  return `${summary} (see job_runs for full output)`;
}

// Looks back through this job's run history (immediately before the run
// that just succeeded) and counts the contiguous trailing streak of runs with
// the same problem status as the latest one: failures, or runs that completed
// with errors. Used to turn a recovery into a real Telegram notification
// instead of silence — see PROGRESS.md's Telegram notification rules.
export async function findPrecedingProblemStreak(
  jobName: string,
  currentRunId: string,
  before: Date,
): Promise<{ status: Extract<JobRunStatus, "failure" | "completed_with_errors">; runCount: number; sinceStartedAt: Date } | null> {
  const priorRuns: { status: JobRunStatus; started_at: Date }[] = await db("job_runs")
    .where({ job_name: jobName })
    .andWhere("started_at", "<", before)
    .andWhereNot({ id: currentRunId })
    .orderBy("started_at", "desc")
    .limit(200);

  const streakStatus = priorRuns[0]?.status;
  if (streakStatus !== "failure" && streakStatus !== "completed_with_errors") return null;
  let runCount = 0;
  let sinceStartedAt = priorRuns[0]!.started_at;
  for (const run of priorRuns) {
    if (run.status !== streakStatus) break;
    runCount++;
    sinceStartedAt = run.started_at;
  }
  return { status: streakStatus, runCount, sinceStartedAt };
}

export async function runJob(jobName: string, fn: () => Promise<JobResult>, options: RunJobOptions = {}): Promise<void> {
  const staleRunningJobThresholdMs = options.staleRunningJobThresholdMs ?? defaultStaleRunningJobThresholdMs;
  const alreadyRunning = await db("job_runs").where({ job_name: jobName, status: "running" }).first();
  if (alreadyRunning) {
    const ageMs = Date.now() - new Date(alreadyRunning.started_at).getTime();
    if (ageMs < staleRunningJobThresholdMs) return throwJobAlreadyRunning(jobName, options);

    // finished_at = started_at, not now(): the real end is unknown, and
    // stamping the moment of discovery made System Health show the gap as
    // the run's duration (the UI renders "unknown" for abandoned rows).
    await db("job_runs")
      .where({ id: alreadyRunning.id })
      .update({
        status: "failure",
        finished_at: alreadyRunning.started_at,
        error_message: `Abandoned: still "running" after ${Math.round(ageMs / 1000)}s with no update -- likely a crashed process. Superseded by a new run.`,
      });
    await notifyTelegramTracked(buildJobDiedMidRunMessage(jobName, new Date(alreadyRunning.started_at)));
  }

  const startedAt = new Date();
  let run: { id: string };
  try {
    [run] = await db("job_runs")
      .insert({
        job_name: jobName,
        started_at: startedAt,
        status: "running",
        triggered_by: options.triggeredBy ?? "scheduler",
        triggered_by_user_id: options.triggeredByUserId ?? null,
      })
      .returning("*");
  } catch (error) {
    // Postgres unique_violation on job_runs_one_running_per_job (partial
    // unique index, migration 20260831000002) — the pre-check above raced
    // with another caller's insert, e.g. the scheduled run and a "Run Now"
    // click landing in the same second.
    if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
      return throwJobAlreadyRunning(jobName, options);
    }
    throw error;
  }

  // Published only after the job_runs insert succeeds — a run that instead
  // hits JobAlreadyRunningError above never reaches here, so Latest Events
  // never shows a "started" entry for a run that didn't actually start.
  await publishNotification({ type: "job_started", jobName }).catch(() => {});

  let result: JobResult;
  try {
    result = await fn();
  } catch (thrown) {
    // A non-Error throw (a string, null) cannot carry the "already alerted" marker, so normalise it.
    const error =
      thrown instanceof Error
        ? thrown
        : new Error(typeof thrown === "object" && thrown !== null && "message" in thrown ? String((thrown as { message: unknown }).message) : String(thrown));
    const message = describeThrown(error);
    // The alert below must go out even when the database is the thing that failed.
    await db("job_runs").where({ id: run.id }).update({ status: "failure", finished_at: db.fn.now(), error_message: message }).catch((writeError) => console.error(`${jobName}: could not record the failure in job_runs — ${writeError instanceof Error ? writeError.message : writeError}`));
    await publishNotification({ type: "job_completed", jobName, status: "failure" }).catch(() => {});
    await sendFailureAlert(jobName, `⚠️ ${jobName} failed: ${telegramFailureSummary(message)}`, options);
    markErrorAlerted(error);
    throw error;
  }

  // A run that failed, or did its work with errors on part of it: both keep their details and alert every time.
  const problemOutcome: { status: "failure" | "completed_with_errors"; errorMessage: string; alert: string } | null = result.failureMessage
    ? // Sent whole, not cut at the first "): " like a thrown error's message: jobs build failureMessage as a
      // deliberate one-line summary, but it embeds raw IBKR/API error text that contains "): " and would
      // otherwise drop every problem listed after it. Telegram's own length limit still applies.
      { status: "failure", errorMessage: result.failureMessage, alert: `⚠️ ${jobName} failed: ${result.failureMessage}` }
    : result.completedWithErrors
      ? { status: "completed_with_errors", errorMessage: buildCompletedWithErrorsText(result.completedWithErrors), alert: `⚠️ ${jobName} completed with ${buildCompletedWithErrorsText(result.completedWithErrors)}` }
      : null;
  if (problemOutcome) {
    const { status, errorMessage } = problemOutcome;
    // Guarded like the catch path: the alert below is the point, the row is the record. If the row with its details
    // cannot be written (details that will not serialise), record the outcome without them rather than leave the row "running".
    await db("job_runs")
      .where({ id: run.id })
      .update({ status, finished_at: db.fn.now(), details: result.details ?? null, error_message: errorMessage })
      .catch(async (writeError) => {
        console.error(`${jobName}: could not record the ${status} with its details in job_runs — ${writeError instanceof Error ? writeError.message : writeError}`);
        await db("job_runs")
          .where({ id: run.id })
          .update({ status, finished_at: db.fn.now(), error_message: errorMessage })
          .catch((retryError) => console.error(`${jobName}: could not record the ${status} in job_runs — ${retryError instanceof Error ? retryError.message : retryError}`));
      });
    await publishNotification({ type: "job_completed", jobName, status }).catch(() => {});
    await sendFailureAlert(jobName, problemOutcome.alert, options);
    if (result.notify) await notifyTelegramTracked(result.notify);
    return;
  }

  try {
    await db("job_runs")
      .where({ id: run.id })
      .update({ status: "success", finished_at: db.fn.now(), details: result.details ?? null });
  } catch (writeError) {
    const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
    await notifyTelegramTracked(`⚠️ ${jobName} finished but its result could not be recorded in job_runs (${writeMessage.split("\n")[0]}). The row stays "running".`);
    markErrorAlerted(writeError);
    throw writeError;
  }
  await publishNotification({ type: "job_completed", jobName, status: "success" }).catch(() => {});

  if (options.failureAlertReminderIntervalMs !== undefined) {
    await clearDownState(`job_failure:${jobName}`);
    await clearDownState(`job_skipped:${jobName}`);
  }

  const problemStreak = await findPrecedingProblemStreak(jobName, run.id, startedAt);
  if (problemStreak?.status === "failure") {
    const attempts = problemStreak.runCount === 1 ? "1 failed attempt" : `${problemStreak.runCount} failed attempts`;
    const downtime = formatDurationHuman(Date.now() - problemStreak.sinceStartedAt.getTime());
    await notifyTelegramTracked(buildJobRecoveredMessage(jobName, attempts, problemStreak.sinceStartedAt, downtime));
  } else if (problemStreak?.status === "completed_with_errors") {
    await notifyTelegramTracked(buildJobCompletedCleanAgainMessage(jobName, problemStreak.runCount, problemStreak.sinceStartedAt));
  }

  if (result.notify) {
    await notifyTelegramTracked(result.notify);
  }
}
