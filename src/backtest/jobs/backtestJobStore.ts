import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import type { BacktestJobKind, BacktestJobStatus, BacktestJobView, BacktestSessionRunState } from "../backtestTypes.js";
import {
  appendProgressSample,
  computeJobRunSeconds,
  deriveJobDisplayStatus,
  estimateSecondsLeft,
  overviewJobsPerKind,
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
  put_first_at: Date | null;
  pause_requested: boolean;
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
      "j.put_first_at",
      "j.pause_requested",
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
    putFirst: row.status === "queued" && row.put_first_at !== null,
    // Only a running job pauses; a job that ended before its pause took effect is not pausing.
    pauseRequested: row.status === "running" && Boolean(row.pause_requested),
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

/** A job's latest activity: queued or resumed, started, last progress, finished. */
const latestActivitySql = "GREATEST(j.queued_at, COALESCE(j.started_at, j.queued_at), COALESCE(j.heartbeat_at, j.queued_at), COALESCE(j.finished_at, j.queued_at))";

/**
 * The order the download queue starts its jobs (kickDownloadQueue): the jobs put first, the latest put first at the top,
 * then the rest, the first to enter the queue (or re-enter it on a resume) first.
 */
const downloadQueueOrderSql = "put_first_at DESC NULLS LAST, queued_at, created_at, id";
const downloadQueueOrderColumns = ["queued_at", "created_at", "id"];

/** The overview's jobs: the Backtests list, then the Downloads list, each in its own order. */
export async function listOverviewJobViews(): Promise<BacktestJobView[]> {
  const now = new Date();
  const [backtestRows, downloadRows] = await Promise.all([listOverviewBacktestJobRows(), listOverviewDownloadJobRows(now)]);
  return [...backtestRows, ...downloadRows].map((row) => toBacktestJobView(row, now));
}

/** The Backtests list: the latest overviewJobsPerKind, finished or not, latest activity first. */
async function listOverviewBacktestJobRows(): Promise<BacktestJobRow[]> {
  const rows: BacktestJobRow[] = await selectJobRows().where("j.kind", "backtest").orderByRaw(`${latestActivitySql} DESC, j.created_at DESC`).limit(overviewJobsPerKind);
  return rows;
}

/**
 * The Downloads list: the running download, the stopped ones (latest activity first), the queue in the order it starts
 * them, then the finished ones, the last to end first. Every unfinished download is listed, however many; the finished
 * ones fill the list up to overviewJobsPerKind.
 */
async function listOverviewDownloadJobRows(now: Date): Promise<BacktestJobRow[]> {
  // Running or stopped as of `now`, the instant the views derive their displayStatus at, so each row's place matches its badge.
  const freshHeartbeatSince = new Date(now.getTime() - staleHeartbeatMilliseconds);
  const listOrderSql = [
    "CASE WHEN j.status = 'running' AND j.heartbeat_at >= ? THEN 0 WHEN j.status = 'running' THEN 1 WHEN j.status = 'queued' THEN 2 ELSE 3 END",
    "CASE WHEN j.status = 'queued' THEN j.put_first_at END DESC NULLS LAST",
    ...downloadQueueOrderColumns.map((column) => `CASE WHEN j.status = 'queued' THEN j.${column} END`),
    // When it ended; the running and stopped ones, and a finished one without finished_at, by their latest activity.
    `COALESCE(j.finished_at, ${latestActivitySql}) DESC`,
    "j.created_at DESC",
    "j.id DESC",
  ].join(", ");
  const listPlaces = db("backtest_jobs as j").where("j.kind", "download").select("j.id", db.raw(`row_number() OVER (ORDER BY ${listOrderSql}) AS place`, [freshHeartbeatSince]));
  const rows: BacktestJobRow[] = await selectJobRows()
    .join(listPlaces.as("listed"), "listed.id", "j.id")
    .where((listed) => listed.whereIn("j.status", ["queued", "running"]).orWhere("listed.place", "<=", overviewJobsPerKind))
    .orderBy("listed.place");
  return rows;
}

export async function loadLatestJobViewForSession(sessionId: string): Promise<BacktestJobView | null> {
  const row = await selectJobRows().where("j.session_id", sessionId).orderBy("j.created_at", "desc").first();
  return row ? toBacktestJobView(row as BacktestJobRow) : null;
}

/** Each session's latest job as the Sessions list shows it, by session id: the overview lists only the latest jobs. */
export async function loadLatestSessionRunStates(sessionIds: readonly string[]): Promise<Map<string, BacktestSessionRunState>> {
  if (sessionIds.length === 0) return new Map();
  const rows: Pick<BacktestJobRow, "session_id" | "status" | "heartbeat_at" | "progress_done" | "progress_total">[] = await db("backtest_jobs")
    .distinctOn("session_id")
    .whereIn("session_id", sessionIds)
    .orderBy([{ column: "session_id" }, { column: "created_at", order: "desc" }])
    .select("session_id", "status", "heartbeat_at", "progress_done", "progress_total");
  const now = new Date();
  return new Map(
    rows.map((row) => [
      row.session_id as string,
      {
        status: row.status,
        displayStatus: deriveJobDisplayStatus(row.status, row.heartbeat_at ? new Date(row.heartbeat_at) : null, now),
        progressDone: Number(row.progress_done),
        progressTotal: Number(row.progress_total),
      },
    ]),
  );
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
 * Starts the download first in the queue when no download is running (a stopped one does not count): one at a time, since
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
    const next = await transaction("backtest_jobs").where({ kind: "download", status: "queued" }).orderByRaw(downloadQueueOrderSql).first("id");
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

/**
 * Queues a download and kicks the queue: it starts now when no other download runs. putFirst puts it at the top of the
 * queue; pauseRunning also pauses the running download, which goes back into the queue right after it (putDownloadFirst).
 */
export async function createDownloadJob(input: { symbol: string; startDate: string; endDate: string; putFirst?: boolean; pauseRunning?: boolean }): Promise<BacktestJobView> {
  const jobId = await db.transaction(async (transaction) => {
    const [row] = await transaction("backtest_jobs").insert({ kind: "download", symbol: input.symbol, start_date: input.startDate, end_date: input.endDate, status: "queued" }).returning("id");
    if (input.putFirst) await putFirstInTransaction(transaction, row.id as string, input.pauseRunning === true);
    return row.id as string;
  });
  await kickDownloadQueue();
  return loadBacktestJobView(jobId);
}

/**
 * Puts a queued download at the top of the queue: it starts next, ahead of every other queued job. With pauseRunning, the
 * running download (if another one runs) is asked to stop and goes back into the queue right after this one, keeping
 * what it saved; this one starts once that has stopped, so the two never share ThetaData's single login.
 */
export async function putDownloadFirst(jobId: string, options: { pauseRunning: boolean }): Promise<BacktestJobView> {
  const job = await loadBacktestJobRow(jobId);
  if (!job) throw new BacktestRequestError("No such job.", 404);
  if (job.kind !== "download") throw new BacktestRequestError("Only downloads wait in a queue.", 409);
  if (deriveJobDisplayStatus(job.status, job.heartbeat_at ? new Date(job.heartbeat_at) : null, new Date()) !== "queued") throw new BacktestRequestError("Only a queued download can be put first.", 409);
  await db.transaction((transaction) => putFirstInTransaction(transaction, jobId, options.pauseRunning));
  await kickDownloadQueue();
  return loadBacktestJobView(jobId);
}

/**
 * A download paused for one put first, whose process is ending: back into the queue (its put_first_at keeps it right after
 * that one) with what it saved; the run that just ended counts toward its total run time, as on a resume. False when the
 * job was not paused (a plain cancel), so the caller ends it cancelled.
 */
export async function requeuePausedDownload(jobId: string, pid: number, progress: { done: number; total: number; label: string | null }): Promise<boolean> {
  const requeued = await db("backtest_jobs")
    .where({ id: jobId, pid, pause_requested: true })
    .update({
      status: "queued",
      pid: null,
      cancel_requested: false,
      pause_requested: false,
      error: null,
      finished_at: null,
      heartbeat_at: null,
      earlier_run_seconds: db.raw("earlier_run_seconds + CASE WHEN started_at IS NULL THEN 0 ELSE GREATEST(0, ROUND(EXTRACT(EPOCH FROM (now() - started_at))))::integer END"),
      progress_done: progress.done,
      progress_total: progress.total,
      progress_label: progress.label,
    });
  return requeued > 0;
}

/** now() is the transaction's start: the paused download sits a millisecond behind the job put first. */
async function putFirstInTransaction(transaction: Knex.Transaction, jobId: string, pauseRunning: boolean): Promise<void> {
  await transaction("backtest_jobs").where({ id: jobId }).update({ put_first_at: transaction.fn.now() });
  if (!pauseRunning) return;
  await transaction("backtest_jobs")
    .where({ kind: "download", status: "running" })
    .whereNot({ id: jobId })
    .where("heartbeat_at", ">", transaction.raw("now() - (?::int * interval '1 millisecond')", [staleHeartbeatMilliseconds]))
    .update({ cancel_requested: true, pause_requested: true, put_first_at: transaction.raw("now() - interval '1 millisecond'") });
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
    // A cancel while pausing ends the job cancelled, not back in the queue.
    await db("backtest_jobs").where({ id: jobId, status: "running" }).update({ cancel_requested: true, pause_requested: false });
  } else if (displayStatus === "queued" && job.kind === "download" && job.started_at === null) {
    // Removed from the queue before it ever ran: there is nothing to keep a record of.
    const deleted = await db("backtest_jobs").where({ id: jobId, status: "queued" }).whereNull("started_at").delete();
    if (deleted > 0) return { ...toBacktestJobView(job), status: "cancelled", displayStatus: "cancelled", finishedAt: new Date().toISOString() };
    // The queue started it in between: it is cancelled as the running job it now is.
    return cancelBacktestJob(jobId);
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
        queued_at: db.fn.now(),
        // A resume joins the end of the queue, even if the job was once put first.
        put_first_at: null,
        pause_requested: false,
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
