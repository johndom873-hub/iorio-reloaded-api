import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import type { BacktestJobKind, BacktestJobStatus, BacktestJobView } from "../backtestTypes.js";
import {
  appendProgressSample,
  computeJobRunSeconds,
  deriveJobDisplayStatus,
  estimateSecondsLeft,
  finishedJobListingDays,
  staleHeartbeatMilliseconds,
  type ProgressSample,
} from "./backtestJobRules.js";
import { spawnBacktestJobProcess, terminateLeftoverJobProcesses } from "./spawnBacktestJobProcess.js";

// The backtest_jobs lifecycle the API drives (docs/backtesting/DATA-FILES.md): create, queue, start, cancel, resume.
// The job process itself (executeBacktestJob.ts) writes running, progress, heartbeat and the outcome.

/** A request the job's current state does not allow; the route answers with `httpStatus`. */
export class BacktestRequestError extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "BacktestRequestError";
  }
}

export interface BacktestJobRow {
  id: string;
  kind: BacktestJobKind;
  symbol: string;
  session_id: string | null;
  session_name: string | null;
  start_date: string | null;
  end_date: string | null;
  status: BacktestJobStatus;
  progress_done: number;
  progress_total: number;
  progress_label: string | null;
  cancel_requested: boolean;
  pid: number | null;
  error: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  earlier_run_seconds: number;
}

function selectJobRows(connection: Knex = db): Knex.QueryBuilder {
  return connection("backtest_jobs as j")
    .leftJoin("backtest_sessions as s", "s.id", "j.session_id")
    .select(
      "j.id",
      "j.kind",
      "j.symbol",
      "j.session_id",
      "s.name as session_name",
      connection.raw("j.start_date::text as start_date"),
      connection.raw("j.end_date::text as end_date"),
      "j.status",
      "j.progress_done",
      "j.progress_total",
      "j.progress_label",
      "j.cancel_requested",
      "j.pid",
      "j.error",
      "j.heartbeat_at",
      "j.created_at",
      "j.started_at",
      "j.finished_at",
      "j.earlier_run_seconds",
    );
}

const isoTimestamp = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

// The recent pace of each running job, observed whenever a view is built (the screen polls the overview). In memory:
// after an API restart the estimate is back after two heartbeats.
const progressSamplesByJobId = new Map<string, ProgressSample[]>();

function estimateJobSecondsLeft(row: BacktestJobRow): number | null {
  if (!row.heartbeat_at) return null;
  const samples = appendProgressSample(progressSamplesByJobId.get(row.id) ?? [], { atMilliseconds: new Date(row.heartbeat_at).getTime(), done: row.progress_done });
  progressSamplesByJobId.set(row.id, samples);
  // A backtest starts from zero, so until the samples show a pace the average since its start stands in.
  const paceSamples = samples.length < 2 && row.kind === "backtest" && row.started_at ? [{ atMilliseconds: new Date(row.started_at).getTime(), done: 0 }, ...samples] : samples;
  return estimateSecondsLeft(paceSamples, row.progress_done, row.progress_total);
}

export function toBacktestJobView(row: BacktestJobRow, now: Date = new Date()): BacktestJobView {
  const displayStatus = deriveJobDisplayStatus(row.status, row.heartbeat_at ? new Date(row.heartbeat_at) : null, now);
  if (displayStatus !== "running") progressSamplesByJobId.delete(row.id);
  return {
    id: row.id,
    kind: row.kind,
    symbol: row.symbol,
    sessionId: row.session_id,
    sessionName: row.session_name,
    status: row.status,
    displayStatus,
    progressDone: Number(row.progress_done),
    progressTotal: Number(row.progress_total),
    progressLabel: row.progress_label,
    etaSeconds: displayStatus === "running" ? estimateJobSecondsLeft(row) : null,
    runSeconds: computeJobRunSeconds(
      { earlierRunSeconds: Number(row.earlier_run_seconds ?? 0), startedAt: row.started_at ? new Date(row.started_at) : null, finishedAt: row.finished_at ? new Date(row.finished_at) : null, heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at) : null },
      displayStatus,
      now,
    ),
    heartbeatAt: isoTimestamp(row.heartbeat_at),
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: isoTimestamp(row.started_at),
    finishedAt: isoTimestamp(row.finished_at),
    error: row.error,
  };
}

export async function loadBacktestJobRow(jobId: string, connection: Knex = db): Promise<BacktestJobRow | null> {
  const row = await selectJobRows(connection).where("j.id", jobId).first();
  return (row as BacktestJobRow | undefined) ?? null;
}

