import "dotenv/config";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { fetchAndStoreFiveYearHistory } from "../src/ibkr/tickerBackfillPipeline.js";
import { loadCaptureUniverse } from "../src/ibkr/runOptionChainCapture.js";

// One-off 5-year daily-history backfill for the IORIO Signal Engine (Phase 0):
// the Yang-Zhang realized-volatility windows (up to 126 days), the IV history
// and, later, the backtest all need more than the 1 year the shortlist-add path
// pulls. Bars are stored UNADJUSTED (WhatToShow.TRADES), so before writing,
// each ticker's fetched bars are run through the split guard and any suspected
// split is printed — that is the check that the guard flags e.g. SMCI's
// Oct-2024 10:1 split on real data.
//
// Pacing (needs Marcelo's approval, see PROGRESS.md): tickers run one at a
// time, 2 IBKR historical requests each (TRADES + implied volatility), with a
// pause between tickers. IBKR's historical-data pacing has caused hour-long
// outages before, so the default is deliberately gentle.
//
// Usage:
//   npm run backfill:signal-engine-history -- --dry-run            (fetch + report, writes nothing)
//   npm run backfill:signal-engine-history -- --dry-run SMCI       (specific symbols)
//   npm run backfill:signal-engine-history                         (writes; universe = shortlist + held)

const pauseBetweenTickersMs = 10_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const dryRun = arguments_.includes("--dry-run");
  const requestedSymbols = arguments_.filter((argument) => !argument.startsWith("--")).map((symbol) => symbol.toUpperCase());

  const universe = await loadCaptureUniverse();
  const tickers = requestedSymbols.length > 0 ? universe.filter((ticker) => requestedSymbols.includes(ticker.symbol)) : universe;
  const unknownSymbols = requestedSymbols.filter((symbol) => !tickers.some((ticker) => ticker.symbol === symbol));
  if (unknownSymbols.length > 0) console.warn(`Not in shortlist/held universe, skipped: ${unknownSymbols.join(", ")}`);
  if (tickers.length === 0) {
    console.log("No matching tickers found.");
    return;
  }

  console.log(`${dryRun ? "DRY RUN — nothing will be written. " : ""}Fetching 5 years of daily history for ${tickers.length} ticker(s): ${tickers.map((ticker) => ticker.symbol).join(", ")}`);

  const connection = await connectToIbkrGateway();
  const failed: string[] = [];
  let nextReqId = 1;
  try {
    for (const [index, ticker] of tickers.entries()) {
      if (index > 0) await sleep(pauseBetweenTickersMs);
      try {
        const summary = await fetchAndStoreFiveYearHistory(connection, ticker.tickerId, ticker.symbol, { dryRun, reqId: nextReqId });
        nextReqId += 2;
        console.log(
          `${ticker.symbol}: ${summary.barCount} bars ${summary.firstTradingDate}..${summary.lastTradingDate}, ${summary.ivPointCount} IV points` +
            `${summary.suspectedSplitDates.length > 0 ? `, SUSPECTED SPLIT: ${summary.suspectedSplitDates.join(", ")}` : ""}` +
            `${summary.invalidBarDates.length > 0 ? `, INVALID BARS: ${summary.invalidBarDates.join(", ")}` : ""}` +
            `${dryRun ? "" : " — written"}`,
        );
      } catch (error) {
        console.warn(`${ticker.symbol}: failed — ${error instanceof Error ? error.message : error}`);
        failed.push(ticker.symbol);
      }
    }
  } finally {
    connection.disconnect();
  }
  console.log(`Done: ${tickers.length - failed.length}/${tickers.length} succeeded.${failed.length > 0 ? ` Failed: ${failed.join(", ")}` : ""}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
