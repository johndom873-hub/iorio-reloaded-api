import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import { db } from "../../db/connection.js";
import { connectToIbkrGateway } from "../../ibkr/connectIbkr.js";
import { findOrCreateTicker } from "../../ibkr/findOrCreateTicker.js";
import { backtestRepoRoot, requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { readFirstOptionDay } from "../backtestDataFile.js";
import { describeFileStockBarsRefresh, FileStockBarsCancelledError, refreshFileStockBars } from "../refreshFileStockBars.js";
import { BacktestCancelledError, runBacktestSession } from "../engine/runBacktestSession.js";
import { refreshSplitScheduleForSymbol } from "../engine/splitFactors.js";
import { runAnalysisJob } from "../analysis/runAnalysisJob.js";
import { backfillDailyHistoryForBacktest, backtestHistoryStartDate, describeBacktestHistoryBackfill, isIbkrNoSuchContractError } from "../backfillDailyHistory.js";
import { formatDownloadProgressLabel, jobHeartbeatIntervalMilliseconds, lastFinishedBacktestSessionDate } from "./backtestJobRules.js";
import { finishSessionOfJob, kickBacktestQueue, kickDownloadQueue, loadBacktestJobRow, requeuePausedDownload, type BacktestJobRow } from "./backtestJobStore.js";
import { thetaDataDownloaderScriptName } from "./spawnBacktestJobProcess.js";
import { describeDownloadGaps, parseDownloaderLine } from "./thetaDataDownloaderProtocol.js";

// The job process (scripts/run-backtest-job.ts, docs/backtesting/DATA-FILES.md): marks the job running, writes progress
// and a heartbeat, honours cancel, and records the outcome. Every write is guarded by this process's pid: when the job
// was resumed elsewhere (a new pid) or deleted, this process stops without touching it.

type JobOutcome = { status: "succeeded" | "failed" | "cancelled"; error: string | null };

const progressWriteMinimumIntervalMilliseconds = 1_000;
/** Between two IBKR historical requests for a file's stock bars (as the other backfills: IBKR paces historical data). */
const fileStockBarsRequestPauseMilliseconds = 10_000;

class JobProcessControl {
  cancelRequested = false;
  ownershipLost = false;
  private progress: { done: number; total: number; label: string | null };
  private progressDirty = false;
  private lastProgressWriteAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly cancelListeners = new Set<() => void>();

  constructor(
    readonly jobId: string,
    readonly pid: number,
    initialProgress: { done: number; total: number; label: string | null },
  ) {
    this.progress = { ...initialProgress };
  }

  /** Claims the job for this process. False when it is finished or someone cancelled it before it started. */
  async markRunning(): Promise<boolean> {
    const [row] = await db("backtest_jobs")
      .where({ id: this.jobId })
      .whereIn("status", ["queued", "running", "failed"])
      .update({ status: "running", pid: this.pid, started_at: db.fn.now(), heartbeat_at: db.fn.now(), finished_at: null, error: null })
      .returning("cancel_requested");
    if (!row) return false;
    if (row.cancel_requested) this.requestCancel();
    return true;
  }

  startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => void this.enqueueWrite(() => this.writeHeartbeat()), jobHeartbeatIntervalMilliseconds);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  onCancel(listener: () => void): () => void {
    this.cancelListeners.add(listener);
    if (this.cancelRequested) listener();
    return () => this.cancelListeners.delete(listener);
  }

  requestCancel(): void {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    for (const listener of this.cancelListeners) listener();
  }

  /** The newest progress reported. */
  progressSnapshot(): { done: number; total: number; label: string | null } {
    return { ...this.progress };
  }

  /** Keeps the newest progress; written at most once a second, and with every heartbeat. */
  reportProgress(done: number, total: number, label: string | null): Promise<void> {
    this.progress = { done, total, label };
    this.progressDirty = true;
    if (Date.now() - this.lastProgressWriteAt < progressWriteMinimumIntervalMilliseconds) return Promise.resolve();
    return this.enqueueWrite(() => this.writeHeartbeat());
  }

  private enqueueWrite(write: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(write).catch((error: unknown) => console.error(`Backtest job ${this.jobId}: could not write progress: ${error instanceof Error ? error.message : error}`));
    return this.writeChain;
  }

  private async writeHeartbeat(): Promise<void> {
    if (this.ownershipLost) return;
    const progressColumns = this.progressDirty ? { progress_done: this.progress.done, progress_total: this.progress.total, progress_label: this.progress.label } : {};
    this.progressDirty = false;
    this.lastProgressWriteAt = Date.now();
    const [row] = await db("backtest_jobs")
      .where({ id: this.jobId, pid: this.pid, status: "running" })
      .update({ heartbeat_at: db.fn.now(), ...progressColumns })
      .returning("cancel_requested");
    if (!row) {
      console.warn(`Backtest job ${this.jobId}: the job is no longer this process's (resumed elsewhere, cancelled or deleted): stopping.`);
      this.ownershipLost = true;
      this.requestCancel();
    } else if (row.cancel_requested) {
      this.requestCancel();
    }
  }

  async finish(outcome: JobOutcome): Promise<void> {
    await this.writeChain;
    if (this.ownershipLost) return;
    if (outcome.status === "cancelled" && (await requeuePausedDownload(this.jobId, this.pid, this.progress))) return;
    await db("backtest_jobs")
      .where({ id: this.jobId, pid: this.pid })
      .update({
        status: outcome.status,
        error: outcome.error,
        finished_at: db.fn.now(),
        heartbeat_at: db.fn.now(),
        progress_done: this.progress.done,
        progress_total: this.progress.total,
        progress_label: this.progress.label,
      });
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The IBKR daily-bar and implied-volatility top-up for the download's symbol, creating its ticker row when the symbol is new.
 * The row comes from the contract lookup alone: the bars are historical requests, so nothing here needs a market-data line.
 */
async function topUpIbkrHistory(symbol: string): Promise<void> {
  const { ticker, created } = await findOrCreateTicker(symbol, { captureTodaysMarketData: false });
  if (created) console.log(`${symbol}: new ticker row created from IBKR's contract details.`);
  const connection = await connectToIbkrGateway();
  try {
    let requestId = 1;
    const result = await backfillDailyHistoryForBacktest(connection, { id: ticker.id, symbol }, { lastDateToStore: lastFinishedBacktestSessionDate(new Date()), nextRequestId: () => requestId++ });
    console.log(describeBacktestHistoryBackfill(result));
  } finally {
    connection.disconnect();
  }
}

/** Waits `milliseconds`, or less when the job is cancelled meanwhile. */
function pauseUnlessCancelled(milliseconds: number, control: JobProcessControl): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stopListening();
      resolve();
    }, milliseconds);
    const stopListening = control.onCancel(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The backtests' stock prices: the symbol's IBKR bars written into its data file (refreshFileStockBars.ts), 30-minute
 * bars from the year of its first option day. Runs after the downloader, which writes the same file.
 */
async function refreshStockBarsOfFile(job: BacktestJobRow, control: JobProcessControl): Promise<void> {
  const firstOptionDay = readFirstOptionDay(job.symbol);
  if (firstOptionDay === null) return;
  const afterDownload = control.progressSnapshot();
  const downloadLabel = afterDownload.label ?? "Option data saved";
  const connection = await connectToIbkrGateway();
  try {
    let requestId = 1;
    const result = await refreshFileStockBars(connection, job.symbol, {
      firstIntradayYear: Number(firstOptionDay.slice(0, 4)),
      lastDateToStore: lastFinishedBacktestSessionDate(new Date()),
      nextRequestId: () => requestId++,
      pause: () => pauseUnlessCancelled(fileStockBarsRequestPauseMilliseconds, control),
      onRequest: (label) => void control.reportProgress(afterDownload.done, afterDownload.total, `${downloadLabel} · ${label}`),
      isCancelled: () => control.cancelRequested,
    });
    console.log(describeFileStockBarsRefresh(result));
    await control.reportProgress(afterDownload.done, afterDownload.total, `${downloadLabel} · IBKR bars to ${result.dailyLastDate}`);
  } finally {
    connection.disconnect();
  }
}

/** Runs the ThetaData downloader, turning its stdout protocol into progress; SIGTERM on cancel (it stops after the day in progress). */
async function runThetaDataDownloader(job: BacktestJobRow, control: JobProcessControl): Promise<JobOutcome> {
  const repoRoot = backtestRepoRoot();
  const pythonPath = path.join(repoRoot, ".venv-backtest", "bin", "python");
  if (!existsSync(pythonPath)) return { status: "failed", error: "The downloader's Python environment is missing: run npm run backtest:setup." };
  const scriptPath = path.join(repoRoot, "scripts", "backtest", thetaDataDownloaderScriptName);
  if (!existsSync(scriptPath)) return { status: "failed", error: `The downloader script is missing: ${scriptPath}.` };
  if (!job.start_date || !job.end_date) return { status: "failed", error: "The download job has no date range." };

  const child = spawn(pythonPath, [scriptPath, "--symbol", job.symbol, "--start", job.start_date, "--end", job.end_date, "--data-dir", requireBacktestDataDirectory()], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stopOnCancel = control.onCancel(() => child.kill("SIGTERM"));
  let reportedError: string | null = null;
  let lastSavedDate: string | null = null;
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    const event = parseDownloaderLine(line);
    if (!event) {
      console.log(`downloader: ${line}`);
      return;
    }
    if (event.type === "error") {
      reportedError = event.message;
      return;
    }
    if (event.type === "progress") lastSavedDate = event.lastDate;
    // The final label says what the range still lacks: "saved up to 2026-10-09 · 2 days unavailable".
    const label = event.type === "done" ? `${lastSavedDate ? formatDownloadProgressLabel(lastSavedDate) : "nothing new to save"}${describeDownloadGaps(event)}` : formatDownloadProgressLabel(lastSavedDate);
    void control.reportProgress(event.daysDone, event.daysTotal, label);
  });

  try {
    const [exitCode, signal] = (await Promise.all([once(child, "close"), once(lines, "close")]))[0] as [number | null, NodeJS.Signals | null];
    if (control.cancelRequested) return { status: "cancelled", error: null };
    if (exitCode === 0) return { status: "succeeded", error: null };
    return { status: "failed", error: reportedError ?? `The downloader stopped with ${signal ? `signal ${signal}` : `exit code ${exitCode}`}.` };
  } catch (error) {
    return { status: "failed", error: `The downloader could not be started: ${errorMessage(error)}` };
  } finally {
    stopOnCancel();
  }
}

