import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { priceChainMap, scanChainDay, volumeByContract, type ChainMapContract, type ChainScanDayInput, type ChainScanDayRow, type ChainScanSettings } from "./analysisChainScan.js";

// A chain scan worker (analysisChainScanPool.ts): scans its share of the days on its own read-only connection to the
// symbol file, and prices the chain map when its share holds the last day.

export interface ChainScanWorkerRequest {
  filePath: string;
  days: ChainScanDayInput[];
  settings: ChainScanSettings;
  /** The day whose whole chain is priced for the yield map, when it is one of `days`. */
  chainMapDate: string | null;
}

export interface ChainScanWorkerResponse {
  rows: ChainScanDayRow[];
  chainMap: ChainMapContract[] | null;
}

parentPort?.on("message", (request: ChainScanWorkerRequest) => {
  try {
    const database = new DatabaseSync(request.filePath, { readOnly: true });
    try {
      const file = new BacktestSymbolFile(database);
      const rows = request.days.map((day) => scanChainDay(file, day, request.settings));
      const mapDay = request.days.find((day) => day.date === request.chainMapDate) ?? null;
      const chainMap = mapDay === null ? null : priceChainMap(file.loadQuotes(mapDay.date), mapDay, volumeByContract(mapDay.previousDate === null ? null : file.loadEndOfDay(mapDay.previousDate)));
      parentPort!.postMessage({ ok: true, response: { rows, chainMap } satisfies ChainScanWorkerResponse });
    } finally {
      database.close();
    }
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
});
