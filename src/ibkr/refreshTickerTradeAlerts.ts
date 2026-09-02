import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { generateTradeAlertCandidatesForTicker, type AlertStrategyKey, type AlertStrategySettings } from "./generateTradeAlertCandidates.js";
import { maxAlertsPerTicker, rationaleFor, toSettings, tradeAlertStrategies } from "./runTradeAlertGeneration.js";

export interface RefreshTickerTradeAlertsResult {
  strategyKey: AlertStrategyKey;
  insertedCount: number;
}

/**
 * Single-ticker equivalent of runTradeAlertGeneration.ts's per-ticker
 * new_trade loop — used by the Trade Alerts page's per-ticker "Refresh"
 * button and the Ticker Detail modal's "Scan for Alerts"/"Refresh" button
 * (both hit the same POST /trade-alerts/refresh-ticker endpoint). Reuses
 * generateTradeAlertCandidatesForTicker and the same expire-then-insert
 * persistence shape as the full scan, rather than a physical delete — see
 * PROGRESS.md, this avoids any FK collision with an in-flight order_requests
 * row still referencing an about-to-be-superseded alert.
 *
 * Deliberately scoped to alert_type = 'new_trade' only (unlike the full
 * scan's per-ticker expire query, which isn't alert_type-scoped and gets
 * away with it only because its own roll-scan pass immediately follows and
 * regenerates any roll alert it just expired) — a standalone single-ticker
 * refresh has no roll pass following it, so an unscoped expire here would
 * silently wipe out a still-valid pending roll alert for this ticker with
 * nothing to replace it. Roll alerts are refreshed independently (their own
 * per-alert "Refresh" button), never touched by this function.
 */
export async function refreshTickerTradeAlerts(tickerId: string, symbol: string): Promise<RefreshTickerTradeAlertsResult[]> {
  const connection = await connectToIbkrGateway();
  requestRealtimeMarketData(connection.ib);

  try {
    const settingsByStrategy = new Map<AlertStrategyKey, AlertStrategySettings>();
    for (const strategyKey of tradeAlertStrategies) {
      const settingsRow = await db("strategy_settings").where({ strategy_key: strategyKey }).first();
      if (settingsRow) settingsByStrategy.set(strategyKey, toSettings(settingsRow));
    }

    const candidatesByStrategy = await generateTradeAlertCandidatesForTicker(connection, symbol, tickerId, settingsByStrategy);

    const results: RefreshTickerTradeAlertsResult[] = [];
    for (const strategyKey of tradeAlertStrategies) {
      if (!settingsByStrategy.has(strategyKey)) continue;
      const candidates = candidatesByStrategy.get(strategyKey) ?? [];

      await db("trade_alerts")
        .where({ ticker_id: tickerId, strategy_key: strategyKey, alert_type: "new_trade", status: "pending" })
        .update({ status: "expired" });

      const topCandidates = candidates.slice(0, maxAlertsPerTicker);
      for (const candidate of topCandidates) {
        await db("trade_alerts").insert({
          strategy_key: strategyKey,
          ticker_id: tickerId,
          alert_type: "new_trade",
          suggested_structure: JSON.stringify(candidate),
          rationale: rationaleFor(strategyKey, symbol, candidate),
          status: "pending",
        });
      }
      results.push({ strategyKey, insertedCount: topCandidates.length });
    }
    return results;
  } finally {
    connection.disconnect();
  }
}