async function runDownloadJob(job: BacktestJobRow, control: JobProcessControl): Promise<JobOutcome> {
  if (control.cancelRequested) return { status: "cancelled", error: null };
  await control.reportProgress(job.progress_done, job.progress_total, `IBKR daily bars and implied volatility back to ${backtestHistoryStartDate}`);
  // The option data does not depend on the bars, so an IBKR failure (Gateway down, pacing) does not stop the download;
  // the job then ends failed with the reason, and Resume retries the top-up. A stock IBKR has no contract for stops it:
  // the backtests take their stock prices from IBKR only, so its option data could never be used.
  let ibkrError: string | null = null;
  try {
    await topUpIbkrHistory(job.symbol);
  } catch (error) {
    ibkrError = errorMessage(error);
    console.error(`${job.symbol}: IBKR history top-up failed: ${ibkrError}`);
    if (isIbkrNoSuchContractError(error)) {
      return { status: "failed", error: `IBKR has no stock contract for ${job.symbol}: it is delisted, or the symbol is misspelt. No option data was downloaded: the backtests need IBKR's stock prices.` };
    }
  }
  if (control.cancelRequested) return { status: "cancelled", error: null };

  await control.reportProgress(job.progress_done, job.progress_total, "Starting the ThetaData download");
  const download = await runThetaDataDownloader(job, control);
  if (download.status === "cancelled") return download;
  let stockBarsError: string | null = null;
  if (download.status === "succeeded") {
    try {
      await refreshStockBarsOfFile(job, control);
    } catch (error) {
      if (error instanceof FileStockBarsCancelledError || control.cancelRequested) return { status: "cancelled", error: null };
      stockBarsError = errorMessage(error);
      console.error(`${job.symbol}: the IBKR stock bars for the file failed: ${stockBarsError}`);
    }
    if (!stockBarsError) await refreshDetectedSplits(job);
  }
  const problems = [ibkrError ? `The IBKR daily-bar top-up failed (${ibkrError}).` : null, stockBarsError ? `The IBKR stock bars for the file failed (${stockBarsError}).` : null].filter((problem): problem is string => problem !== null);
  if (problems.length === 0) return download;
  const note = `${problems.join(" ")} Resume retries.`;
  return { status: "failed", error: download.status === "succeeded" ? `Option data downloaded. ${note}` : `${download.error} ${note}` };
}

