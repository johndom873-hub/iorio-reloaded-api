import { parentPort } from "node:worker_threads";
import { enableExactInputCaches } from "../../lib/exactInputCaches.js";
import type { DayPath } from "./portfolioDayHistory.js";
import { runPathValuesAtAccounts, runProjectionPaths, type PathOutcome, type ProjectionInput } from "./portfolioDayProjection.js";

// One worker thread of a projection (portfolioProjectionPool.ts): given the projection once ("start"), it runs the paths it
// is handed one at a time ("run"), answering each with its outcome, or with each account's daily values ("values": the
// suggestions' library).

export interface ProjectionWorkerStart {
  kind: "start";
  input: ProjectionInput;
  /** Every path of the projection; "run" names one by its index. */
  paths: DayPath[];
  /** "values": the daily values of each of accountsDollars (runPathValuesAtAccounts). */
  returns: "outcomes" | "values";
  accountsDollars?: number[];
}

export type ProjectionWorkerMessage = ProjectionWorkerStart | { kind: "run"; pathIndex: number };

export type ProjectionWorkerReply = { kind: "done"; pathIndex: number; outcome?: PathOutcome; values?: Float32Array[] } | { kind: "failed"; error: string };

// The same quotes are scored more than once in a look (the backtest job process does the same).
enableExactInputCaches();

let projection: ProjectionWorkerStart | null = null;
const reply = (message: ProjectionWorkerReply, transfer: ArrayBuffer[] = []) => parentPort!.postMessage(message, transfer);

parentPort!.on("message", (message: ProjectionWorkerMessage) => {
  if (message.kind === "start") {
    projection = message;
    return;
  }
  const { input, paths, returns, accountsDollars } = projection!;
  const { pathIndex } = message;
  const path = [paths[pathIndex]!];
  const work =
    returns === "values"
      ? runPathValuesAtAccounts(input, accountsDollars!, path, pathIndex).then((values) => reply({ kind: "done", pathIndex, values }, values.map((array) => array.buffer as ArrayBuffer)))
      : runProjectionPaths(input, path, pathIndex).then(([outcome]) => reply({ kind: "done", pathIndex, outcome: outcome! }));
  work.catch((error: unknown) => reply({ kind: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error) }));
});
