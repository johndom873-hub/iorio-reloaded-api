import { Worker } from "node:worker_threads";
import os from "node:os";
import { engineWorkerExecArgv } from "../engine/engineWorkerThreads.js";
import type { ChainMapContract, ChainScanDayInput, ChainScanDayRow, ChainScanSettings } from "./analysisChainScan.js";
import type { ChainScanWorkerRequest, ChainScanWorkerResponse } from "./analysisChainScanWorker.js";

// The chain scan split across worker threads (Marcelo 2026-10-15: parallelised to make it go faster). The days are cut
// into contiguous chunks, one per worker, each scanned on its own read-only connection; the rows come back in day order.

const workerModuleUrl = () => new URL(import.meta.url.endsWith(".ts") ? "./analysisChainScanWorker.ts" : "./analysisChainScanWorker.js", import.meta.url);

/** Leaves one core for the rest of the machine; at least 1, at most 8. */
export function chainScanWorkerCount(dayCount: number): number {
  return Math.max(1, Math.min(8, os.availableParallelism() - 1, Math.ceil(dayCount / 50)));
}

function runWorker(request: ChainScanWorkerRequest): Promise<ChainScanWorkerResponse> {
  return new Promise((resolve, reject) => {
    const execArgv = engineWorkerExecArgv();
    const worker = new Worker(workerModuleUrl(), execArgv ? { execArgv } : undefined);
    worker.once("message", (message: { ok: true; response: ChainScanWorkerResponse } | { ok: false; error: string }) => {
      void worker.terminate();
      if (message.ok) resolve(message.response);
      else reject(new Error(`Chain scan worker failed: ${message.error}`));
    });
    worker.once("error", (error) => {
      void worker.terminate();
      reject(error);
    });
    worker.postMessage(request);
  });
}

/** Scans every day, the chain map priced on `chainMapDate`; `onChunkDone` reports the days done so far. */
export async function scanChainDaysInParallel(input: { filePath: string; days: readonly ChainScanDayInput[]; settings: ChainScanSettings; openDays: readonly string[]; chainMapDate: string | null; onChunkDone?: (daysDone: number) => void }): Promise<{ rows: ChainScanDayRow[]; chainMap: ChainMapContract[] }> {
  const workerCount = chainScanWorkerCount(input.days.length);
  const chunkSize = Math.ceil(input.days.length / workerCount);
  const chunks: ChainScanDayInput[][] = [];
  for (let start = 0; start < input.days.length; start += chunkSize) chunks.push(input.days.slice(start, start + chunkSize));
  let daysDone = 0;
  const responses = await Promise.all(
    chunks.map(async (days) => {
      const response = await runWorker({ filePath: input.filePath, days, settings: input.settings, openDays: [...input.openDays], chainMapDate: input.chainMapDate });
      daysDone += days.length;
      input.onChunkDone?.(daysDone);
      return response;
    }),
  );
  return { rows: responses.flatMap((response) => response.rows), chainMap: responses.find((response) => response.chainMap !== null)?.chainMap ?? [] };
}
