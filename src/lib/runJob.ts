import { db } from "../db/connection.js";
import { notifyTelegram } from "./notifyTelegram.js";

export interface JobResult {
  details?: Record<string, unknown>;
  /** If set, sent via Telegram on success — e.g. "Trade Alerts: 5 new alerts." Omit for quiet successes. */
  notify?: string;
}

/**
 * Shared wrapper for scheduled jobs — writes a job_runs row (fail-safe
 * ordering: DB write always happens first, Telegram attempted after, so a
 * Telegram outage can never mask a job result or crash the job itself —
 * see PROGRESS.md's Telegram notification rules). On failure, always
 * notifies. On success, only notifies if the job explicitly asks to
 * (result.notify) — most jobs are quiet unless there's something to act on.
 */
export async function runJob(jobName: string, fn: () => Promise<JobResult>): Promise<void> {
  const startedAt = new Date();
  const [run] = await db("job_runs").insert({ job_name: jobName, started_at: startedAt, status: "running" }).returning("*");

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
