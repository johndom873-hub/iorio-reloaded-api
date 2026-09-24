// Scheduled job: nightly option-chain TICKS capture (IORIO Signal Engine,
// Phase 0), chained with the SVI surface fit (2026-09-22). The fit depends on
// this job's output (it fits from the snapshots just captured); trade-alert
// generation was chained here too until 2026-09-24, when it was split back
// out to its own standalone Scheduler entry (run-trade-alert-generation-job.js)
// — it's the old trade-alerts system, unrelated to Signals (which reads
// option_chain_snapshots/option_surface_fits directly, computed fresh on
// every Signals-screen request, no trade-alert generation involved at all),
// and chaining it here was a duplicate: it was already on its own schedule,
// so it ran twice a day, the earlier of the two firing before this job's
// data even existed that day.
//
// Chain STRUCTURE (expiries + strike grids) is no longer refreshed here —
// split off 2026-09-23 into run-option-chain-structure-job.ts, which runs
// pre-market (12:00 UTC) since structure has no market-open dependency. This
// job reads that structure from the DB and only needs the market open for
// the ticks themselves, hence the later window below.
//
// Heroku Scheduler is fixed-UTC, so two entries are scheduled (14:00 and 15:00
// UTC) and the clock guard lets only the one that lands in 10:00-10:30 ET run;
// pass --force to bypass the guard for a manual run.
//
// Usage (dev):  npm run job:option-chain-capture [-- --force]
// Usage (prod): node dist/scripts/run-option-chain-capture-job.js

import { db } from "../src/db/connection.js";
import { sharedReadConnection } from "../src/ibkr/sharedReadConnection.js";
import { runOptionChainCapture } from "../src/ibkr/runOptionChainCapture.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { isWithinChainCaptureClockWindow } from "../src/lib/optionChainCaptureClock.js";
import { easternDateIso } from "../src/lib/marketSessionStatus.js";
import { runOptionSurfaceFitJob } from "../src/lib/runOptionSurfaceFitJob.js";
import { runJob } from "../src/lib/runJob.js";
import { seedDaySignals } from "../src/lib/daySignalsSeed.js";

// This job has no user waiting on latency, so it would rather queue behind
// the shared connection's own reconnect (backoff caps at 60s, see
// sharedReadConnection.ts) than fall back to a one-shot connection the
// moment it drops — a burst of independent one-shot fallbacks mid-run is
// what turned a single dropped connection into a cascade of "competing live
// session" errors against the VPS worker (found 2026-09-23).
sharedReadConnection.setBorrowTimeoutMs(60_000);

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
        const result = await runOptionChainCapture((event) => {
          if (event.type === "tickerStart") {
            console.log(`${event.symbol}: capturing ${event.contractCount} contracts (window from ${event.referenceVolatilitySource}).`);
          } else if (event.type === "tickerDone") console.log(`${event.symbol}: ${event.status} — ${event.coverage.contractsWithAnyTick}/${event.coverage.contractsRequested} with ticks.`);
          else if (event.type === "tickerError") console.warn(`${event.symbol}: capture failed — ${event.message}`);
          else console.log(`Re-capturing starved tickers: ${event.symbols.join(", ")}`);
        });
        console.log(`Chain capture: ${result.tickersComplete} complete, ${result.tickersPartial} partial, ${result.tickersFailed} failed of ${result.tickersAttempted}.`);
        // runJob's failure path handles Telegram for a thrown error; a run where
        // tickers failed is surfaced via details and the failed snapshot rows.
        return { details: { ...result } };
      },
      { triggeredBy: "scheduler" },
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

  // Seed the Day Signals pool from the snapshots + fits just written; the
  // refresh loop on the web dyno picks it up on its next state check. A
  // failure is recorded/alerted by runJob and never affects the capture or
  // fit already saved.
  await runJob(
    "day_signals_seed",
    async () => {
      const seed = await seedDaySignals(tradingDateIso);
      console.log(`Day Signals seed: ${seed.tickersPooled}/${seed.tickersScored} tickers pooled, ${seed.expiriesPooled} expiries; no pool: ${seed.symbolsWithoutPool.join(", ") || "-"}; no snapshot today: ${seed.symbolsWithoutTodaySnapshot.join(", ") || "-"}.`);
      return { details: { ...seed } };
    },
    { triggeredBy: "scheduler" },
  ).catch((error) => console.error(`day_signals_seed failed: ${error instanceof Error ? error.message : error}`));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // The capture reads spot prices through the lazy shared IBKR connection, which
  // otherwise keeps this one-off process alive forever (see shutdown()).
  .finally(async () => {
    await sharedReadConnection.shutdown();
    await db.destroy();
  });
