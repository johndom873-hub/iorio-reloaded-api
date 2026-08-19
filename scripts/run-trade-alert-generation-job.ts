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
// Usage (dev):
//   npm run job:trade-alerts
// Usage (prod, via Heroku Scheduler — tsx isn't in the prod slug):
//   node dist/scripts/run-trade-alert-generation-job.js

import { db } from "../src/db/connection.js";
import { connectToIbkrGateway } from "../src/ibkr/connectIbkr.js";
import { MarketDataType } from "@stoqey/ib";
import { generateTradeAlertCandidates, type AlertStrategyKey } from "../src/ibkr/generateTradeAlertCandidates.js";
import { runJob } from "../src/lib/runJob.js";

const strategies: AlertStrategyKey[] = ["covered_call", "cash_secured_put"];
const maxAlertsPerTicker = 3;

interface ShortlistedTickerRow {
  tickerId: string;
  symbol: string;
}

function rationaleFor(strategyKey: AlertStrategyKey, symbol: string, candidate: { strike: number; expiry: string; dte: number; delta: number; premium: number; annualizedYield: number }): string {
  const action = strategyKey === "covered_call" ? "Sell 1x call" : "Sell 1x put";
  const pct = (candidate.annualizedYield * 100).toFixed(1);
  return `${action} on ${symbol}: $${candidate.strike.toFixed(2)} strike exp ${candidate.expiry} (${candidate.dte} DTE, Δ${candidate.delta.toFixed(2)}) for $${candidate.premium.toFixed(2)} premium — ${pct}% annualized yield.`;
}

async function main(): Promise<void> {
  await runJob("trade_alert_generation", async () => {
    const connection = await connectToIbkrGateway();
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);

    let totalNewAlerts = 0;
    let tickersScanned = 0;

    try {
      for (const strategyKey of strategies) {
        const settingsRow = await db("strategy_settings").where({ strategy_key: strategyKey }).first();
        if (!settingsRow) {
          console.warn(`No strategy_settings row for ${strategyKey} — skipping.`);
          continue;
        }
        const settings = {
          deltaTargetMin: Number(settingsRow.delta_target_min),
          deltaTargetMax: Number(settingsRow.delta_target_max),
          dteTargetMin: Number(settingsRow.dte_target_min),
          dteTargetMax: Number(settingsRow.dte_target_max),
        };

        const tickers: ShortlistedTickerRow[] = await db("shortlist_entries as se")
          .join("tickers as t", "t.id", "se.ticker_id")
          .where("se.strategy_key", strategyKey)
          .whereNull("se.removed_at")
          .select("t.id as tickerId", "t.symbol");

        for (const ticker of tickers) {
          tickersScanned++;
          let candidates: Awaited<ReturnType<typeof generateTradeAlertCandidates>> = [];
          try {
            candidates = await generateTradeAlertCandidates(connection, ticker.symbol, strategyKey, settings);
          } catch (error) {
            console.warn(`${ticker.symbol} (${strategyKey}): candidate scan failed — ${error instanceof Error ? error.message : error}`);
            continue;
          }

          await db("trade_alerts")
            .where({ ticker_id: ticker.tickerId, strategy_key: strategyKey, status: "pending" })
            .update({ status: "expired" });

          const topCandidates = candidates.slice(0, maxAlertsPerTicker);
          for (const candidate of topCandidates) {
            await db("trade_alerts").insert({
              strategy_key: strategyKey,
              ticker_id: ticker.tickerId,
              alert_type: "new_trade",
              suggested_structure: JSON.stringify(candidate),
              rationale: rationaleFor(strategyKey, ticker.symbol, candidate),
              status: "pending",
            });
          }
          console.log(`${ticker.symbol} (${strategyKey}): ${topCandidates.length} candidate(s) within delta/DTE window.`);
          totalNewAlerts += topCandidates.length;
        }
      }
    } finally {
      connection.disconnect();
    }

    console.log(`Generated ${totalNewAlerts} new trade alert(s) across ${tickersScanned} ticker-strategy scan(s).`);
    return {
      details: { tickersScanned, totalNewAlerts },
      notify: totalNewAlerts > 0 ? `📋 Trade Alerts: ${totalNewAlerts} new alert(s) ready for review.` : undefined,
    };
  });
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
