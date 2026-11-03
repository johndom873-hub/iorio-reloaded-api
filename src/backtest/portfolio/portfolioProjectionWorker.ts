import { parentPort } from "node:worker_threads";
import { enableExactInputCaches } from "../../lib/exactInputCaches.js";
import type { DayPath } from "./portfolioDayHistory.js";
import { runProjectionPaths, type ProjectionInput } from "./portfolioDayProjection.js";

// One worker thread of a projection (portfolioProjectionPool.ts): runs the paths it is given, a "progress" message after
// each, then "done" with their outcomes.

export interface ProjectionWorkerRequest {
  input: ProjectionInput;
  paths: DayPath[];
  firstPathIndex: number;
}

// The same quotes are scored more than once in a look (the backtest job process does the same).
enableExactInputCaches();

parentPort!.once("message", (request: ProjectionWorkerRequest) => {
  runProjectionPaths(request.input, request.paths, request.firstPathIndex, () => parentPort!.postMessage({ kind: "progress" }))
    .then((outcomes) => parentPort!.postMessage({ kind: "done", outcomes }))
    .catch((error: unknown) => parentPort!.postMessage({ kind: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
});
