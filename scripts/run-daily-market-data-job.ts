// Daily job: captures implied volatility + average option volume for every
// ticker on the watchlist, feeding the Screener's daily cache (see
// PROGRESS.md's Screener data-source decision). Uses delayed market data
// deliberately — real-time data requires a paid IBKR subscription that
// isn't active on this account yet, but delayed data is fine for a snapshot
// captured after market close, and needs no subscription at all.
//
// Usage:
//   npm run capture-screener-snapshot

import { EventName, MarketDataType } from "@stoqey/ib";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { captureMarketDataSnapshot } from "../src/ibkr/captureMarketDataSnapshot.js";

interface TickerRow {
  id: string;
  symbol: string;
}

async function main(): Promise<void> {
  const tickers: TickerRow[] = await db("tickers").select("id", "symbol").orderBy("symbol");
  if (tickers.length === 0) {
    console.log("No tickers on the watchlist yet — nothing to capture.");
    return;
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
      const currentReqId = reqId++;
      const snapshot = await captureMarketDataSnapshot(connection, currentReqId, ticker.symbol);

      await db("market_data_snapshots")
        .insert({
          ticker_id: ticker.id,
          snapshot_date: snapshotDate,
          implied_volatility: snapshot.impliedVolatility,
          avg_option_volume: snapshot.avgOptionVolume,
        })
        .onConflict(["ticker_id", "snapshot_date"])
        .merge();

      console.log(
        `${ticker.symbol}: IV=${snapshot.impliedVolatility ?? "n/a"} avgOptVolume=${snapshot.avgOptionVolume ?? "n/a"}`,
      );
      succeeded++;
    }
  } finally {
    connection.disconnect();
  }

  console.log(`Captured ${succeeded}/${tickers.length} ticker(s) for ${snapshotDate}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