/** The file's split schedule (engine/splitFactors.ts) for the Data files table; a failure is logged and never fails the download. */
async function refreshDetectedSplits(job: BacktestJobRow): Promise<void> {
  try {
    const schedule = await refreshSplitScheduleForSymbol(job.symbol);
    if (!schedule) console.log(`${job.symbol}: no split schedule (no ticker row or no complete day).`);
    else console.log(`${job.symbol}: ${schedule.splits.length} split(s) detected${schedule.unresolved.length > 0 ? `, ${schedule.unresolved.length} stretch(es) with no settled price scale` : ""}.`);
  } catch (error) {
    console.error(`${job.symbol}: split detection failed: ${errorMessage(error)}`);
  }
}

async function runBacktestJob(job: BacktestJobRow, control: JobProcessControl): Promise<JobOutcome> {
  if (!job.session_id) return { status: "failed", error: "This backtest job has no session." };
  try {
    await runBacktestSession(job.session_id, {
      reportProgress: (done, total, label) => control.reportProgress(done, total, label),
      isCancelRequested: async () => control.cancelRequested,
    });
    return { status: "succeeded", error: null };
  } catch (error) {
    const cancelled = error instanceof BacktestCancelledError;
    const outcome: JobOutcome = cancelled ? { status: "cancelled", error: null } : { status: "failed", error: errorMessage(error) };
    if (!cancelled) console.error(`Backtest session ${job.session_id} failed:`, error);
    if (!control.ownershipLost) await finishSessionOfJob(job.session_id, outcome.status === "cancelled" ? "cancelled" : "failed", outcome.error);
    return outcome;
  }
}

