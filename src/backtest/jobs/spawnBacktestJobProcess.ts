import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { backtestRepoRoot, requireBacktestDataDirectory } from "../backtestDataDirectory.js";

// Job processes (docs/backtesting/DATA-FILES.md): each job runs scripts/run-backtest-job.ts in its own detached
// process, so an API restart (tsx watch restarts on every save) or crash never stops it. Detached also makes the job
// process the leader of its own process group, which the downloader it starts joins.

export const backtestJobScriptName = "run-backtest-job.ts";
export const thetaDataDownloaderScriptName = "download_thetadata_symbol.py";

export function backtestJobLogPath(jobId: string): string {
  return path.join(requireBacktestDataDirectory(), "logs", `${jobId}.log`);
}

/** Starts the job's process, appending its output to the job's log file; returns its pid. */
export function spawnBacktestJobProcess(jobId: string): number {
  const repoRoot = backtestRepoRoot();
  const logPath = backtestJobLogPath(jobId);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const logFileDescriptor = openSync(logPath, "a");
  try {
    // `--import tsx` resolves from the working directory: the repo root, where tsx is installed.
    const child = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "scripts", backtestJobScriptName), jobId], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFileDescriptor, logFileDescriptor],
    });
    // A failed spawn reports through this event; without a listener it would crash the API.
    child.on("error", (error) => console.error(`Backtest job ${jobId}: the job process failed to start: ${error.message}`));
    if (child.pid === undefined) throw new Error(`The job process for ${jobId} could not be started (see ${logPath}).`);
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFileDescriptor);
  }
}

export interface ListedProcess {
  pid: number;
  processGroupId: number;
  command: string;
}

/** `ps -axo pid=,pgid=,command=` output, one process per line. */
export function parseProcessListing(listing: string): ListedProcess[] {
  return listing
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), processGroupId: Number(match[2]), command: match[3]! }));
}

/** What is left of a job's earlier process: its own process (by job id) and its downloader, both in the group it led. */
export function selectLeftoverJobProcesses(processes: readonly ListedProcess[], processGroupId: number, jobId: string): ListedProcess[] {
  return processes.filter(
    (listed) =>
      listed.processGroupId === processGroupId &&
      ((listed.command.includes(backtestJobScriptName) && listed.command.includes(jobId)) || listed.command.includes(thetaDataDownloaderScriptName)),
  );
}

/**
 * Stops what is left of a job's earlier process before the job is resumed, cancelled or deleted (a job process killed
 * outright leaves its downloader running). Only processes whose command line is this job's are signalled, so a pid
 * reused by something else is never touched. Returns how many were signalled.
 */
export function terminateLeftoverJobProcesses(processGroupId: number | null, jobId: string): number {
  if (!processGroupId) return 0;
  let listing: string;
  try {
    listing = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" });
  } catch (error) {
    console.warn(`Backtest job ${jobId}: could not list processes to stop its leftovers: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
  const leftovers = selectLeftoverJobProcesses(parseProcessListing(listing), processGroupId, jobId);
  for (const leftover of leftovers) {
    try {
      process.kill(leftover.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  return leftovers.length;
}
