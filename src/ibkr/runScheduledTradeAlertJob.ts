import { runTradeAlertGeneration } from "./runTradeAlertGeneration.js";
import { isMarketClosedToday } from "../lib/isWeekend.js";
import { notifyTelegram } from "../lib/notifyTelegram.js";
import { formatTickerAlertsMessage } from "../lib/formatTradeAlertMessage.js";
import { runJob } from "../lib/runJob.js";

// The scheduled trade-alert scan (job #3): runJob wrapper + progressive
// Telegram notifications. Shared by scripts/run-trade-alert-generation-job.ts
// and the chained scripts/run-option-chain-capture-job.ts, which runs it right
// after the nightly chain capture.

export async function runScheduledTradeAlertJob(): Promise<void> {
  // Guard lives here, not in runTradeAlertGeneration.ts, so the manual
  // "Run Now" button (routes/tradeAlerts.ts) still works on weekends if
  // someone deliberately wants to trigger it.
  if (await isMarketClosedToday()) {
    console.log("Skipping trade_alert_generation — market closed today.");
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

