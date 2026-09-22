// Scheduled job: nightly option-chain archive (IORIO Signal Engine, Phase 0),
// chained with the SVI surface fit (2026-09-22) and the trade-alert scan
// (approved 2026-09-21: capture first, then alerts immediately after; the fit
// sits between them. Alerts ALWAYS run, even if the capture or the fit fails,
// so a data-collection problem never silences the daily workflow).
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
import { runScheduledTradeAlertJob } from "../src/ibkr/runScheduledTradeAlertJob.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { isWithinChainCaptureClockWindow } from "../src/lib/optionChainCaptureClock.js";
import { easternDateIso } from "../src/lib/marketSessionStatus.js";
import { runOptionSurfaceFitJob } from "../src/lib/runOptionSurfaceFitJob.js";
import { runJob } from "../src/lib/runJob.js";

async function main(): Promise<void> {
  const forced = process.argv.includes("--force");
  if (!forced && !isWithinChainCaptureClockWindow(new Date())) {
    console.log("Skipping option_chain_capture — outside the 10:00-10:30 ET window (the other DST-paired Scheduler entry handles today).");
    return;
  }
  if (await isMarketClosedToday()) {
    console.log("Skipping option_chain_capture and trade alerts — market closed today.");
    return;
  }

  try {
    await runJob(
      "option_chain_capture",
      async () => {
        const result = await runOptionChainCapture((event) => {
          if (event.type === "tickerStart") console.log(`${event.symbol}: capturing ${event.contractCount} contracts (window from ${event.referenceVolatilitySource}).`);
          else if (event.type === "tickerDone") console.log(`${event.symbol}: ${event.status} — ${event.coverage.contractsWithAnyTick}/${event.coverage.contractsRequested} with ticks.`);
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
    // Already recorded/notified by runJob — the alerts below must still run.
    console.error(`option_chain_capture failed, continuing to trade alerts: ${error instanceof Error ? error.message : error}`);
  }

  // Fit tonight's surfaces from the snapshots just captured. Like the capture, a failure here is
  // recorded by runJob and must never block the alert scan below.
  try {
    await runOptionSurfaceFitJob(easternDateIso(new Date()), { triggeredBy: "scheduler" });
  } catch (error) {
    console.error(`option_surface_fit failed, continuing to trade alerts: ${error instanceof Error ? error.message : error}`);
  }

  await runScheduledTradeAlertJob();
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
