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
import type { IbkrConnection } from "../src/ibkr/connectIbkr.js";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { captureMarketDataSnapshot } from "../src/ibkr/captureMarketDataSnapshot.js";
import { lookupLatestDailyBar } from "../src/ibkr/fetchTickerOverview.js";
import { runJob } from "../src/lib/runJob.js";

interface TickerRow {
  id: string;
  symbol: string;
}

let nextReqId = 1;

// One ticker's failure (e.g. lookupLatestDailyBar's historical-data
// timeout — reproduced in prod 2026-08-20 on AAOI, which killed the whole
// batch and lost every ticker after it alphabetically, before this
// try/catch existed) must not take down the rest of the batch, matching
// the per-ticker resilience already used elsewhere (captureMarketDataSnapshot
// itself never throws). Returns true/false rather than throwing so the
// caller can track and retry failures.
async function captureTicker(connection: IbkrConnection, ticker: TickerRow, snapshotDate: string): Promise<boolean> {
  try {
    const snapshot = await captureMarketDataSnapshot(connection, nextReqId++, ticker.symbol);
    await db("market_data_snapshots")
      .insert({
        ticker_id: ticker.id,
        snapshot_date: snapshotDate,
        implied_volatility: snapshot.impliedVolatility,
        avg_option_volume: snapshot.avgOptionVolume,
      })
      .onConflict(["ticker_id", "snapshot_date"])
      .merge();

    const bar = await lookupLatestDailyBar(connection, ticker.symbol, nextReqId++);
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
    return true;
  } catch (error) {
    console.warn(`${ticker.symbol}: capture failed — ${error instanceof Error ? error.message : error}`);
    return false;
  }
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
    let succeeded = 0;
    let failedTickers: TickerRow[] = [];

    try {
      for (const ticker of tickers) {
        const ok = await captureTicker(connection, ticker, snapshotDate);
        if (ok) succeeded++;
        else failedTickers.push(ticker);
      }

      // End-of-batch retry pass, approved 2026-08-20 after both a prod
      // failure (AAOI) and an all-tickers-timed-out run locally on the same
      // day showed this specific IBKR call (historical daily bar) fails
      // often enough to be worth one retry, not just skip-and-move-on. Runs
      // after the full first pass (not immediately per-ticker), since a
      // broader IBKR-side moment affecting every ticker at once — which is
      // what happened locally — needs the pass itself to finish first
      // before retrying has any chance of hitting a clear window.
      if (failedTickers.length > 0) {
        console.log(`Retrying ${failedTickers.length} failed ticker(s)...`);
        const stillFailed: TickerRow[] = [];
        for (const ticker of failedTickers) {
          const ok = await captureTicker(connection, ticker, snapshotDate);
          if (ok) succeeded++;
          else stillFailed.push(ticker);
        }
        failedTickers = stillFailed;
      }
    } finally {
      connection.disconnect();
    }

    const failed = failedTickers.length;
    console.log(`Captured ${succeeded}/${tickers.length} ticker(s) for ${snapshotDate} (${failed} failed after retry).`);
    return {
      details: { tickerCount: tickers.length, succeeded, failed, failedSymbols: failedTickers.map((t) => t.symbol) },
      notify:
        failed > 0
          ? `⚠️ Daily market data capture: ${failed}/${tickers.length} ticker(s) failed even after retry (${failedTickers.map((t) => t.symbol).join(", ")}).`
          : undefined,
    };
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
