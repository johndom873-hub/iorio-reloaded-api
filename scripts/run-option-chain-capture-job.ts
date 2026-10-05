// Scheduled job: nightly option-chain TICKS capture (IORIO Signal Engine,
// Phase 0), chained with the SVI surface fit (2026-09-22). The fit depends on
// this job's output (it fits from the snapshots just captured).
//
// Chain STRUCTURE (expiries + strike grids) is no longer refreshed here —
// split off 2026-09-23 into run-option-chain-structure-job.ts, which runs
// pre-market (09:00 UTC) since structure has no market-open dependency. This
// job reads that structure from the DB and only needs the market open for
// the ticks themselves, hence the later window below.
//
// Heroku Scheduler is fixed-UTC, so two entries are scheduled (14:00 and 15:00
// UTC) and the clock guard lets only the one that lands in 10:00-10:30 ET run;
// pass --force to bypass the guard for a manual run.
//
// Flow: capture -> fit -> retry rounds (tickers whose surface came out unusable are
// re-captured and re-fitted, up to 3 attempts in all, see runOptionChainCaptureRetries.ts)
// -> Day Signals seed.
//
// Usage (dev):  npm run job:option-chain-capture [-- --force]
// Usage (prod): node dist/scripts/run-option-chain-capture-job.js

import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import { db } from "../src/db/connection.js";
import { sharedReadConnection } from "../src/ibkr/sharedReadConnection.js";
import { buildCaptureFailureMessage, runOptionChainCapture, type OptionChainCaptureEvent } from "../src/ibkr/runOptionChainCapture.js";
import { buildCaptureRetryFailureMessage, buildDefaultCaptureRetryDependencies, runCaptureRetryRounds } from "../src/ibkr/runOptionChainCaptureRetries.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { isWithinChainCaptureClockWindow } from "../src/lib/optionChainCaptureClock.js";
import { easternDateIso } from "../src/lib/marketSessionStatus.js";
import { runOptionSurfaceFitJob } from "../src/lib/runOptionSurfaceFitJob.js";
import { runJob } from "../src/lib/runJob.js";
import { buildSeedFailureMessage, seedDaySignals } from "../src/lib/daySignalsSeed.js";

// This job has no user waiting on latency, so it would rather queue behind
// the shared connection's own reconnect (backoff caps at 60s, see
// sharedReadConnection.ts) than fall back to a one-shot connection the
// moment it drops — a burst of independent one-shot fallbacks mid-run is
// what turned a single dropped connection into a cascade of "competing live
// session" errors against the VPS worker (found 2026-09-23).
sharedReadConnection.setBorrowTimeoutMs(60_000);

// ~20 minutes observed for 21 tickers (2026-09-23), growing with the
// shortlist — see RunJobOptions.staleRunningJobThresholdMs.
const optionChainCaptureStaleRunningThresholdMs = 60 * 60 * 1000;

function logCaptureEvent(event: OptionChainCaptureEvent): void {
  if (event.type === "tickerStart") {
    console.log(`${event.symbol}: capturing ${event.contractCount} contracts (window from ${event.referenceVolatilitySource}).`);
  } else if (event.type === "tickerDone") console.log(`${event.symbol}: ${event.status} — ${event.coverage.contractsWithAnyTick}/${event.coverage.contractsRequested} with ticks.`);
  else if (event.type === "tickerError") console.warn(`${event.symbol}: capture failed — ${event.message}`);
  else console.log(`Re-capturing starved tickers: ${event.symbols.join(", ")}`);
}

async function main(): Promise<void> {
  const forced = process.argv.includes("--force");
  if (!forced && !isWithinChainCaptureClockWindow(new Date())) {
    console.log("Skipping option_chain_capture — outside the 10:00-10:30 ET window (the other DST-paired Scheduler entry handles today).");
    return;
  }
  if (await isMarketClosedToday()) {
    console.log("Skipping option_chain_capture — market closed today.");
    return;
  }

  try {
    await runJob(
      "option_chain_capture",
      async () => {
        const result = await runOptionChainCapture(logCaptureEvent);
        console.log(`Chain capture: ${result.tickersComplete} complete, ${result.tickersPartial} partial, ${result.tickersFailed} failed of ${result.tickersAttempted}.`);
        // A run where tickers failed, or that saved every snapshot without a risk-free rate, is recorded
        // as a failure (runJob alerts), not a "success" that hides it; failed tickers also have failed snapshot rows.
        return { details: { ...result }, failureMessage: buildCaptureFailureMessage(result) };
      },
      { triggeredBy: "scheduler", staleRunningJobThresholdMs: optionChainCaptureStaleRunningThresholdMs },
    );
  } catch (error) {
    // Already recorded/notified by runJob — the fit below must still run
    // (per-ticker snapshots already saved so far are still worth fitting).
    console.error(`option_chain_capture failed, continuing to the surface fit: ${error instanceof Error ? error.message : error}`);
  }

  // Fit tonight's surfaces from the snapshots just captured. Failure here is
  // recorded by runJob's own try/catch inside runOptionSurfaceFitJob.
  const tradingDateIso = easternDateIso(new Date());
  await runOptionSurfaceFitJob(tradingDateIso, { triggeredBy: "scheduler" });

  // Re-capture and re-fit the tickers whose surface came out unusable. A failure here is recorded/alerted
  // by runJob and never blocks the seed below.
  await runJob(
    "option_chain_capture_retry",
    async () => {
      const retry = await runCaptureRetryRounds(tradingDateIso, buildDefaultCaptureRetryDependencies(logCaptureEvent));
      console.log(`Capture retry: ${retry.roundSymbols.length === 0 ? "nothing to retry" : retry.roundSymbols.map((symbols, index) => `attempt ${index + 2}: ${symbols.join(", ")}`).join("; ")}; still failing: ${retry.stillFailingSymbols.join(", ") || "-"}.`);
      return { details: { ...retry }, failureMessage: buildCaptureRetryFailureMessage(retry) };
    },
    { triggeredBy: "scheduler", staleRunningJobThresholdMs: optionChainCaptureStaleRunningThresholdMs },
  ).catch((error) => console.error(`option_chain_capture_retry failed, continuing to the seed: ${error instanceof Error ? error.message : error}`));

  // Seed the Day Signals pool from the snapshots + fits just written; the
  // refresh loop on the web dyno picks it up on its next state check. A
  // failure is recorded/alerted by runJob and never affects the capture or
  // fit already saved.
  await runJob(
    "day_signals_seed",
    async () => {
      const seed = await seedDaySignals(tradingDateIso);
      console.log(`Day Signals seed: ${seed.tickersPooled}/${seed.tickersScored} tickers pooled, ${seed.expiriesPooled} expiries; no pool: ${seed.symbolsWithoutPool.join(", ") || "-"}; no snapshot today: ${seed.symbolsWithoutTodaySnapshot.join(", ") || "-"}.`);
      return { details: { ...seed }, failureMessage: buildSeedFailureMessage(seed) };
    },
    { triggeredBy: "scheduler" },
  ).catch((error) => console.error(`day_signals_seed failed: ${error instanceof Error ? error.message : error}`));
}

// The capture reads spot prices through the lazy shared IBKR connection, which
// otherwise keeps this one-off process alive forever (see shutdown()).
runScript("run-option-chain-capture-job", main, async () => {
  await sharedReadConnection.shutdown();
  await db.destroy();
});
