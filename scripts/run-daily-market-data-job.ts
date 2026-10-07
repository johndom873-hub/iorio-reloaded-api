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

import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import { EventName, WhatToShow } from "@stoqey/ib";
import type { IbkrConnection } from "../src/ibkr/connectIbkr.js";
import { normalizeBarVolume } from "../src/lib/normalizeBarVolume.js";
import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { isDelayedDataFallbackNotice, requestRealtimeMarketData } from "../src/ibkr/requestMarketData.js";
import { captureMarketDataSnapshot } from "../src/ibkr/captureMarketDataSnapshot.js";
import { lookupLatestDailyBar } from "../src/ibkr/fetchTickerOverview.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { assessDailyBar, buildMarketDataFailureMessage, type TickerProblem } from "../src/lib/marketDataJobOutcome.js";
import { lastCompletedSessionDate } from "../src/lib/marketSessionStatus.js";
import { runJob } from "../src/lib/runJob.js";

interface TickerRow {
  id: string;
  symbol: string;
  /** Signals on, or an open position: a Signals-off shortlist ticker gets its price and IV history bars only. */
  capturesIvSnapshot: boolean;
}

let nextReqId = 1;

// Up to 5 total attempts (1 initial pass + 4 retries), with escalating
// backoff between retries — approved 2026-08-25 after a run where all 14
// tickers failed identically (a suspected transient IBKR historical-data
// outage around market close), and a single immediate retry wasn't enough
// to clear it. This job starts 22:00 UTC (moved from 21:00 on 2026-09-24).
// On a bad night the retries can overlap the 22:30 UTC P&L snapshot; both only make
// historical/snapshot requests (no market-data lines), so that is tolerable.
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
// itself never throws). Returns an outcome rather than throwing so the
// caller can track and retry failures. A "failed" outcome is worth a retry (no bar, or the wrong
// session's bar); softProblems (no IV) are reported but not retried, since a brand-new ticker
// with no IV history would otherwise burn all five attempts every night.
type TickerCaptureOutcome = { kind: "ok"; softProblems: string[] } | { kind: "failed"; problem: string };

