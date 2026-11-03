import os from "node:os";
import { Worker } from "node:worker_threads";
import type { DayPath } from "./portfolioDayHistory.js";
import type { PathOutcome, ProjectionInput } from "./portfolioDayProjection.js";
import type { ProjectionWorkerRequest } from "./portfolioProjectionWorker.js";

// A projection's paths split across worker threads (each path is the whole book's days, so paths are the unit): contiguous
// chunks, one per worker, leaving one core for the rest of the machine; the outcomes come back in path order.

const runsFromSource = import.meta.url.endsWith(".ts");
const workerModuleUrl = () => new URL(runsFromSource ? "./portfolioProjectionWorker.ts" : "./portfolioProjectionWorker.js", import.meta.url);
/**
 * From the TypeScript source, a worker runs it with Node's own type handling (its enums and parameter properties
 * transformed) and imports resolved to the .ts files, not through tsx: tsx's esbuild keeps every function's name with a
 * call at each creation, about 10% of a projection's time. The built JavaScript needs neither.
 */
const workerExecArgv = () => (runsFromSource ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", new URL("./typeScriptSourceRegister.mjs", import.meta.url).href] : []);

/**
 * At least 1, at most 4, one core left free, no more than the paths. Four is the Mac's performance cores: with 6 or 8
 * workers the extra ones land on its efficiency cores and the run is slower (2026-11-03, 48 paths of a 10-ticker book:
 * 0.56 s a path on 4, 0.59 on 6, 0.71 on 8).
 */
export function projectionWorkerCount(pathCount: number): number {
  return Math.max(1, Math.min(4, os.availableParallelism() - 1, pathCount));
}

function runWorker(request: ProjectionWorkerRequest, onPathDone: () => void): Promise<PathOutcome[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerModuleUrl(), { execArgv: workerExecArgv() });
    worker.on("message", (message: { kind: "progress" } | { kind: "done"; outcomes: PathOutcome[] } | { kind: "failed"; error: string }) => {
      if (message.kind === "progress") return onPathDone();
      void worker.terminate();
      if (message.kind === "done") resolve(message.outcomes);
      else reject(new Error(`Projection worker failed: ${message.error}`));
    });
    worker.once("error", (error) => {
      void worker.terminate();
      reject(error);
    });
    worker.postMessage(request);
  });
}

/** Every path's outcome, in path order; `onProgress` after each path with how many are done. `workerCount` for timing only. */
export async function runProjectionInParallel(input: ProjectionInput, paths: readonly DayPath[], onProgress?: (done: number, total: number) => void, workerCount = projectionWorkerCount(paths.length)): Promise<PathOutcome[]> {
  if (paths.length === 0) return [];
  const chunkSize = Math.ceil(paths.length / workerCount);
  let done = 0;
  const chunks: Promise<PathOutcome[]>[] = [];
  for (let start = 0; start < paths.length; start += chunkSize) {
    chunks.push(
      runWorker({ input, paths: paths.slice(start, start + chunkSize), firstPathIndex: start }, () => {
        done += 1;
        onProgress?.(done, paths.length);
      }),
    );
  }
  return (await Promise.all(chunks)).flat();
}
