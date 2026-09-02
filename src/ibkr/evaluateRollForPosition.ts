import { db } from "../db/connection.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { evaluateRollCandidate, type OpenShortLeg } from "./generateRollCandidates.js";
import { rationaleForRoll, toIsoDate, toSettings } from "./runTradeAlertGeneration.js";
import type { AlertStrategyKey } from "./generateTradeAlertCandidates.js";

export type RollCandidateEvaluation =
  | { status: "not_found" }
  | { status: "not_rollable"; reason: string }
  | { status: "no_settings" }
  | { status: "no_candidate" }
  | {
      status: "ok";
      symbol: string;
      relatedPositionId: string;
      rationale: string;
      suggestedStructure: {
        closeLeg: {
          legId: string;
          strike: number;
          expiry: string;
          right: "call" | "put";
          entryPrice: number;
          currentPrice: number;
          quantity: number;
          multiplier: number;
        };
        trigger: "decay" | "dte";
        dte: number;
        replacement: unknown;
        netCredit: number;
        requiredMinimumCredit: number;
        stillTriggered: boolean;
      };
    };

/**
 * On-demand equivalent of runTradeAlertGeneration.ts's roll scan, but for one
 * caller-specified leg rather than every open short leg in the book — built
 * 2026-08-31 so clicking "Roll" on a position works even when the scheduled
 * job hasn't (yet, or ever) flagged it as triggered. Reuses
 * evaluateRollCandidate with `force: true` so a replacement is computed
 * regardless of the 50%-decay/21-DTE thresholds; `stillTriggered` on the
 * result tells the caller whether it would have fired naturally, so the UI
 * can show "you're rolling early" rather than implying a real trigger.
 * Read-only — writes nothing to trade_alerts or order_requests, unlike the
 * batch scan. Opens its own short-lived IBKR connection, same pattern as
 * refreshTickerTradeAlerts.ts.
 */
export async function evaluateRollForPosition(positionId: string, legId: string): Promise<RollCandidateEvaluation> {
  const legRow = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .where({ "pl.id": legId, "pl.position_id": positionId })
    .select(
      "pl.id as legId",
      "t.symbol",
      "t.id as tickerId",
      "pl.strike_price as strike",
      db.raw("to_char(pl.expiry_date, 'YYYYMMDD') as expiry"),
      "pl.option_type as right",
      "pl.entry_price as entryPrice",
      "pl.quantity",
      "pl.multiplier",
      "pl.leg_type as legType",
      "pl.side",
      "pl.exit_at as exitAt",
      "p.id as positionId",
      "p.status as positionStatus",
      "p.strategy_key as strategyKey",
    )
    .first();

  if (!legRow) return { status: "not_found" };
  if (legRow.positionStatus !== "open") return { status: "not_rollable", reason: "Position is already closed." };
  if (legRow.legType !== "option" || legRow.side !== "short") return { status: "not_rollable", reason: "Only a short option leg can be rolled." };
  if (legRow.exitAt) return { status: "not_rollable", reason: "This leg is already closed." };

  const leg: OpenShortLeg = {
    legId: legRow.legId,
    symbol: legRow.symbol,
    tickerId: legRow.tickerId,
    strike: Number(legRow.strike),
    expiry: legRow.expiry,
    right: legRow.right,
    entryPrice: Number(legRow.entryPrice),
    quantity: Number(legRow.quantity),
    multiplier: Number(legRow.multiplier),
  };
  const strategyKey = legRow.strategyKey as AlertStrategyKey;

  const settingsRow = await db("strategy_settings").where({ strategy_key: strategyKey }).first();
  if (!settingsRow) return { status: "no_settings" };
  const settings = toSettings(settingsRow);

  const connection = await connectToIbkrGateway();
  requestRealtimeMarketData(connection.ib);
  try {
    const suggestion = await evaluateRollCandidate(connection, leg, strategyKey, settings, { force: true });
    if (!suggestion) return { status: "no_candidate" };

    return {
      status: "ok",
      symbol: leg.symbol,
      relatedPositionId: legRow.positionId,
      rationale: rationaleForRoll(leg.symbol, leg, suggestion),
      suggestedStructure: {
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
        netCredit: suggestion.netCredit,
        requiredMinimumCredit: suggestion.requiredMinimumCredit,
        stillTriggered: suggestion.stillTriggered,
      },
    };
  } finally {
    connection.disconnect();
  }
}
