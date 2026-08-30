// Heroku Scheduler job (actually runs every ~10 minutes in prod, not
// hourly — checked directly against live logs 2026-08-30): checks whether
// the IBKR paper Gateway is reachable, and asks the VPS to attempt one
// restart if it isn't. Runs the VPS-side /opt/ibkr/healthcheck.sh over SSH
// via a narrowly-restricted key that can only ever trigger that one script
// (see PROGRESS.md's "IBKR Gateway health-check" entry for the design
// rationale). Runs every day, weekends included — see the no-weekend-skip
// note on main() below.
//
// Thin wrapper around src/ibkr/checkIbkrHealthJob.ts, shared with System
// Health's on-demand "Run Health Check Now" button — see that file for the
// actual check/job_runs logging/Telegram logic.
//
// Usage (dev):
//   npm run ibkr:health-check
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/check-ibkr-health.js

import { runIbkrHealthCheckJob } from "../src/ibkr/checkIbkrHealthJob.js";
import { db } from "../src/db/connection.js";

// No weekend skip here (removed 2026-08-30) -- unlike the market-data jobs,
// every check this job runs is weekend-safe on its own: the Gateway
// handshake and reqHistoricalData(SPY) probe both still work (historical
// data isn't gated by "market open right now", just returns the latest
// completed bar); position reconciliation just reports zero discrepancies
// when nothing's traded; the worker process can crash any day. Confirmed
// live 2026-08-30: the Gateway was found stuck (container "Up", but the
// API layer behind it unresponsive to a real handshake -- same failure
// mode as the 2026-08-20/21 incident) on a Saturday, and this job was
// silently skipping itself the whole time instead of catching and
// restarting it -- a worse blind spot than the already-documented 4-day
// daily-market-data outage, since a broken Gateway sits unfixed all
// weekend and is still broken the moment Monday's trading actions need it.
async function main(): Promise<void> {
  await runIbkrHealthCheckJob();
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
