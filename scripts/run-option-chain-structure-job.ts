// Scheduled job: pre-market option-chain STRUCTURE refresh (expiries + each
// expiry's real strike grid) — split off run-option-chain-capture-job.ts
// 2026-09-23, since structure is plain IBKR contract-definition data with no
// dependency on the market being open, unlike the ticks that job still
// captures at 10:00 ET. Running this first means the 10:00 ET job reads
// today's structure from the DB instead of re-fetching it from IBKR.
//
// One fixed-UTC Scheduler entry (12:00 UTC), unlike the ticks job's
// DST-paired pair — this job isn't pinned to a specific ET time the way
// "30 minutes after the open" is, so it doesn't need the two-slot trick:
// 12:00 UTC is always well clear of IBKR Gateway's overnight restart and
// comfortably ahead of the 10:00 ET ticks job (7:00 ET in winter, 8:00 ET in
// summer — either way, hours of slack).
//
// Usage (dev):  npm run job:option-chain-structure
// Usage (prod): node dist/scripts/run-option-chain-structure-job.js

import { db } from "../src/db/connection.js";
import { runOptionChainStructureRefresh } from "../src/ibkr/runOptionChainStructureRefresh.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { runJob } from "../src/lib/runJob.js";

async function main(): Promise<void> {
  if (await isMarketClosedToday()) {
    console.log("Skipping option_chain_structure_refresh — market closed today.");
    return;
  }

  await runJob(
    "option_chain_structure_refresh",
    async () => {
      const result = await runOptionChainStructureRefresh((event) => {
        if (event.type === "tickerDone") {
          const slowest = event.timings.expiries.reduce((max, expiry) => Math.max(max, expiry.elapsedMs), 0);
          console.log(
            `${event.symbol}: structure refreshed in ${(event.timings.totalMs / 1000).toFixed(1)}s (expiries ${event.timings.optionParamsMs}ms; ${event.expiryCount} strike grids, ${event.strikeCount} strikes total, slowest ${slowest}ms).`,
          );
        } else {
          console.warn(`${event.symbol}: structure refresh failed — ${event.message}`);
        }
      });
      console.log(`Structure refresh: ${result.tickersComplete} complete, ${result.tickersFailed} failed of ${result.tickersAttempted}.`);
      return { details: { ...result } };
    },
    { triggeredBy: "scheduler" },
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
