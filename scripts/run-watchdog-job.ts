// Watchdog job (see PROGRESS.md's Scheduled jobs list): checks that
// every daily job actually ran today and that ibkr_health_check has posted
// something recently, alerting via Telegram if not — see
// runWatchdogCheck.ts for the check logic and design rationale.
//
// Runs once daily at 10:30 PM UTC, after the last daily job (market-data
// capture 9:00 PM, P&L snapshot 9:30 PM).
//
// Usage (dev):
//   npm run job:watchdog
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-watchdog-job.js

import { db } from "../src/db/connection.js";
import { isMarketClosedToday } from "../src/lib/isWeekend.js";
import { runWatchdogCheck } from "../src/lib/runWatchdogCheck.js";

async function main(): Promise<void> {
  // The daily jobs it checks are themselves skipped on weekends, so there's
  // nothing to watch for.
  if (await isMarketClosedToday()) {
    console.log("Skipping watchdog — market closed today.");
    return;
  }
  await runWatchdogCheck();
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
