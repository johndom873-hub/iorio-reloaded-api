import { Worker } from "node:worker_threads";
import os from "node:os";
import { engineWorkerExecArgv } from "../engine/engineWorkerThreads.js";
import type { SameDayCallDay, SameDayCallScanDay, SameDayCallScanSettings } from "./analysisSameDayCalls.js";
import type { SameDayCallsWorkerRequest } from "./analysisSameDayCallsWorker.js";

// The same-day Calls scan split across worker threads, as the Ladder's chain scan was (Marcelo 2026-10-15: parallelised
// to make it go faster). The expiry days are cut into contiguous chunks, one per worker, each scanned on its own
// read-only connection; the rows come back in day order.

const workerModuleUrl = () => new URL(import.meta.url.endsWith(".ts") ? "./analysisSameDayCallsWorker.ts" : "./analysisSameDayCallsWorker.js", import.meta.url);

/** Leaves one core for the rest of the machine; at least 1, at most 8, one per 50 days. */
export function sameDayCallsWorkerCount(dayCount: number): number {
  return Math.max(1, Math.min(8, os.availableParallelism() - 1, Math.ceil(dayCount / 50)));
}

function runWorker(request: SameDayCallsWorkerRequest): Promise<SameDayCallDay[]> {
  return new Promise((resolve, reject) => {
    const execArgv = engineWorkerExecArgv();
    const worker = new Worker(workerModuleUrl(), execArgv ? { execArgv } : undefined);
    worker.once("message", (message: { ok: true; rows: SameDayCallDay[] } | { ok: false; error: string }) => {
      void worker.terminate();
      if (message.ok) resolve(message.rows);
      else reject(new Error(`Same-day Calls scan worker failed: ${message.error}`));
    });
    worker.once("error", (error) => {
      void worker.terminate();
      reject(error);
    });
    worker.postMessage(request);
  });
}

/** Scans every expiry day given; `onChunkDone` reports the days done so far. */
export async function scanSameDayCallsInParallel(input: { filePath: string; days: readonly SameDayCallScanDay[]; settings: SameDayCallScanSettings; openDays: readonly string[]; onChunkDone?: (daysDone: number) => void }): Promise<SameDayCallDay[]> {
  if (input.days.length === 0) return [];
  const workerCount = sameDayCallsWorkerCount(input.days.length);
  const chunkSize = Math.ceil(input.days.length / workerCount);
  const chunks: SameDayCallScanDay[][] = [];
  for (let start = 0; start < input.days.length; start += chunkSize) chunks.push(input.days.slice(start, start + chunkSize));
  let daysDone = 0;
  const responses = await Promise.all(
    chunks.map(async (days) => {
      const rows = await runWorker({ filePath: input.filePath, days, settings: input.settings, openDays: [...input.openDays] });
      daysDone += days.length;
      input.onChunkDone?.(daysDone);
      return rows;
    }),
  );
  return responses.flat();
}