/** The whole life of one job process. Resolves once the outcome is written (and, for a download or a backtest, its queue kicked). */
export async function executeBacktestJob(jobId: string): Promise<void> {
  const job = await loadBacktestJobRow(jobId);
  if (!job) throw new Error(`No backtest job ${jobId}.`);
  const control = new JobProcessControl(jobId, process.pid, { done: job.progress_done, total: job.progress_total, label: job.progress_label });
  if (!(await control.markRunning())) {
    console.log(`Backtest job ${jobId} is ${job.status}: nothing to run.`);
    return;
  }
  console.log(`Backtest job ${jobId} (${job.kind} ${job.symbol}) running as pid ${process.pid}.`);

  // A SIGTERM (a cancel from the API, or a leftover being stopped) or Ctrl-C ends the job as a cancel.
  const onSignal = (signal: NodeJS.Signals) => {
    console.log(`Backtest job ${jobId}: ${signal} received, stopping.`);
    control.requestCancel();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  control.startHeartbeat();

  let outcome: JobOutcome = { status: "failed", error: "The job ended without an outcome." };
  try {
    outcome = job.kind === "download" ? await runDownloadJob(job, control) : job.kind === "analysis" ? await runAnalysisJob(job.id, control) : await runBacktestJob(job, control);
  } catch (error) {
    console.error(`Backtest job ${jobId} failed:`, error);
    outcome = control.cancelRequested ? { status: "cancelled", error: null } : { status: "failed", error: errorMessage(error) };
  } finally {
    control.stopHeartbeat();
    await control.finish(outcome);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  console.log(`Backtest job ${jobId}: ${control.ownershipLost ? "stopped (no longer this process's job)" : outcome.status}${outcome.error ? ` — ${outcome.error}` : ""}.`);
  if (job.kind === "download") await kickDownloadQueue();
  if (job.kind === "backtest") await kickBacktestQueue();
}
