import os from "node:os";
import { Worker } from "node:worker_threads";
import type { DayPath } from "./portfolioDayHistory.js";
import type { PathOutcome, ProjectionInput } from "./portfolioDayProjection.js";
import type { ProjectionWorkerMessage, ProjectionWorkerReply, ProjectionWorkerStart } from "./portfolioProjectionWorker.js";

// A projection's paths shared out across worker threads (each path is the whole book's days, so paths are the unit): each
// worker is handed the next path as it finishes one, so a worker on a slower core simply runs fewer; the results come back
// in path order. A path's result depends only on its own index (its draws are seeded by it), not on which worker ran it.

const runsFromSource = import.meta.url.endsWith(".ts");
const workerModuleUrl = () => new URL(runsFromSource ? "./portfolioProjectionWorker.ts" : "./portfolioProjectionWorker.js", import.meta.url);
/**
 * From the TypeScript source, a worker runs it with Node's own type handling (its enums and parameter properties
 * transformed) and imports resolved to the .ts files, not through tsx: tsx's esbuild keeps every function's name with a
 * call at each creation, about 10% of a projection's time. The built JavaScript needs neither.
 */
const workerExecArgv = () => (runsFromSource ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", new URL("./typeScriptSourceRegister.mjs", import.meta.url).href] : []);

/**
 * At least 1, at most 4 (the Mac's performance cores), one core left free, no more than the paths. More workers were no
 * faster on a sustained run (2026-11-06, the library's build of three tickers: 126 s on 4 workers, 125 s on 8): the
 * MacBook Air slows its cores under a long full load, so the extra ones mostly share the same power.
 */
export function projectionWorkerCount(pathCount: number): number {
  return Math.max(1, Math.min(4, os.availableParallelism() - 1, pathCount));
}

/** A projection stopped through its signal (the screen closed its stream): its workers are terminated. */
export class ProjectionStoppedError extends Error {
  constructor() {
    super("The projection was stopped.");
    this.name = "ProjectionStoppedError";
  }
}

/** Runs every path on `workerCount` workers, each handed the next path as it finishes one; one result per path, in path order. */
function runQueued<PathResult>(start: ProjectionWorkerStart, workerCount: number, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<PathResult[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProjectionStoppedError());
    const pathCount = start.paths.length;
    const results = new Array<PathResult>(pathCount);
    const workers: Worker[] = [];
    let nextPathIndex = 0;
    let done = 0;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", stop);
      for (const worker of workers) void worker.terminate();
      if (error === null) resolve(results);
      else reject(error);
    };
    const stop = () => finish(new ProjectionStoppedError());
    signal?.addEventListener("abort", stop, { once: true });
    const handOut = (worker: Worker) => {
      if (nextPathIndex >= pathCount) return;
      worker.postMessage({ kind: "run", pathIndex: nextPathIndex } satisfies ProjectionWorkerMessage);
      nextPathIndex += 1;
    };
    for (let count = 0; count < Math.min(workerCount, pathCount); count++) {
      const worker = new Worker(workerModuleUrl(), { execArgv: workerExecArgv() });
      workers.push(worker);
      worker.on("message", (reply: ProjectionWorkerReply) => {
        if (settled) return;
        if (reply.kind === "failed") return finish(new Error(`Projection worker failed: ${reply.error}`));
        results[reply.pathIndex] = (start.returns === "values" ? reply.values : reply.outcome) as PathResult;
        done += 1;
        onProgress?.(done, pathCount);
        if (done === pathCount) return finish(null);
        handOut(worker);
      });
      worker.once("error", (error) => finish(error));
      worker.postMessage(start satisfies ProjectionWorkerMessage);
      handOut(worker);
    }
  });
}

/** Every path's outcome, in path order; `onProgress` after each path with how many are done. `workerCount` for timing only; `signal` stops it (ProjectionStoppedError). */
export async function runProjectionInParallel(input: ProjectionInput, paths: readonly DayPath[], onProgress?: (done: number, total: number) => void, workerCount = projectionWorkerCount(paths.length), signal?: AbortSignal): Promise<PathOutcome[]> {
  if (paths.length === 0) return [];
  return runQueued<PathOutcome>({ kind: "start", input, paths: [...paths], returns: "outcomes" }, workerCount, onProgress, signal);
}

/**
 * Each account's daily values on every path as a share of its starting value (runPathValuesAtAccounts), path after path,
 * one array per account in their order; `onProgress` after each path.
 */
export async function runPathValuesAtAccountsInParallel(input: ProjectionInput, accountsDollars: readonly number[], paths: readonly DayPath[], onProgress?: (done: number, total: number) => void, workerCount = projectionWorkerCount(paths.length)): Promise<Float32Array[]> {
  if (paths.length === 0) return accountsDollars.map(() => new Float32Array(0));
  const byPath = await runQueued<Float32Array[]>({ kind: "start", input, paths: [...paths], returns: "values", accountsDollars: [...accountsDollars] }, workerCount, onProgress);
  return accountsDollars.map((_, account) => {
    const pathLength = byPath[0]![account]!.length;
    const values = new Float32Array(pathLength * byPath.length);
    byPath.forEach((pathValues, pathIndex) => values.set(pathValues[account]!, pathIndex * pathLength));
    return values;
  });
}
