import "dotenv/config";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { backfillDailyHistoryForBacktest, backtestHistoryStartDate, describeBacktestHistoryBackfill, isIbkrPacingOrOutageError } from "../src/backtest/backfillDailyHistory.js";
import { lastFinishedBacktestSessionDate } from "../src/backtest/jobs/backtestJobRules.js";

// One-off IBKR history for backtesting (docs/backtesting/DATA-FILES.md): daily bars and daily implied volatility back to
// 2016-01-01 for every ticker in the local DB, or the symbols given. Only missing days are inserted (see
// backfillDailyHistory.ts). Read-only historical requests through the Gateway the local API uses.
//
// Pacing: tickers run one at a time, 2 historical requests each, with a pause between tickers; a timeout or a pacing
// answer stops the run (IBKR's historical-data pacing has caused hour-long outages), so nothing hammers it.
//
// Usage: npm run backtest:backfill-history [-- SYMBOL ...]

const pauseBetweenTickersMilliseconds = 10_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const requestedSymbols = process.argv.slice(2).map((symbol) => symbol.trim().toUpperCase()).filter((symbol) => symbol !== "");
  const tickers: { id: string; symbol: string }[] =
    requestedSymbols.length > 0 ? await db("tickers").whereIn("symbol", requestedSymbols).orderBy("symbol").select("id", "symbol") : await db("tickers").orderBy("symbol").select("id", "symbol");
  const unknownSymbols = requestedSymbols.filter((symbol) => !tickers.some((ticker) => ticker.symbol === symbol));
  if (unknownSymbols.length > 0) console.warn(`Not in the local tickers table, skipped: ${unknownSymbols.join(", ")}`);
  if (tickers.length === 0) {
    console.log("No matching tickers found.");
    return;
  }

  const lastDateToStore = lastFinishedBacktestSessionDate(new Date());
  console.log(`Daily bars and implied volatility from ${backtestHistoryStartDate} to ${lastDateToStore} for ${tickers.length} ticker(s): ${tickers.map((ticker) => ticker.symbol).join(", ")}`);

  const connection = await connectToIbkrGateway();
  let requestId = 1;
  const nextRequestId = () => requestId++;
  const failed: string[] = [];
  let stoppedAt: string | null = null;
  try {
    for (const [index, ticker] of tickers.entries()) {
      if (index > 0) await sleep(pauseBetweenTickersMilliseconds);
      try {
        const result = await backfillDailyHistoryForBacktest(connection, ticker, { lastDateToStore, nextRequestId });
        console.log(describeBacktestHistoryBackfill(result));
        if (result.impliedVolatilityError && isIbkrPacingOrOutageError(result.impliedVolatilityError)) {
          stoppedAt = ticker.symbol;
          console.warn(`Stopping: IBKR is pacing or not answering (${result.impliedVolatilityError}).`);
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`${ticker.symbol}: failed — ${message}`);
        failed.push(ticker.symbol);
        if (isIbkrPacingOrOutageError(error)) {
          stoppedAt = ticker.symbol;
          console.warn("Stopping: IBKR is pacing or not answering.");
          break;
        }
      }
    }
  } finally {
    connection.disconnect();
  }

  const notAttempted = stoppedAt ? tickers.slice(tickers.findIndex((ticker) => ticker.symbol === stoppedAt) + 1).map((ticker) => ticker.symbol) : [];
  console.log(
    `Done: ${tickers.length - failed.length - notAttempted.length}/${tickers.length} succeeded.` +
      `${failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : ""}${notAttempted.length > 0 ? ` Not attempted (stopped): ${notAttempted.join(", ")}.` : ""}`,
  );
  if (failed.length > 0 || notAttempted.length > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