export async function loadBacktestJobView(jobId: string): Promise<BacktestJobView> {
  const row = await loadBacktestJobRow(jobId);
  if (!row) throw new BacktestRequestError("No such job.", 404);
  return toBacktestJobView(row);
}

/** The overview's jobs, newest first: everything not finished, plus what finished in the last week. */
export async function listOverviewJobViews(): Promise<BacktestJobView[]> {
  const rows: BacktestJobRow[] = await selectJobRows()
    .where((query) =>
      query
        .whereIn("j.status", ["queued", "running"])
        .orWhereNull("j.finished_at")
        .orWhere("j.finished_at", ">", db.raw("now() - (?::int * interval '1 day')", [finishedJobListingDays])),
    )
    .orderBy("j.created_at", "desc");
  const now = new Date();
  return rows.map((row) => toBacktestJobView(row, now));
}

export async function loadLatestJobViewForSession(sessionId: string): Promise<BacktestJobView | null> {
  const row = await selectJobRows().where("j.session_id", sessionId).orderBy("j.created_at", "desc").first();
  return row ? toBacktestJobView(row as BacktestJobRow) : null;
}

/** Marks a job as started by the API before its process exists, so it is never started twice. */
async function claimJob(connection: Knex, jobId: string, options: { resetProgress: boolean }): Promise<void> {
  await connection("backtest_jobs")
    .where({ id: jobId })
    .update({
      status: "running",
      pid: null,
      cancel_requested: false,
      error: null,
      finished_at: null,
      heartbeat_at: connection.fn.now(),
      started_at: connection.fn.now(),
      ...(options.resetProgress ? { progress_done: 0, progress_total: 0, progress_label: null } : {}),
    });
}

/** Sets a session's outcome when its job ends without the engine doing it (cancelled before it ran, or failed to start). */
export async function finishSessionOfJob(sessionId: string, status: "failed" | "cancelled", error: string | null, connection: Knex = db): Promise<void> {
  await connection("backtest_sessions").where({ id: sessionId }).whereIn("status", ["queued", "running"]).update({ status, error, finished_at: connection.fn.now() });
}

