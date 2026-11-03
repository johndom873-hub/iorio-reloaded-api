import os from "node:os";
import { Worker } from "node:worker_threads";
import { engineWorkerExecArgv } from "../engine/engineWorkerThreads.js";
import type { DayPath } from "./portfolioDayHistory.js";
import type { PathOutcome, ProjectionInput } from "./portfolioDayProjection.js";
import type { ProjectionWorkerRequest } from "./portfolioProjectionWorker.js";

// A projection's paths split across worker threads (each path is the whole book's days, so paths are the unit): contiguous
// chunks, one per worker, leaving one core for the rest of the machine; the outcomes come back in path order.

const workerModuleUrl = () => new URL(import.meta.url.endsWith(".ts") ? "./portfolioProjectionWorker.ts" : "./portfolioProjectionWorker.js", import.meta.url);

/** At least 1, at most 8, one core left free, no more than the paths. */
export function projectionWorkerCount(pathCount: number): number {
  return Math.max(1, Math.min(8, os.availableParallelism() - 1, pathCount));
}

function runWorker(request: ProjectionWorkerRequest, onPathDone: () => void): Promise<PathOutcome[]> {
  return new Promise((resolve, reject) => {
    const execArgv = engineWorkerExecArgv();
    const worker = new Worker(workerModuleUrl(), execArgv ? { execArgv } : undefined);
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

/** Every path's outcome, in path order; `onProgress` after each path with how many are done. */
export async function runProjectionInParallel(input: ProjectionInput, paths: readonly DayPath[], onProgress?: (done: number, total: number) => void): Promise<PathOutcome[]> {
  if (paths.length === 0) return [];
  const workerCount = projectionWorkerCount(paths.length);
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
