import "dotenv/config";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { lastFinishedBacktestSessionDate } from "../src/backtest/jobs/backtestJobRules.js";
import { backfillMarketStressBars, marketStressHistoryStartYear, marketStressSymbol } from "../src/backtest/marketStressBars.js";

// SPY's 30-minute bars for the backtest's market-stress check (src/backtest/marketStressBars.ts), from 2020 to the last
// finished session, into the local DB. One read-only historical request per calendar year through the Gateway the local
// API uses, 10 s apart; only bars not stored yet are written, so it is also the top-up.
//
// Usage: npm run backtest:backfill-market-stress-bars [-- <first year>]

const pauseBetweenRequestsMilliseconds = 10_000;

async function main(): Promise<void> {
  const firstYearArgument = process.argv[2];
  const fromYear = firstYearArgument === undefined ? marketStressHistoryStartYear : Number(firstYearArgument);
  if (!Number.isInteger(fromYear) || fromYear < 2000) throw new Error(`The first year must be a year, got ${firstYearArgument}.`);
  const lastDateToStore = lastFinishedBacktestSessionDate(new Date());
  console.log(`${marketStressSymbol} 30-minute bars from ${fromYear} to ${lastDateToStore}`);
  const connection = await connectToIbkrGateway();
  let requestId = 1;
  try {
    await backfillMarketStressBars(connection, {
      fromYear,
      lastDateToStore,
      nextRequestId: () => requestId++,
      pause: () => new Promise((resolve) => setTimeout(resolve, pauseBetweenRequestsMilliseconds)),
      onYear: (year) => console.log(`${year.year}: ${year.fetchedBars} bars fetched, ${year.insertedBars} inserted`),
    });
  } finally {
    connection.disconnect();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