async function spawnClaimedJob(jobId: string): Promise<void> {
  try {
    const pid = spawnBacktestJobProcess(jobId);
    await db("backtest_jobs").where({ id: jobId, status: "running" }).whereNull("pid").update({ pid });
  } catch (error) {
    const message = `The job process could not be started: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`Backtest job ${jobId}: ${message}`);
    const [row] = await db("backtest_jobs").where({ id: jobId }).update({ status: "failed", error: message, finished_at: db.fn.now() }).returning("session_id");
    if (row?.session_id) await finishSessionOfJob(row.session_id, "failed", message);
  }
}

/**
 * Starts the oldest queued download when no download is running (a stopped one does not count): one at a time, since
 * ThetaData allows 2 requests in flight and one download uses both. The advisory lock makes concurrent kicks (the
 * overview, a finishing job) take turns. Returns the started job's id.
 */
export async function kickDownloadQueue(): Promise<string | null> {
  const startedJobId = await db.transaction(async (transaction) => {
    await transaction.raw("SELECT pg_advisory_xact_lock(hashtext('backtest_download_queue'))");
    const running = await transaction("backtest_jobs")
      .where({ kind: "download", status: "running" })
      .where("heartbeat_at", ">", transaction.raw("now() - (?::int * interval '1 millisecond')", [staleHeartbeatMilliseconds]))
      .first("id");
    if (running) return null;
    const next = await transaction("backtest_jobs").where({ kind: "download", status: "queued" }).orderBy("created_at", "asc").first("id");
    if (!next) return null;
    await claimJob(transaction, next.id as string, { resetProgress: false });
    return next.id as string;
  });
  if (startedJobId) await spawnClaimedJob(startedJobId);
  return startedJobId;
}

/** A download not finished yet (queued, running or stopped) for the symbol, if any. */
export async function findUnfinishedDownloadJob(symbol: string): Promise<BacktestJobRow | null> {
  const row = await selectJobRows().where({ "j.kind": "download", "j.symbol": symbol }).whereIn("j.status", ["queued", "running"]).orderBy("j.created_at", "desc").first();
  return (row as BacktestJobRow | undefined) ?? null;
}

/** Queues a download and kicks the queue: it starts now when no other download runs. */
export async function createDownloadJob(input: { symbol: string; startDate: string; endDate: string }): Promise<BacktestJobView> {
  const [row] = await db("backtest_jobs").insert({ kind: "download", symbol: input.symbol, start_date: input.startDate, end_date: input.endDate, status: "queued" }).returning("id");
  await kickDownloadQueue();
  return loadBacktestJobView(row.id as string);
}

/** Inserts a session's backtest job already claimed (backtests do not queue); startClaimedBacktestJob then starts its process. */
export async function insertClaimedBacktestJob(sessionId: string, symbol: string, connection: Knex = db): Promise<string> {
  const [row] = await connection("backtest_jobs")
    .insert({ kind: "backtest", symbol, session_id: sessionId, status: "running", heartbeat_at: connection.fn.now(), started_at: connection.fn.now() })
    .returning("id");
  return row.id as string;
}

export async function startClaimedBacktestJob(jobId: string): Promise<void> {
  await spawnClaimedJob(jobId);
}

/**
 * Cancel: a queued or stopped job is cancelled here (and what is left of a stopped one's process is stopped); a running
 * one is asked to stop and its process ends it as cancelled.
 */
export async function cancelBacktestJob(jobId: string): Promise<BacktestJobView> {
  const job = await loadBacktestJobRow(jobId);
  if (!job) throw new BacktestRequestError("No such job.", 404);
  const displayStatus = deriveJobDisplayStatus(job.status, job.heartbeat_at ? new Date(job.heartbeat_at) : null, new Date());
  if (displayStatus === "running") {
    await db("backtest_jobs").where({ id: jobId, status: "running" }).update({ cancel_requested: true });
  } else if (displayStatus === "queued" || displayStatus === "stopped") {
    terminateLeftoverJobProcesses(job.pid, jobId);
    await db("backtest_jobs").where({ id: jobId, status: job.status }).update({ status: "cancelled", finished_at: db.fn.now() });
    if (job.session_id) await finishSessionOfJob(job.session_id, "cancelled", null);
    if (job.kind === "download") await kickDownloadQueue();
  } else {
    throw new BacktestRequestError("This job has already finished.", 409);
  }
  return loadBacktestJobView(jobId);
}

/**
 * Resume (stopped, failed or cancelled jobs): the same job id starts again. A download goes back in the queue and
 * continues where its file stops; a backtest re-runs its session from scratch.
 */
export async function resumeBacktestJob(jobId: string): Promise<BacktestJobView> {
  const job = await loadBacktestJobRow(jobId);
  if (!job) throw new BacktestRequestError("No such job.", 404);
  const displayStatus = deriveJobDisplayStatus(job.status, job.heartbeat_at ? new Date(job.heartbeat_at) : null, new Date());
  if (displayStatus === "succeeded") throw new BacktestRequestError("This job finished: there is nothing to resume.", 409);
  if (displayStatus === "queued" || displayStatus === "running") throw new BacktestRequestError("This job is already running or waiting to start.", 409);
  if (job.kind === "backtest" && !job.session_id) throw new BacktestRequestError("This backtest job has no session.", 409);

  terminateLeftoverJobProcesses(job.pid, jobId);
  if (job.kind === "download") {
    // The run that just ended counts toward the total: it ran from started_at to its finish, else its last heartbeat.
    await db("backtest_jobs")
      .where({ id: jobId })
      .update({
        earlier_run_seconds: db.raw("earlier_run_seconds + CASE WHEN started_at IS NULL THEN 0 ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (COALESCE(finished_at, heartbeat_at, started_at) - started_at))))::integer END"),
        status: "queued",
        pid: null,
        cancel_requested: false,
        error: null,
        finished_at: null,
        heartbeat_at: null,
      });
    await kickDownloadQueue();
  } else {
    await db("backtest_sessions").where({ id: job.session_id }).update({ status: "queued", error: null, finished_at: null });
    // A backtest runs again from its first day, so its run time starts again too.
    await db("backtest_jobs").where({ id: jobId }).update({ earlier_run_seconds: 0 });
    await claimJob(db, jobId, { resetProgress: true });
    await spawnClaimedJob(jobId);
  }
  return loadBacktestJobView(jobId);
}

/** Before a session is deleted: its unfinished jobs are asked to stop and their processes signalled. */
export async function stopJobsOfSession(sessionId: string): Promise<void> {
  const jobs: { id: string; pid: number | null }[] = await db("backtest_jobs").where({ session_id: sessionId }).whereIn("status", ["queued", "running"]).select("id", "pid");
  for (const job of jobs) {
    await db("backtest_jobs").where({ id: job.id }).update({ cancel_requested: true });
    terminateLeftoverJobProcesses(job.pid, job.id);
  }
}
