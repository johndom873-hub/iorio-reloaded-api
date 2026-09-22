// Scheduled job #3 (see PROGRESS.md's Scheduled jobs plan): scans every
// currently-shortlisted ticker's option chain against that strategy's
// strategy_settings delta/DTE window, ranks candidates by annualized
// premium yield (formula approved 2026-08-20 — see
// generateTradeAlertCandidates.ts), and stores the top few as pending
// trade_alerts for review. Runs once, after jobs #1/#2, using the day's
// fresh EOD data.
//
// Any still-pending alerts from a previous run are marked 'expired' before
// generating fresh ones — the trade_alert_status enum anticipated this
// (schema comment references it), and stale suggestions based on yesterday's
// prices shouldn't linger once today's batch has fresher ones.
//
// Notifies on every new batch, not just failures — this is the
// "something to review" signal driving the daily workflow, separate from
// the failure-only rule used by system-health-style jobs (see
// PROGRESS.md's Telegram notification rules).
//
// The scan itself lives in runTradeAlertGeneration.ts, shared with the
// manual "Run Now" button's SSE route (routes/tradeAlerts.ts) — this script
// is just the runJob/Telegram wrapper plus console logging of progress
// events.
//
// Usage (dev):
//   npm run job:trade-alerts
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-trade-alert-generation-job.js

import { db } from "../src/db/connection.js";
import { runScheduledTradeAlertJob } from "../src/ibkr/runScheduledTradeAlertJob.js";

runScheduledTradeAlertJob()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
