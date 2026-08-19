// Scheduled job #1 (see PROGRESS.md's Scheduled jobs plan): captures
// implied volatility + average option volume (market_data_snapshots) and
// backfills the latest daily OHLCV bar (daily_price_bars) for every ticker
// that's either currently shortlisted or backs an open position — not
// every ticker ever created, since a ticker removed from the shortlist
// with no open position doesn't need continued daily updates. Runs once,
// shortly after US market close. Uses delayed market data deliberately —
// real-time data requires a paid IBKR subscription that isn't active on
// this account yet, but delayed data is fine for a snapshot captured after
// market close, and needs no subscription at all.
//
// Usage (dev):
//   npm run job:daily-market-data
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-daily-market-data-job.js

import { EventName, MarketDataType } from "@stoqey/ib";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { captureMarketDataSnapshot } from "../src/ibkr/captureMarketDataSnapshot.js";
import { lookupLatestDailyBar } from "../src/ibkr/fetchTickerOverview.js";
import { runJob } from "../src/lib/runJob.js";

interface TickerRow {
  id: string;
  symbol: string;
}

async function main(): Promise<void> {
  await runJob("daily_market_data_capture", async () => {
    const tickers: TickerRow[] = await db.raw(
      `
      SELECT DISTINCT t.id, t.symbol
      FROM tickers t
      WHERE EXISTS (SELECT 1 FROM shortlist_entries se WHERE se.ticker_id = t.id AND se.removed_at IS NULL)
         OR EXISTS (SELECT 1 FROM positions p WHERE p.ticker_id = t.id AND p.status = 'open')
      ORDER BY t.symbol
      `,
    ).then((result) => result.rows);

    if (tickers.length === 0) {
      console.log("No shortlisted tickers or open positions — nothing to capture.");
      return { details: { tickerCount: 0, succeeded: 0 } };
    }

    console.log(`Connecting to IBKR Gateway to capture ${tickers.length} ticker(s)...`);
    const connection = await connectToIbkrGateway();
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);

    // reqId -1 is the connection-status channel already filtered in
    // connectIbkr.ts; per-ticker errors (e.g. "symbol not found") land here
    // instead and shouldn't crash the whole batch.
    connection.ib.on(EventName.error, (error, _code, reqId) => {
      if (reqId === -1) return;
      console.warn(`IBKR warning on reqId ${reqId}: ${error.message}`);
    });

    const snapshotDate = new Date().toISOString().slice(0, 10);
    let reqId = 1;
    let succeeded = 0;

    try {
      for (const ticker of tickers) {
        const snapshot = await captureMarketDataSnapshot(connection, reqId++, ticker.symbol);
        await db("market_data_snapshots")
          .insert({
            ticker_id: ticker.id,
            snapshot_date: snapshotDate,
            implied_volatility: snapshot.impliedVolatility,
            avg_option_volume: snapshot.avgOptionVolume,
          })
          .onConflict(["ticker_id", "snapshot_date"])
          .merge();

        const bar = await lookupLatestDailyBar(connection, ticker.symbol, reqId++);
        if (bar) {
          const tradingDate = new Date(bar.time * 1000).toISOString().slice(0, 10);
          await db("daily_price_bars")
            .insert({
              ticker_id: ticker.id,
              trading_date: tradingDate,
              open_price: bar.open,
              high_price: bar.high,
              low_price: bar.low,
              close_price: bar.close,
              volume: bar.volume,
            })
            .onConflict(["ticker_id", "trading_date"])
            .merge();
        }

        console.log(
          `${ticker.symbol}: IV=${snapshot.impliedVolatility ?? "n/a"} avgOptVolume=${snapshot.avgOptionVolume ?? "n/a"} bar=${bar ? `${bar.close}` : "n/a"}`,
        );
        succeeded++;
      }
    } finally {
      connection.disconnect();
    }

    console.log(`Captured ${succeeded}/${tickers.length} ticker(s) for ${snapshotDate}.`);
    return { details: { tickerCount: tickers.length, succeeded } };
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
