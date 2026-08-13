// Daily job: captures implied volatility + average option volume for every
// ticker on the watchlist, feeding the Screener's daily cache (see
// PROGRESS.md's Screener data-source decision). Uses delayed market data
// deliberately — real-time data requires a paid IBKR subscription that
// isn't active on this account yet, but delayed data is fine for a snapshot
// captured after market close, and needs no subscription at all.
//
// Usage:
//   npm run capture-screener-snapshot

import { EventName, MarketDataType, Stock, type TickType } from "@stoqey/ib";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway, type IbkrConnection } from "../src/ibkr/connectIbkr.js";

const snapshotTimeoutMs = 15_000;

// TickType is exported as a type only, not a runtime enum, so these mirror
// its fixed protocol values directly (interactivebrokers.github.io/tws-api/tick_types.html).
const OPTION_IMPLIED_VOL_TICK = 24;
const AVG_OPT_VOLUME_TICK = 87;

interface TickerRow {
  id: string;
  symbol: string;
}

interface CapturedSnapshot {
  impliedVolatility: number | null;
  avgOptionVolume: number | null;
}

function captureOneTicker(connection: IbkrConnection, reqId: number, symbol: string): Promise<CapturedSnapshot> {
  return new Promise((resolve) => {
    const snapshot: CapturedSnapshot = { impliedVolatility: null, avgOptionVolume: null };
    let settled = false;

    const haveBoth = () => snapshot.impliedVolatility !== null && snapshot.avgOptionVolume !== null;

    const onTick = (tickReqId: number, field: TickType | undefined, value: number | undefined) => {
      if (tickReqId !== reqId || value === undefined) return;
      if ((field as unknown as number) === OPTION_IMPLIED_VOL_TICK) snapshot.impliedVolatility = value;
      if ((field as unknown as number) === AVG_OPT_VOLUME_TICK) snapshot.avgOptionVolume = value;
      if (haveBoth()) finish();
    };

    const timer = setTimeout(finish, snapshotTimeoutMs);

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.ib.off(EventName.tickGeneric, onTick);
      connection.ib.off(EventName.tickSize, onTick);
      connection.ib.cancelMktData(reqId);
      resolve(snapshot);
    }

    connection.ib.on(EventName.tickGeneric, onTick);
    connection.ib.on(EventName.tickSize, onTick);

    // Generic ticks 105 (Average Option Volume) + 106 (Option Implied
    // Volatility) only work as a streaming subscription — IBKR rejects them
    // under snapshot=true with error 321 ("Snapshot market data subscription
    // is not applicable to generic ticks"), confirmed by testing against the
    // real paper Gateway. So this opens a stream and explicitly cancels it
    // once both values arrive (or the timeout fires) instead.
    connection.ib.reqMktData(reqId, new Stock(symbol, "SMART", "USD"), "105,106", false, false);
  });
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
      const snapshot = await captureOneTicker(connection, currentReqId, ticker.symbol);

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