async function captureTicker(connection: IbkrConnection, ticker: TickerRow, snapshotDate: string, expectedSessionDate: string): Promise<TickerCaptureOutcome> {
  try {
    const softProblems: string[] = [];
    const snapshot = ticker.capturesIvSnapshot ? await captureMarketDataSnapshot(connection, nextReqId++, ticker.symbol) : null;
    if (snapshot) {
      if (snapshot.impliedVolatility === null) softProblems.push("no IV in the snapshot");
      // A timed-out snapshot has null fields: keep whatever good value is already stored for the day.
      await db("market_data_snapshots")
        .insert({
          ticker_id: ticker.id,
          snapshot_date: snapshotDate,
          implied_volatility: snapshot.impliedVolatility,
          avg_option_volume: snapshot.avgOptionVolume,
        })
        .onConflict(["ticker_id", "snapshot_date"])
        .merge({
          implied_volatility: db.raw("COALESCE(excluded.implied_volatility, market_data_snapshots.implied_volatility)"),
          avg_option_volume: db.raw("COALESCE(excluded.avg_option_volume, market_data_snapshots.avg_option_volume)"),
        });
    }

    const bar = await lookupLatestDailyBar(connection, ticker.symbol, nextReqId++);
    // The daily IV bar isn't guaranteed the same day the price bar is (e.g. a brand-new
    // ticker with no IV history yet), so a miss doesn't fail the ticker (price data is the
    // higher-priority half of this job) but it is reported: IV rank and percentile rot without it.
    const ivBar = await lookupLatestDailyBar(connection, ticker.symbol, nextReqId++, WhatToShow.OPTION_IMPLIED_VOLATILITY).catch(() => null);
    if (ivBar === null) softProblems.push("no IV history bar");
    const barTradingDate = bar ? new Date(bar.time * 1000).toISOString().slice(0, 10) : null;
    const barProblem = assessDailyBar(barTradingDate, expectedSessionDate);
    if (bar && barTradingDate) {
      await db("daily_price_bars")
        .insert({
          ticker_id: ticker.id,
          trading_date: barTradingDate,
          open_price: bar.open,
          high_price: bar.high,
          low_price: bar.low,
          close_price: bar.close,
          volume: normalizeBarVolume(bar.volume),
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
      `${ticker.symbol}: ${snapshot ? `IV=${snapshot.impliedVolatility ?? "n/a"} avgOptVolume=${snapshot.avgOptionVolume ?? "n/a"}` : "IV snapshot skipped (Signals off)"} bar=${bar ? `${bar.close}` : "n/a"}${barProblem ? ` (${barProblem})` : ""}`,
    );
    return barProblem ? { kind: "failed", problem: barProblem } : { kind: "ok", softProblems };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${ticker.symbol}: capture failed — ${message}`);
    return { kind: "failed", problem: message };
  }
}

async function main(): Promise<void> {
  if (await isMarketClosedToday()) {
    console.log("Skipping daily_market_data_capture — market closed today.");
    return;
  }
  await runJob("daily_market_data_capture", async () => {
    const tickers: TickerRow[] = await db.raw(
      `
      SELECT t.id, t.symbol, (signals_on OR has_open_position) AS "capturesIvSnapshot"
      FROM (
        SELECT
          t.id,
          t.symbol,
          EXISTS (SELECT 1 FROM shortlist_entries se WHERE se.ticker_id = t.id AND se.removed_at IS NULL AND se.signals_enabled) AS signals_on,
          EXISTS (SELECT 1 FROM shortlist_entries se WHERE se.ticker_id = t.id AND se.removed_at IS NULL) AS shortlisted,
          EXISTS (SELECT 1 FROM positions p WHERE p.ticker_id = t.id AND p.status = 'open') AS has_open_position
        FROM tickers t
      ) t
      WHERE shortlisted OR has_open_position
      ORDER BY t.symbol
      `,
    ).then((result) => result.rows);

    if (tickers.length === 0) {
      console.log("No shortlisted tickers or open positions — nothing to capture.");
      return { details: { tickerCount: 0, succeeded: 0 }, failureMessage: buildMarketDataFailureMessage({ tickerCount: 0, failed: [], missingIv: [], attempts: 0, bailedOnBudget: false }) };
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

    // One date for both the stored rows and the daily-bar check: the newest session whose close has passed, not the UTC calendar
    // date (a rerun after 00:00 UTC is still the previous evening in New York).
    const expectedSessionDate = await lastCompletedSessionDate();
    const snapshotDate = expectedSessionDate;
    const failureByTickerId = new Map<string, TickerProblem>();
    const missingIvBySymbol = new Map<string, TickerProblem>();
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
              `Stopping retries — waiting ${backoff / 1000}s would exceed the ${RETRY_BUDGET_MS / 60_000}min retry budget.`,
            );
            bailedOnBudget = true;
            break;
          }
          console.log(`Waiting ${backoff / 1000}s before retry ${attempt}/${MAX_ATTEMPTS - 1} of ${remaining.length} failed ticker(s)...`);
          await sleep(backoff);
        }

        const stillFailed: TickerRow[] = [];
        for (const ticker of remaining) {
          const outcome = await captureTicker(connection, ticker, snapshotDate, expectedSessionDate);
          if (outcome.kind === "ok") {
            succeeded++;
            failureByTickerId.delete(ticker.id);
            if (outcome.softProblems.length > 0) missingIvBySymbol.set(ticker.symbol, { symbol: ticker.symbol, problem: outcome.softProblems.join(" and ") });
            else missingIvBySymbol.delete(ticker.symbol);
          } else {
            failureByTickerId.set(ticker.id, { symbol: ticker.symbol, problem: outcome.problem });
            stillFailed.push(ticker);
          }
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
      details: { tickerCount: tickers.length, succeeded, failed, attempts: attempt, bailedOnBudget, failedSymbols: remaining.map((t) => t.symbol), missingIvSymbols: [...missingIvBySymbol.keys()] },
      // Recorded as a failure (runJob alerts), not a success with a notify: the bars feed Signals.
      failureMessage: buildMarketDataFailureMessage({
        tickerCount: tickers.length,
        failed: remaining.map((ticker) => failureByTickerId.get(ticker.id) ?? { symbol: ticker.symbol, problem: "unknown" }),
        missingIv: [...missingIvBySymbol.values()],
        attempts: attempt,
        bailedOnBudget,
      }),
    };
  });
}

runScript("run-daily-market-data-job", main, () => db.destroy());
