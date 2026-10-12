import { db } from "../db/connection.js";
import type { SignalCandidate } from "./signalCandidates.js";
import { volatilityModelTables } from "./volatilityModelTables.generated.js";

// The valuation model's prediction for every Signals candidate at the morning seed (model review, approved by Marcelo
// 2026-10-10): the evidence the model is judged on each month, against what each contract actually earned by expiry.

export interface SignalModelPrediction {
  tickerId: string;
  tradingDateIso: string;
  expiry: string;
  strike: number;
  right: "C" | "P";
  valuedAtIso: string;
  quoteSource: SignalCandidate["quoteSource"];
  bid: number;
  ask: number;
  spot: number;
  forward: number;
  forecastVolatility: number;
  varianceSessions: number;
  fairPrice: number;
  edgeMargin: number;
  expectedPnlDollars: number;
  calibratedExpectedPnlDollars: number;
  probabilityOfProfit: number;
  expectedShortfallDollars: number;
  grade: string;
  tablesBuiltAtIso: string;
}

/** Pure: one prediction per candidate the model valued (an unvalued candidate has nothing to judge). */
export function modelPredictionsFromCandidates(tickerId: string, tradingDateIso: string, candidates: SignalCandidate[]): SignalModelPrediction[] {
  return candidates.flatMap((candidate) => {
    const model = candidate.model;
    if (!model) return [];
    return [
      {
        tickerId,
        tradingDateIso,
        expiry: candidate.expiry,
        strike: candidate.strike,
        right: candidate.strategyKey === "covered_call" ? "C" : "P",
        valuedAtIso: model.valuedAtIso,
        quoteSource: candidate.quoteSource,
        bid: candidate.bid,
        ask: candidate.ask,
        spot: model.spot,
        forward: model.forward,
        forecastVolatility: model.forecastVolatility,
        varianceSessions: model.varianceSessions,
        fairPrice: model.fairPrice,
        edgeMargin: model.edgeMargin,
        expectedPnlDollars: model.expectedPnlDollars,
        calibratedExpectedPnlDollars: model.calibratedExpectedPnlDollars,
        probabilityOfProfit: model.probabilityOfProfit,
        expectedShortfallDollars: model.expectedShortfallDollars,
        grade: model.grade,
        tablesBuiltAtIso: volatilityModelTables.builtAtIso,
      },
    ];
  });
}

/** Rows per INSERT: ~23 bound values each stays well under Postgres's 65,535-parameter limit. */
const insertChunkSize = 1000;

/** A re-run seed replaces each ticker's predictions for that day with its own set (none left from the earlier run). */
export async function recordSignalModelPredictions(predictions: SignalModelPrediction[]): Promise<void> {
  if (predictions.length === 0) return;
  const rows = predictions.map((prediction) => ({
    ticker_id: prediction.tickerId,
    trading_date: prediction.tradingDateIso,
    expiry: prediction.expiry,
    strike: prediction.strike,
    option_right: prediction.right,
    valued_at: prediction.valuedAtIso,
    quote_source: prediction.quoteSource,
    bid: prediction.bid,
    ask: prediction.ask,
    spot: prediction.spot,
    forward: prediction.forward,
    forecast_volatility: prediction.forecastVolatility,
    variance_sessions: prediction.varianceSessions,
    fair_price: prediction.fairPrice,
    edge_margin: prediction.edgeMargin,
    expected_pnl_dollars: prediction.expectedPnlDollars,
    calibrated_expected_pnl_dollars: prediction.calibratedExpectedPnlDollars,
    probability_of_profit: prediction.probabilityOfProfit,
    expected_shortfall_dollars: prediction.expectedShortfallDollars,
    grade: prediction.grade,
    tables_built_at: prediction.tablesBuiltAtIso,
  }));
  const tickerIdsByDate = new Map<string, Set<string>>();
  for (const prediction of predictions) tickerIdsByDate.set(prediction.tradingDateIso, (tickerIdsByDate.get(prediction.tradingDateIso) ?? new Set()).add(prediction.tickerId));
  await db.transaction(async (trx) => {
    for (const [tradingDateIso, tickerIds] of tickerIdsByDate) await trx("signal_model_predictions").where({ trading_date: tradingDateIso }).whereIn("ticker_id", [...tickerIds]).del();
    for (let start = 0; start < rows.length; start += insertChunkSize) await trx("signal_model_predictions").insert(rows.slice(start, start + insertChunkSize));
  });
}
