import { parentPort } from "node:worker_threads";
import { computeUncompensatedShare } from "./uncompensatedShare.js";

// Worker-thread entry for the Signals live layer: runs the UncompensatedShare Monte
// Carlo off the API's event loop (decided 2026-09-22: ~1 s per ticker on the Basic dyno
// at 1000 paths would otherwise stall every other request). One job at a time, in order.

export interface UncompensatedShareJobContract {
  key: string;
  strike: number;
  yearsToExpiry: number;
  volatility: number;
}

export interface UncompensatedShareJob {
  jobId: number;
  spotPrice: number;
  pathCount: number;
  contracts: UncompensatedShareJobContract[];
}

export interface UncompensatedShareJobResult {
  jobId: number;
  results: [string, number | null][];
}

parentPort!.on("message", (job: UncompensatedShareJob) => {
  const results: [string, number | null][] = job.contracts.map((contract) => {
    const shares = computeUncompensatedShare({ spotPrice: job.spotPrice, strike: contract.strike, yearsToExpiry: contract.yearsToExpiry, volatility: contract.volatility }, { pathCount: job.pathCount });
    return [contract.key, shares ? shares.timingShare * 100 : null];
  });
  const result: UncompensatedShareJobResult = { jobId: job.jobId, results };
  parentPort!.postMessage(result);
});
