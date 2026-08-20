// Hourly job (Heroku Scheduler): checks whether the IBKR paper Gateway is
// reachable, and asks the VPS to attempt one restart if it isn't. Runs the
// VPS-side /opt/ibkr/healthcheck.sh over SSH via a narrowly-restricted key
// that can only ever trigger that one script (see PROGRESS.md's "Hourly
// IBKR Gateway health-check" entry for the design rationale).
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

runIbkrHealthCheckJob()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
