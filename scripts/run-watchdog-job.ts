// Scheduled job #5 (see PROGRESS.md's Scheduled jobs plan): checks that
// jobs 1-3 actually ran today and that ibkr_health_check has posted
// something recently, alerting via Telegram if not — see
// runWatchdogCheck.ts for the check logic and design rationale.
//
// Runs once daily, after job #3 (10:00 PM UTC) — scheduled 10:30 PM UTC to
// give job #3 room to finish first.
//
// Usage (dev):
//   npm run job:watchdog
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-watchdog-job.js

import { db } from "../src/db/connection.js";
import { runWatchdogCheck } from "../src/lib/runWatchdogCheck.js";

runWatchdogCheck()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
