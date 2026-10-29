import "dotenv/config";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { isIbkrPacingOrOutageError } from "../src/backtest/backfillDailyHistory.js";
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
// time through the Gateway the local API uses, 10 s apart; a timeout or a pacing answer stops the run (IBKR's
// historical-data pacing has caused hour-long outages). With --extend-daily-bars-back each file gets the daily bars from
// 2000 before its first one instead of the last month (refreshFileStockBars' extendDailyBarsBack).
//
// Usage: npm run backtest:backfill-file-stock-bars [-- [--extend-daily-bars-back] SYMBOL ...]

const pauseBetweenRequestsMilliseconds = 10_000;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, pauseBetweenRequestsMilliseconds));
const extendDailyBarsBackFlag = "--extend-daily-bars-back";

async function main(): Promise<void> {
  const flags = process.argv.slice(2).filter((argument) => argument.startsWith("--"));
  const unknownFlag = flags.find((flag) => flag !== extendDailyBarsBackFlag);
  if (unknownFlag) throw new Error(`Unknown option ${unknownFlag}; the only one is ${extendDailyBarsBackFlag}.`);
  const extendDailyBarsBack = flags.includes(extendDailyBarsBackFlag);
  const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("--")).map(normalizeBacktestSymbol);
  const symbols = requested.length > 0 ? requested : listBacktestDataFileSymbols();
  const lastDateToStore = lastFinishedBacktestSessionDate(new Date());
  const failed: string[] = [];
  let stoppedAt: string | null = null;
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
          extendDailyBarsBack,
        });
        console.log(describeFileStockBarsRefresh(result));
        const schedule = await refreshSplitScheduleForSymbol(symbol);
        console.log(`${symbol}: ${schedule ? `${schedule.splits.length} split(s) detected${schedule.unresolved.length > 0 ? `, ${schedule.unresolved.length} stretch(es) with no settled price scale` : ""}` : "no split schedule"}`);
        if (result.impliedVolatilityError && isIbkrPacingOrOutageError(result.impliedVolatilityError)) {
          stoppedAt = symbol;
          console.error("Stopping: IBKR is pacing or not answering.");
          break;
        }
      } catch (error) {
        failed.push(symbol);
        console.error(`${symbol}: ${error instanceof Error ? error.message : error}`);
        if (isIbkrPacingOrOutageError(error)) {
          stoppedAt = symbol;
          console.error("Stopping: IBKR is pacing or not answering.");
          break;
        }
      }
    }
  } finally {
    connection.disconnect();
  }
  const notAttempted = stoppedAt ? symbols.slice(symbols.indexOf(stoppedAt) + 1) : [];
  if (failed.length > 0) console.error(`Failed: ${failed.join(", ")}`);
  if (notAttempted.length > 0) console.error(`Not attempted (stopped): ${notAttempted.join(", ")}`);
  if (failed.length > 0 || notAttempted.length > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
