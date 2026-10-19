import "dotenv/config";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { normalizeBacktestSymbol } from "../src/backtest/backtestDataDirectory.js";
import { readFirstOptionDay } from "../src/backtest/backtestDataFile.js";
import { listBacktestDataFileSymbols } from "../src/backtest/dataFileSummary.js";
import { refreshSplitScheduleForSymbol } from "../src/backtest/engine/splitFactors.js";
import { lastFinishedBacktestSessionDate } from "../src/backtest/jobs/backtestJobRules.js";
import { findUnfinishedDownloadJob } from "../src/backtest/jobs/backtestJobStore.js";
import { describeFileStockBarsRefresh, refreshFileStockBars } from "../src/backtest/refreshFileStockBars.js";

// The IBKR stock bars of the data files already downloaded (src/backtest/refreshFileStockBars.ts), then each file's split
// schedule: every file, or the symbols given. A symbol whose download is running is skipped (run this again for it once
// that ends); a queued one is not, its job refreshes the bars again when it ends. One read-only historical request at a
// time through the Gateway the local API uses, 10 s apart.
//
// Usage: npm run backtest:backfill-file-stock-bars [-- SYMBOL ...]

const pauseBetweenRequestsMilliseconds = 10_000;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, pauseBetweenRequestsMilliseconds));

async function main(): Promise<void> {
  const requested = process.argv.slice(2).map(normalizeBacktestSymbol);
  const symbols = requested.length > 0 ? requested : listBacktestDataFileSymbols();
  const lastDateToStore = lastFinishedBacktestSessionDate(new Date());
  const failed: string[] = [];
  const connection = await connectToIbkrGateway();
  let requestId = 1;
  let requestsMade = false;
  try {
    for (const symbol of symbols) {
      if ((await findUnfinishedDownloadJob(symbol))?.status === "running") {
        console.log(`${symbol}: its download is running. Skipped: run this again for it once the download ends.`);
        continue;
      }
      const firstOptionDay = readFirstOptionDay(symbol);
      if (firstOptionDay === null) {
        console.log(`${symbol}: no data file, or no option day in it. Skipped.`);
        continue;
      }
      if (requestsMade) await pause();
      requestsMade = true;
      try {
        const result = await refreshFileStockBars(connection, symbol, {
          firstOptionDay,
          lastDateToStore,
          nextRequestId: () => requestId++,
          pause,
          onRequest: (label, done, total) => console.log(`${symbol}: ${label} (${done + 1} of ${total})`),
        });
        console.log(describeFileStockBarsRefresh(result));
        const schedule = await refreshSplitScheduleForSymbol(symbol);
        console.log(`${symbol}: ${schedule ? `${schedule.splits.length} split(s) detected${schedule.unresolved.length > 0 ? `, ${schedule.unresolved.length} stretch(es) with no settled price scale` : ""}` : "no split schedule"}`);
      } catch (error) {
        failed.push(symbol);
        console.error(`${symbol}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    connection.disconnect();
  }
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
