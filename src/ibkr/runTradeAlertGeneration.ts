import { MarketDataType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { generateTradeAlertCandidates, type AlertStrategyKey } from "./generateTradeAlertCandidates.js";

export const tradeAlertStrategies: AlertStrategyKey[] = ["covered_call", "cash_secured_put"];
const maxAlertsPerTicker = 3;

interface ShortlistedTickerRow {
  tickerId: string;
  symbol: string;
}

export type TradeAlertGenerationEvent =
  | { type: "strategyStart"; strategyKey: AlertStrategyKey; tickerCount: number }
  | { type: "ticker"; strategyKey: AlertStrategyKey; symbol: string; candidateCount: number }
  | { type: "tickerError"; strategyKey: AlertStrategyKey; symbol: string; message: string };

export interface TradeAlertGenerationResult {
  tickersScanned: number;
  totalNewAlerts: number;
}

function rationaleFor(strategyKey: AlertStrategyKey, symbol: string, candidate: { strike: number; expiry: string; dte: number; delta: number; premium: number; annualizedYield: number }): string {
  const action = strategyKey === "covered_call" ? "Sell 1x call" : "Sell 1x put";
  const pct = (candidate.annualizedYield * 100).toFixed(1);
  return `${action} on ${symbol}: $${candidate.strike.toFixed(2)} strike exp ${candidate.expiry} (${candidate.dte} DTE, Δ${candidate.delta.toFixed(2)}) for $${candidate.premium.toFixed(2)} premium — ${pct}% annualized yield.`;
}

/**
 * The daily trade-alert scan's actual work, factored out of
 * run-trade-alert-generation-job.ts so both the Heroku Scheduler entry point
 * and the manual "Run Now" SSE route (tradeAlerts.ts) share one
 * implementation — same shape as streamTickerDetail.ts being shared between
 * callers via an onEvent callback instead of each caller reimplementing the
 * scan.
 */
export async function runTradeAlertGeneration(onEvent: (event: TradeAlertGenerationEvent) => void): Promise<TradeAlertGenerationResult> {
  const connection = await connectToIbkrGateway();
  connection.ib.reqMarketDataType(MarketDataType.DELAYED);

  let totalNewAlerts = 0;
  let tickersScanned = 0;

  try {
    for (const strategyKey of tradeAlertStrategies) {
      const settingsRow = await db("strategy_settings").where({ strategy_key: strategyKey }).first();
      if (!settingsRow) {
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

      onEvent({ type: "strategyStart", strategyKey, tickerCount: tickers.length });

      for (const ticker of tickers) {
        tickersScanned++;
        let candidates: Awaited<ReturnType<typeof generateTradeAlertCandidates>> = [];
        try {
          candidates = await generateTradeAlertCandidates(connection, ticker.symbol, strategyKey, settings);
        } catch (error) {
          onEvent({ type: "tickerError", strategyKey, symbol: ticker.symbol, message: error instanceof Error ? error.message : String(error) });
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
        onEvent({ type: "ticker", strategyKey, symbol: ticker.symbol, candidateCount: topCandidates.length });
        totalNewAlerts += topCandidates.length;
      }
    }
  } finally {
    connection.disconnect();
  }

  return { tickersScanned, totalNewAlerts };
}
