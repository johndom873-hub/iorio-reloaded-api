// Scheduled job: pre-market option-chain STRUCTURE refresh (expiries + each
// expiry's real strike grid) — split off run-option-chain-capture-job.ts
// 2026-09-23, since structure is plain IBKR contract-definition data with no
// dependency on the market being open, unlike the ticks that job still
// captures at 10:00 ET. Running this first means the 10:00 ET job reads
// today's structure from the DB instead of re-fetching it from IBKR.
//
// One fixed-UTC Scheduler entry (09:00 UTC), unlike the ticks job's
// DST-paired pair — this job isn't pinned to a specific ET time the way
// "30 minutes after the open" is, so it doesn't need the two-slot trick:
// 09:00 UTC is always well clear of IBKR Gateway's 05:30 UTC restart and
// ahead of the 6:00 ET pre-open readiness check (4:00 ET in winter, 5:00 ET in
// summer), which reports on today's structure.
//
// Usage (dev):  npm run job:option-chain-structure
// Usage (prod): node dist/scripts/run-option-chain-structure-job.js

import "../src/lib/installScriptCrashAlert.js";
import { runScript } from "../src/lib/runScript.js";
import { db } from "../src/db/connection.js";
import { runOptionChainStructureRefresh } from "../src/ibkr/runOptionChainStructureRefresh.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { fetchSpyLiquidHours } from "../src/ibkr/fetchLiquidHours.js";
import { recordSessionCloseFromIbkr } from "../src/lib/sessionCloseFromIbkr.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { runJob } from "../src/lib/runJob.js";

async function main(): Promise<void> {
  if (await isMarketClosedToday()) {
    console.log("Skipping option_chain_structure_refresh — market closed today.");
    return;
  }

  // Today's close (an early close on a half day) from IBKR, for every screen, order labels and Pluto, in every
  // environment. Its own job run: a failure alerts on its own and never stops the structure refresh below.
  await runJob(
    "session_close_read",
    async () => {
      const connection = await connectToIbkrGateway();
      try {
        const result = await recordSessionCloseFromIbkr(() => fetchSpyLiquidHours(connection.ib, 1));
        console.log(`Session close: today ${result.todayCloseTimeEt ?? "not listed"}; ${result.datesWritten.length} day(s) stored (${result.datesWritten.join(", ")}).`);
        return { details: result, failureMessage: result.todayCloseTimeEt === null ? "IBKR's liquid hours did not list today's session" : undefined };
      } finally {
        connection.disconnect();
      }
    },
    { triggeredBy: "scheduler" },
  ).catch((error: unknown) => console.error(`session_close_read failed: ${error instanceof Error ? error.message : error}`));

  await runJob(
    "option_chain_structure_refresh",
    async () => {
      const result = await runOptionChainStructureRefresh((event) => {
        if (event.type === "tickerDone") {
          const slowest = event.timings.expiries.reduce((max, expiry) => Math.max(max, expiry.elapsedMs), 0);
          const reused = event.timings.expiries.filter((expiry) => expiry.reused).length;
          console.log(
            `${event.symbol}: structure refreshed in ${(event.timings.totalMs / 1000).toFixed(1)}s (expiries ${event.timings.optionParamsMs}ms; ${event.expiryCount} strike grids, ${event.expiryCount - reused} looked up, ${reused} reused; ${event.strikeCount} strikes total, slowest ${slowest}ms).`,
          );
        } else if (event.type === "tickerError") {
          console.warn(`${event.symbol}: structure refresh failed — ${event.message}`);
        } else {
          console.warn(`Stopping after ${event.afterSymbol}'s IBKR timeout (the request stays queued in the Gateway; sending more would stall it). Not attempted: ${event.skippedSymbols.join(", ")}.`);
        }
      });
      console.log(
        `Structure refresh: ${result.tickersComplete} complete, ${result.tickersFailed} failed, ${result.skippedSymbols.length} skipped of ${result.tickersAttempted} (${result.gridLookups} grid lookups, ${result.gridsReused} reused).`,
      );
      const incomplete = [...result.failedSymbols, ...result.skippedSymbols];
      return {
        details: { ...result },
        failureMessage:
          result.tickersAttempted === 0
            ? "no tickers to refresh (shortlist and open positions are both empty)"
            : incomplete.length > 0
              ? `${incomplete.length} of ${result.tickersAttempted} tickers have no structure today, so the capture skips them: ${incomplete.join(", ")}`
              : undefined,
      };
    },
    { triggeredBy: "scheduler" },
  );
}

runScript("run-option-chain-structure-job", main, () => db.destroy());
