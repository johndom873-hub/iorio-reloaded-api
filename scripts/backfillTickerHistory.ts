import "dotenv/config";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { backfillOneYearOfTickerHistory } from "../src/ibkr/priceBarCache.js";

// Reusable backfill for the two indicator thresholds that need real history
// (MA99 for Trend, ivMetrics' 20-day minimum for IV Percentile) — replaces
// the two one-off tmp/backfillDailyPriceBars.ts and
// tmp/backfillAndVerifyIvMetrics.ts scripts (2026-08-31/2026-09-01), which
// covered price and IV separately. The shortlist-add path
// (findOrCreateTicker.ts) now backfills both automatically going forward;
// this script exists for topping up tickers that predate that change, or
// for a one-off re-run after a data gap.
//
// Same ticker population as the nightly job (scripts/run-daily-market-data-job.ts)
// — shortlisted or backing an open position — since untracked tickers get no
// ongoing updates either. 1Y is a rolling IBKR duration, not a calendar
// year, so this always pulls whatever's actually needed relative to today.
//
// Usage: npm run backfill:ticker-history [-- SYMBOL ...]
// With no args, backfills every shortlisted/open-position ticker.

interface TickerRow {
  id: string;
  symbol: string;
}

let nextReqId = 1;

async function main(): Promise<void> {
  const requestedSymbols = process.argv.slice(2);

  const tickers: TickerRow[] =
    requestedSymbols.length > 0
      ? await db("tickers").whereIn("symbol", requestedSymbols).select("id", "symbol")
      : await db
          .raw(
            `
      SELECT DISTINCT t.id, t.symbol
      FROM tickers t
      WHERE EXISTS (SELECT 1 FROM shortlist_entries se WHERE se.ticker_id = t.id AND se.removed_at IS NULL)
         OR EXISTS (SELECT 1 FROM positions p WHERE p.ticker_id = t.id AND p.status = 'open')
      ORDER BY t.symbol
      `,
          )
          .then((result) => result.rows);

  if (tickers.length === 0) {
    console.log("No matching tickers found.");
    return;
  }

  console.log(`Backfilling price + IV history for ${tickers.length} ticker(s): ${tickers.map((t) => t.symbol).join(", ")}`);

  const connection = await connectToIbkrGateway();
  let succeeded = 0;
  const failed: string[] = [];

  try {
    for (const ticker of tickers) {
      try {
        const count = await backfillOneYearOfTickerHistory(connection, ticker.id, ticker.symbol, nextReqId);
        nextReqId += 2; // backfillOneYearOfTickerHistory uses reqId and reqId+1000
        console.log(`${ticker.symbol}: upserted ${count} daily bar(s).`);
        succeeded++;
      } catch (error) {
        console.warn(`${ticker.symbol}: backfill failed — ${error instanceof Error ? error.message : error}`);
        failed.push(ticker.symbol);
      }
    }
  } finally {
    connection.disconnect();
  }

  console.log(`Done: ${succeeded}/${tickers.length} succeeded.${failed.length > 0 ? ` Failed: ${failed.join(", ")}` : ""}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
