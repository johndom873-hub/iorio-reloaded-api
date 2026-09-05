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

import { EventName, WhatToShow } from "@stoqey/ib";
import type { IbkrConnection } from "../src/ibkr/connectIbkr.js";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { isDelayedDataFallbackNotice, requestRealtimeMarketData } from "../src/ibkr/requestMarketData.js";
import { captureMarketDataSnapshot } from "../src/ibkr/captureMarketDataSnapshot.js";
import { lookupLatestDailyBar } from "../src/ibkr/fetchTickerOverview.js";
import { isWeekend } from "../src/lib/isWeekend.js";
import { runJob } from "../src/lib/runJob.js";

interface TickerRow {
  id: string;
  symbol: string;
}

let nextReqId = 1;

// Up to 5 total attempts (1 initial pass + 4 retries), with escalating
// backoff between retries — approved 2026-08-25 after a run where all 14
// tickers failed identically (a suspected transient IBKR historical-data
// outage around market close), and a single immediate retry wasn't enough
// to clear it. This job starts ~21:00 UTC; Trade Alert generation only
// runs once/day, at 1:30 PM UTC (confirmed 2026-09-05 against actual
// Heroku Scheduler config — there is no same-day 22:00 UTC run), so it
// always consumes this job's *previous* evening's data, not same-day.
// Retries are still capped by wall-clock budget rather than just attempt
// count, so a bad run doesn't retry indefinitely into the next day's jobs.
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000];
const RETRY_BUDGET_MS = 50 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    // Best-effort — the daily IV bar isn't guaranteed the same day the price
    // bar is (e.g. a brand-new ticker with no IV history yet), and a miss
    // here shouldn't fail the whole ticker capture since price data is the
    // higher-priority half of this job.
    const ivBar = await lookupLatestDailyBar(connection, ticker.symbol, nextReqId++, WhatToShow.OPTION_IMPLIED_VOLATILITY).catch(() => null);
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
          implied_volatility: ivBar?.close ?? null,
        })
        .onConflict(["ticker_id", "trading_date"])
        .merge({
          open_price: db.raw("excluded.open_price"),
          high_price: db.raw("excluded.high_price"),
          low_price: db.raw("excluded.low_price"),
          close_price: db.raw("excluded.close_price"),
          volume: db.raw("excluded.volume"),
          implied_volatility: db.raw("COALESCE(excluded.implied_volatility, daily_price_bars.implied_volatility)"),
        });
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
  if (isWeekend()) {
    console.log("Skipping daily_market_data_capture — weekend, US market closed.");
    return;
  }
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
    requestRealtimeMarketData(connection.ib);

    // reqId -1 is the connection-status channel already filtered in
    // connectIbkr.ts; per-ticker errors (e.g. "symbol not found") land here
    // instead and shouldn't crash the whole batch.
    connection.ib.on(EventName.error, (error, code, reqId) => {
      if (reqId === -1 || isDelayedDataFallbackNotice(code)) return;
      console.warn(`IBKR warning on reqId ${reqId}: ${error.message}`);
    });

    const snapshotDate = new Date().toISOString().slice(0, 10);
    const jobStart = Date.now();
    let succeeded = 0;
    let remaining = tickers;
    let attempt = 0;
    let bailedOnBudget = false;

    try {
      while (remaining.length > 0 && attempt < MAX_ATTEMPTS) {
        if (attempt > 0) {
          const backoff = RETRY_BACKOFF_MS[attempt - 1]!;
          if (Date.now() - jobStart + backoff > RETRY_BUDGET_MS) {
            console.log(
              `Stopping retries — waiting ${backoff / 1000}s would exceed the ${RETRY_BUDGET_MS / 60_000}min retry budget before Trade Alert generation runs.`,
            );
            bailedOnBudget = true;
            break;
          }
          console.log(`Waiting ${backoff / 1000}s before retry ${attempt}/${MAX_ATTEMPTS - 1} of ${remaining.length} failed ticker(s)...`);
          await sleep(backoff);
        }

        const stillFailed: TickerRow[] = [];
        for (const ticker of remaining) {
          const ok = await captureTicker(connection, ticker, snapshotDate);
          if (ok) succeeded++;
          else stillFailed.push(ticker);
        }
        remaining = stillFailed;
        attempt++;
      }
    } finally {
      connection.disconnect();
    }

    const failed = remaining.length;
    console.log(
      `Captured ${succeeded}/${tickers.length} ticker(s) for ${snapshotDate} after ${attempt} attempt(s) (${failed} still failed${bailedOnBudget ? ", retries stopped early on time budget" : ""}).`,
    );
    return {
      details: { tickerCount: tickers.length, succeeded, failed, attempts: attempt, bailedOnBudget, failedSymbols: remaining.map((t) => t.symbol) },
      notify:
        failed > 0
          ? `⚠️ Daily market data capture: ${failed}/${tickers.length} ticker(s) failed after ${attempt} attempt(s) (${remaining.map((t) => t.symbol).join(", ")}).`
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
