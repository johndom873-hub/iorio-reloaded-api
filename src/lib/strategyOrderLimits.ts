import { db } from "../db/connection.js";
import { evaluateOrderLimits, type OrderLimitThresholds, type SignalOrderLimitsInput, type SignalOrderLimitsResult } from "./signalOrderLimits.js";

// The Trade Alerts tab's strategy_settings maxima, enforced at order confirm for every opening
// order and roll that did not come from the Signals flow (gap fix 6 for Pluto, 2026-09-28).
// Until now these five numbers were stored, edited and shown "for reference" but never
// checked anywhere. Same evaluator and conventions as the Signals limits; two more ceilings.

export async function loadStrategyOrderLimitThresholds(strategyKey: string): Promise<OrderLimitThresholds> {
  const row = await db("strategy_settings").where({ strategy_key: strategyKey }).first();
  if (!row) throw new Error(`No strategy settings found for ${strategyKey}.`);
  return {
    sourceLabel: "Trade Alerts tab",
    maxPositionPctOfPortfolio: Number(row.max_position_pct_of_portfolio),
    maxConcentrationPerTickerPct: Number(row.max_concentration_per_ticker_pct),
    minCashReservePct: Number(row.min_cash_reserve_pct),
    maxConcentrationPerSectorPct: Number(row.max_concentration_per_sector_pct),
    maxAggregateCollateralPct: Number(row.max_aggregate_collateral_pct),
  };
}

export async function evaluateStrategyOrderLimits(input: SignalOrderLimitsInput): Promise<SignalOrderLimitsResult> {
  return evaluateOrderLimits(input, () => loadStrategyOrderLimitThresholds(input.strategyKey));
}
