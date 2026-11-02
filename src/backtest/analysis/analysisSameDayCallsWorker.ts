import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { scanSameDayCalls, type SameDayCallDay, type SameDayCallScanDay, type SameDayCallScanSettings } from "./analysisSameDayCalls.js";

// A same-day Calls scan worker (analysisSameDayCallsPool.ts): scans its share of the expiry days on its own read-only
// connection to the symbol file.

export interface SameDayCallsWorkerRequest {
  filePath: string;
  days: SameDayCallScanDay[];
  settings: SameDayCallScanSettings;
  /** The sessions from the first day to 45 days past the last, ascending: what the premium yields are annualized over. */
  openDays: string[];
}

parentPort?.on("message", (request: SameDayCallsWorkerRequest) => {
  try {
    const database = new DatabaseSync(request.filePath, { readOnly: true });
    try {
      const file = new BacktestSymbolFile(database);
      const rows: SameDayCallDay[] = request.days.map((day) => scanSameDayCalls(file, day, request.settings, request.openDays));
      parentPort!.postMessage({ ok: true, rows });
    } finally {
      database.close();
    }
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
});
