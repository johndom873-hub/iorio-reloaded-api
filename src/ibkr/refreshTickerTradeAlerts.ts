import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { sharedLiveConnection } from "./sharedReadConnection.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { generateTradeAlertCandidatesForTicker, type AlertStrategyKey, type AlertStrategySettings, type QuoteStats } from "./generateTradeAlertCandidates.js";
import { maxAlertsPerTicker, rationaleFor, toSettings, tradeAlertStrategies } from "./runTradeAlertGeneration.js";
import { referencedStrikesForNewTrade } from "../lib/tradeAlertReferencedStrikes.js";

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
 * Scoped to alert_type = 'new_trade' only (the full scan's per-ticker expire
 * is scoped the same way since 2026-09-24): roll alerts are refreshed
 * independently (their own per-alert "Refresh" button) and never touched here.
 */
export async function refreshTickerTradeAlerts(tickerId: string, symbol: string): Promise<RefreshTickerTradeAlertsResult[]> {
  // Shared live connection first (2026-09-24) — no per-click tunnel +
  // handshake (~5 s); a one-shot connection only when it isn't available.
  let borrowed: Awaited<ReturnType<typeof sharedLiveConnection.borrow>> | null = null;
  try {
    borrowed = await sharedLiveConnection.borrow();
  } catch (error) {
    console.log(`refreshTickerTradeAlerts: shared live connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`);
  }
  const connection = borrowed ? { ib: borrowed.ib, disconnect: borrowed.release } : await connectToIbkrGateway();
  requestRealtimeMarketData(connection.ib);

  try {
    const settingsByStrategy = new Map<AlertStrategyKey, AlertStrategySettings>();
    for (const strategyKey of tradeAlertStrategies) {
      const settingsRow = await db("strategy_settings").where({ strategy_key: strategyKey }).first();
      if (settingsRow) settingsByStrategy.set(strategyKey, toSettings(settingsRow));
    }

    let quoteStats: QuoteStats = { requested: 0, withPriceAndDelta: 0, prepFailed: false };
    const candidatesByStrategy = await generateTradeAlertCandidatesForTicker(connection, symbol, tickerId, settingsByStrategy, { onQuoteStats: (stats) => (quoteStats = stats) });
    // Nothing usable came back — the ticker could not be prepared (no
    // contract id, spot or strike grid), or contracts were requested but
    // none got a price and delta (outside market hours, IBKR quiet). Keep
    // the existing alerts rather than expiring them with nothing to replace
    // them (found 2026-09-24 — a refresh outside hours emptied BE's card).
    // Zero requested with a healthy prep (nothing in the DTE window) is a
    // legitimate empty result and still expires.
    if (quoteStats.prepFailed) {
      throw new Error(`${symbol} could not be prepared for a scan (no contract id, spot price or stored strike grid) — existing alerts kept.`);
    }
    if (quoteStats.requested > 0 && quoteStats.withPriceAndDelta === 0) {
      throw new Error(`No live quotes available for ${symbol} right now — existing alerts kept; try again during market hours.`);
    }

    // Expire + insert as ONE transaction under a per-ticker advisory lock
    // (2026-09-24): a failure mid-insert no longer loses the old alerts, and
    // two concurrent refreshes of the same ticker (the page and the modal,
    // or two users) serialize instead of interleaving into duplicates.
    return db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`trade_alerts:${tickerId}`]);
      const results: RefreshTickerTradeAlertsResult[] = [];
      for (const strategyKey of tradeAlertStrategies) {
        if (!settingsByStrategy.has(strategyKey)) continue;
        const candidates = candidatesByStrategy.get(strategyKey) ?? [];

        await trx("trade_alerts")
          .where({ ticker_id: tickerId, strategy_key: strategyKey, alert_type: "new_trade", status: "pending" })
          .update({ status: "expired" });

        const topCandidates = candidates.slice(0, maxAlertsPerTicker);
        for (const candidate of topCandidates) {
          await trx("trade_alerts").insert({
            strategy_key: strategyKey,
            ticker_id: tickerId,
            alert_type: "new_trade",
            suggested_structure: JSON.stringify(candidate),
            referenced_strikes: JSON.stringify(referencedStrikesForNewTrade(candidate)),
            rationale: rationaleFor(strategyKey, symbol, candidate),
            status: "pending",
          });
        }
        results.push({ strategyKey, insertedCount: topCandidates.length });
      }
      return results;
    });
  } finally {
    connection.disconnect();
  }
}
