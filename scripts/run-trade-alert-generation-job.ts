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
import { runTradeAlertGeneration } from "../src/ibkr/runTradeAlertGeneration.js";
import { isWeekend } from "../src/lib/isWeekend.js";
import { notifyTelegram } from "../src/lib/notifyTelegram.js";
import { formatTickerAlertsMessage } from "../src/lib/formatTradeAlertMessage.js";
import { runJob } from "../src/lib/runJob.js";

async function main(): Promise<void> {
  // Guard lives here, not in runTradeAlertGeneration.ts, so the manual
  // "Run Now" button (routes/tradeAlerts.ts) still works on weekends if
  // someone deliberately wants to trigger it.
  if (isWeekend()) {
    console.log("Skipping trade_alert_generation — weekend, US market closed.");
    return;
  }
  await runJob(
    "trade_alert_generation",
    async () => {
      // Notification redesign (2026-08-27, per Marcelo): rather than one
      // end-of-run summary, roll alerts go out as a single batch message as
      // soon as the roll scan finishes, then each shortlisted ticker gets its
      // own message (covering both strategies) as soon as its scan finishes —
      // this only applies to the scheduled job. The manual "Run Now" SSE route
      // (routes/tradeAlerts.ts) doesn't notify at all, since that's a
      // foreground run with live progress already visible in the browser.
      // Telegram's 4096-char cap is handled by notifyTelegram's truncation, so
      // a very large message just gets cut off rather than failing to send.
      const { tickersScanned, totalNewAlerts } = await runTradeAlertGeneration(
        async (event) => {
          if (event.type === "ticker") {
            console.log(
              `${event.symbol} (${event.strategyKey}): ${event.candidateCount} candidate(s) within delta/DTE window.`,
            );
          } else if (event.type === "tickerError") {
            console.warn(
              `${event.symbol} (${event.strategyKey}): candidate scan failed — ${event.message}`,
            );
          } else if (
            event.type === "rollBatchReady" &&
            event.lines.length > 0
          ) {
            await notifyTelegram(
              `🔄 ${event.lines.length} roll alert(s) ready for review\n\n${event.lines.join("\n\n")}`,
            );
          } else if (
            event.type === "assignmentRiskBatchReady" &&
            event.lines.length > 0
          ) {
            await notifyTelegram(
              `⚠️ ${event.lines.length} position(s) crossed into assignment risk\n\n${event.lines.join("\n\n")}`,
            );
          } else if (
            event.type === "tickerAlertsReady" &&
            event.entries.length > 0
          ) {
            await notifyTelegram(formatTickerAlertsMessage(event.symbol, event.entries));
          }
        },
      );

      console.log(
        `Generated ${totalNewAlerts} new trade alert(s) across ${tickersScanned} ticker-strategy scan(s).`,
      );

      // No `notify` here — everything's already been sent progressively above.
      return { details: { tickersScanned, totalNewAlerts } };
    },
    { triggeredBy: "scheduler" },
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
