import { MarketDataType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { generateTradeAlertCandidates, type AlertStrategyKey } from "./generateTradeAlertCandidates.js";
import { evaluateRollCandidate, type OpenShortLeg, type RollSuggestion } from "./generateRollCandidates.js";
import { formatNewTradeAlertLine, formatRollAlertLine } from "../lib/formatTradeAlertMessage.js";

export const tradeAlertStrategies: AlertStrategyKey[] = ["covered_call", "cash_secured_put"];
const maxAlertsPerTicker = 3;

interface ShortlistedTickerRow {
  tickerId: string;
  symbol: string;
}

interface OpenShortLegRow extends OpenShortLeg {
  positionId: string;
  tickerId: string;
  strategyKey: AlertStrategyKey;
}

export type TradeAlertGenerationEvent =
  | { type: "strategyStart"; strategyKey: AlertStrategyKey; tickerCount: number }
  | { type: "ticker"; strategyKey: AlertStrategyKey; symbol: string; candidateCount: number }
  | { type: "tickerError"; strategyKey: AlertStrategyKey; symbol: string; message: string }
  | { type: "rollScanStart"; positionCount: number }
  | { type: "rollCandidate"; symbol: string; triggered: boolean }
  | { type: "rollError"; symbol: string; message: string };

export interface TradeAlertGenerationResult {
  tickersScanned: number;
  totalNewAlerts: number;
  newAlertLines: string[];
  rollAlertLines: string[];
}

function rationaleFor(strategyKey: AlertStrategyKey, symbol: string, candidate: { strike: number; expiry: string; dte: number; delta: number; premium: number; annualizedYield: number }): string {
  const action = strategyKey === "covered_call" ? "Sell 1x call" : "Sell 1x put";
  const pct = (candidate.annualizedYield * 100).toFixed(1);
  return `${action} on ${symbol}: $${candidate.strike.toFixed(2)} strike exp ${candidate.expiry} (${candidate.dte} DTE, Δ${candidate.delta.toFixed(2)}) for $${candidate.premium.toFixed(2)} premium — ${pct}% annualized yield.`;
}

function rationaleForRoll(symbol: string, leg: OpenShortLeg, suggestion: RollSuggestion): string {
  const rightLabel = leg.right === "call" ? "call" : "put";
  const triggerLabel =
    suggestion.trigger === "decay"
      ? `decayed to $${suggestion.currentPrice.toFixed(2)} from $${leg.entryPrice.toFixed(2)} collected (≤50%)`
      : `${suggestion.dte} DTE remaining (≤21)`;
  const r = suggestion.replacement;
  const pct = (r.annualizedYield * 100).toFixed(1);
  return `Roll ${symbol} $${leg.strike.toFixed(2)}${leg.right === "call" ? "C" : "P"} exp ${toIsoDate(leg.expiry)} — ${triggerLabel}. Suggested replacement: sell 1x ${rightLabel} $${r.strike.toFixed(2)} strike exp ${r.expiry} (${r.dte} DTE, Δ${r.delta.toFixed(2)}) for $${r.premium.toFixed(2)} premium — ${pct}% annualized yield.`;
}

function toIsoDate(expiryYyyymmdd: string): string {
  return `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
}

function toSettings(settingsRow: Record<string, unknown>) {
  return {
    deltaTargetMin: Number(settingsRow.delta_target_min),
    deltaTargetMax: Number(settingsRow.delta_target_max),
    dteTargetMin: Number(settingsRow.dte_target_min),
    dteTargetMax: Number(settingsRow.dte_target_max),
  };
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
  const newAlertLines: string[] = [];
  const rollAlertLines: string[] = [];
  const settingsByStrategy = new Map<AlertStrategyKey, ReturnType<typeof toSettings>>();

  try {
    for (const strategyKey of tradeAlertStrategies) {
      const settingsRow = await db("strategy_settings").where({ strategy_key: strategyKey }).first();
      if (!settingsRow) {
        continue;
      }
      const settings = toSettings(settingsRow);
      settingsByStrategy.set(strategyKey, settings);

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
          newAlertLines.push(formatNewTradeAlertLine(ticker.symbol, strategyKey, candidate));
        }
        onEvent({ type: "ticker", strategyKey, symbol: ticker.symbol, candidateCount: topCandidates.length });
        totalNewAlerts += topCandidates.length;
      }
    }

    const openShortLegsResult = await db.raw(
      `
      SELECT
        pl.id AS "legId",
        t.symbol,
        pl.strike_price AS strike,
        to_char(pl.expiry_date, 'YYYYMMDD') AS expiry,
        pl.option_type AS right,
        pl.entry_price AS "entryPrice",
        pl.quantity,
        pl.multiplier,
        p.id AS "positionId",
        p.strategy_key AS "strategyKey",
        t.id AS "tickerId"
      FROM position_legs pl
      JOIN positions p ON p.id = pl.position_id
      JOIN tickers t ON t.id = p.ticker_id
      WHERE p.status = 'open'
        AND pl.leg_type = 'option'
        AND pl.side = 'short'
        AND pl.exit_at IS NULL
        AND p.strategy_key = ANY(?)
      `,
      [tradeAlertStrategies],
    );
    const openShortLegs: OpenShortLegRow[] = openShortLegsResult.rows.map((row: Record<string, unknown>) => ({
      legId: row.legId as string,
      symbol: row.symbol as string,
      strike: Number(row.strike),
      expiry: row.expiry as string,
      right: row.right as "call" | "put",
      entryPrice: Number(row.entryPrice),
      quantity: Number(row.quantity),
      multiplier: Number(row.multiplier),
      positionId: row.positionId as string,
      tickerId: row.tickerId as string,
      strategyKey: row.strategyKey as AlertStrategyKey,
    }));

    onEvent({ type: "rollScanStart", positionCount: openShortLegs.length });

    for (const leg of openShortLegs) {
      const settings = settingsByStrategy.get(leg.strategyKey as AlertStrategyKey);
      if (!settings) continue;

      let suggestion: Awaited<ReturnType<typeof evaluateRollCandidate>>;
      try {
        suggestion = await evaluateRollCandidate(connection, leg, leg.strategyKey as AlertStrategyKey, settings);
      } catch (error) {
        onEvent({ type: "rollError", symbol: leg.symbol, message: error instanceof Error ? error.message : String(error) });
        continue;
      }

      await db("trade_alerts")
        .where({ related_position_id: leg.positionId, alert_type: "roll", status: "pending" })
        .update({ status: "expired" });

      if (!suggestion) {
        onEvent({ type: "rollCandidate", symbol: leg.symbol, triggered: false });
        continue;
      }

      await db("trade_alerts").insert({
        strategy_key: leg.strategyKey,
        ticker_id: leg.tickerId,
        alert_type: "roll",
        related_position_id: leg.positionId,
        suggested_structure: JSON.stringify({
          closeLeg: {
            legId: leg.legId,
            strike: leg.strike,
            expiry: toIsoDate(leg.expiry),
            right: leg.right,
            entryPrice: leg.entryPrice,
            currentPrice: suggestion.currentPrice,
            quantity: leg.quantity,
            multiplier: leg.multiplier,
          },
          trigger: suggestion.trigger,
          dte: suggestion.dte,
          replacement: suggestion.replacement,
        }),
        rationale: rationaleForRoll(leg.symbol, leg, suggestion),
        status: "pending",
      });
      rollAlertLines.push(
        formatRollAlertLine(leg.symbol, { strike: leg.strike, expiryIso: toIsoDate(leg.expiry), right: leg.right, entryPrice: leg.entryPrice }, suggestion),
      );
      onEvent({ type: "rollCandidate", symbol: leg.symbol, triggered: true });
      totalNewAlerts += 1;
    }
  } finally {
    connection.disconnect();
  }

  return { tickersScanned, totalNewAlerts, newAlertLines, rollAlertLines };
}
