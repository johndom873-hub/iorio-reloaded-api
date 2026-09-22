import { Worker } from "node:worker_threads";
import { liveUncompensatedSharePathCount, type SignalCandidate, type SignalSurfaceSlice } from "./signalCandidates.js";
import { candidateContractKey } from "./signalsLiveScoring.js";
import type { UncompensatedShareJob, UncompensatedShareJobContract, UncompensatedShareJobResult } from "./uncompensatedShareWorker.js";

// One worker per API process, jobs queued in order. If the worker dies, every
// pending job rejects and the next call starts a fresh worker.

// Under tsx (dev) this module's URL ends in .ts and the worker source is a .ts file too;
// compiled (dist/) both are .js. No precedent in the repo -- verified 2026-09-22 with a spike.
const runningFromTypeScriptSource = import.meta.url.endsWith(".ts");
const workerUrl = new URL(runningFromTypeScriptSource ? "./uncompensatedShareWorker.ts" : "./uncompensatedShareWorker.js", import.meta.url);
// A .ts worker needs tsx's loader. `tsx watch` (dev) already puts it in execArgv, which workers
// inherit; vitest does not, so it is added there explicitly. Compiled .js needs nothing.
const workerExecArgv = runningFromTypeScriptSource && !process.execArgv.some((argument) => argument.includes("tsx")) ? [...process.execArgv, "--import", "tsx"] : undefined;

interface PendingJob {
  resolve: (results: Map<string, number | null>) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextJobId = 1;
const pendingJobs = new Map<number, PendingJob>();

function failAllPending(error: Error): void {
  for (const pending of pendingJobs.values()) pending.reject(error);
  pendingJobs.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const started = new Worker(workerUrl, workerExecArgv ? { execArgv: workerExecArgv } : undefined);
  started.on("message", (result: UncompensatedShareJobResult) => {
    const pending = pendingJobs.get(result.jobId);
    if (!pending) return;
    pendingJobs.delete(result.jobId);
    pending.resolve(new Map(result.results));
  });
  started.on("error", (error) => {
    console.error("uncompensatedShare worker error:", error);
    failAllPending(error);
    worker = null;
  });
  started.on("exit", (code) => {
    if (worker === started) worker = null;
    if (code !== 0) failAllPending(new Error(`uncompensatedShare worker exited with code ${code}`));
  });
  started.unref(); // never keeps the process alive on its own (one-off scripts, tests)
  worker = started;
  return started;
}

export function computeUncompensatedSharesInWorker(candidates: SignalCandidate[], spotPrice: number, slices: SignalSurfaceSlice[], pathCount = liveUncompensatedSharePathCount): Promise<Map<string, number | null>> {
  const yearsByExpiry = new Map(slices.map((slice) => [slice.expiry, slice.yearsToExpiry]));
  const contracts: UncompensatedShareJobContract[] = [];
  for (const candidate of candidates) {
    const yearsToExpiry = yearsByExpiry.get(candidate.expiry);
    if (yearsToExpiry === undefined) continue;
    contracts.push({ key: candidateContractKey(candidate), strike: candidate.strike, yearsToExpiry, volatility: candidate.surfaceImpliedVolatility });
  }
  if (contracts.length === 0) return Promise.resolve(new Map());

  const job: UncompensatedShareJob = { jobId: nextJobId++, spotPrice, pathCount, contracts };
  return new Promise((resolve, reject) => {
    pendingJobs.set(job.jobId, { resolve, reject });
    try {
      ensureWorker().postMessage(job);
    } catch (error) {
      pendingJobs.delete(job.jobId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Stops the worker (tests and one-off scripts); the next call starts a new one. */
export async function shutdownUncompensatedShareWorker(): Promise<void> {
  const current = worker;
  worker = null;
  failAllPending(new Error("uncompensatedShare worker shut down"));
  if (current) await current.terminate();
}
