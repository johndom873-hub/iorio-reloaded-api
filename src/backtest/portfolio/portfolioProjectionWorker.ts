import { parentPort } from "node:worker_threads";
import { enableExactInputCaches } from "../../lib/exactInputCaches.js";
import type { DayPath } from "./portfolioDayHistory.js";
import { runPathValues, runProjectionPaths, type ProjectionInput } from "./portfolioDayProjection.js";

// One worker thread of a projection (portfolioProjectionPool.ts): runs the paths it is given, a "progress" message after
// each, then "done" with their outcomes, or with their daily values ("values": the suggestions' library).

export interface ProjectionWorkerRequest {
  input: ProjectionInput;
  paths: DayPath[];
  firstPathIndex: number;
  returns: "outcomes" | "values";
}

// The same quotes are scored more than once in a look (the backtest job process does the same).
enableExactInputCaches();

parentPort!.once("message", (request: ProjectionWorkerRequest) => {
  const onPathDone = () => parentPort!.postMessage({ kind: "progress" });
  const work =
    request.returns === "values"
      ? runPathValues(request.input, request.paths, request.firstPathIndex, onPathDone).then((values) => parentPort!.postMessage({ kind: "done", values }, [values.buffer as ArrayBuffer]))
      : runProjectionPaths(request.input, request.paths, request.firstPathIndex, onPathDone).then((outcomes) => parentPort!.postMessage({ kind: "done", outcomes }));
  work
    .catch((error: unknown) => parentPort!.postMessage({ kind: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
});
