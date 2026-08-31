import { db } from "../db/connection.js";
import { notifyTelegram } from "./notifyTelegram.js";

export interface JobResult {
  details?: Record<string, unknown>;
  /** If set, sent via Telegram on success — e.g. "Trade Alerts: 5 new alerts." Omit for quiet successes. */
  notify?: string;
}

export interface RunJobOptions {
  triggeredBy?: "scheduler" | "manual";
  triggeredByUserId?: string;
}

// Thrown instead of starting a second concurrent run of the same job —
// found necessary 2026-08-31 when repeated "Run Now" clicks on Trade Alerts
// (nothing was rendering on screen, so the button got clicked several times)
// stacked multiple simultaneous IBKR option-chain scans on top of the
// nightly scheduled run, each opening its own Gateway connection and
// requesting live greeks for the same ~100+ contracts per ticker — enough
// concurrent market-data lines to exhaust the Gateway's shared quota and
// leave every scan (including ones already in flight) getting back 0/N
// contracts with price+delta for the rest of the session.
export class JobAlreadyRunningError extends Error {
  constructor(jobName: string) {
    super(`${jobName} is already running.`);
    this.name = "JobAlreadyRunningError";
  }
}

/**
 * Shared wrapper for scheduled jobs — writes a job_runs row (fail-safe
 * ordering: DB write always happens first, Telegram attempted after, so a
 * Telegram outage can never mask a job result or crash the job itself —
 * see PROGRESS.md's Telegram notification rules). On failure, always
 * notifies. On success, only notifies if the job explicitly asks to
 * (result.notify) — most jobs are quiet unless there's something to act on.
 *
 * Refuses to start a second concurrent run of the same jobName — see
 * JobAlreadyRunningError above.
 */
export async function runJob(jobName: string, fn: () => Promise<JobResult>, options: RunJobOptions = {}): Promise<void> {
  const alreadyRunning = await db("job_runs").where({ job_name: jobName, status: "running" }).first();
  if (alreadyRunning) throw new JobAlreadyRunningError(jobName);

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
    // Postgres unique_violation on job_runs_one_running_per_job — the
    // pre-check above raced with another caller's insert.
    if (error instanceof Error && "code" in error && (error as { code: string }).code === "23505") {
      throw new JobAlreadyRunningError(jobName);
    }
    throw error;
  }

  let result: JobResult;
  try {
    result = await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db("job_runs").where({ id: run.id }).update({ status: "failure", finished_at: db.fn.now(), error_message: message });
    await notifyTelegram(`⚠️ ${jobName} failed: ${message}`);
    throw error;
  }

  await db("job_runs")
    .where({ id: run.id })
    .update({ status: "success", finished_at: db.fn.now(), details: result.details ?? null });
  if (result.notify) {
    await notifyTelegram(result.notify);
  }
}
