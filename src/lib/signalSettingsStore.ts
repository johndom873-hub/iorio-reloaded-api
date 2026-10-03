import { db } from "../db/connection.js";
import { loadCommissionEstimator, type CommissionEstimator } from "./commissionEstimate.js";

// Single source of truth for the Signals tab's own copy of these limits
// (deliberately separate from strategy_settings, see
// signalSettings.ts route) -- every reader of signal_settings goes through
// this loader instead of re-querying the row.

export interface SignalSettings {
  maxDeltaDriftPct: number;
  minAnnualizedYieldPct: number;
  maxNetDelta: number;
  maxPositionPctOfPortfolio: number;
  maxConcentrationPerTickerPct: number;
  minCashReservePct: number;
  /** Order setup warns when the order's commission is above this percentage of its premium. */
  commissionWarnSharePctOfPremium: number;
  /** Trailing-fills commission estimate used by scoring; absent (flat $0.68) wherever settings are built without a database. */
  commissionEstimator?: CommissionEstimator;
}

export async function loadSignalSettings(): Promise<SignalSettings> {
  const [row, commissionEstimator] = await Promise.all([db("signal_settings").first(), loadCommissionEstimator()]);
  if (!row) throw new Error("No signal_settings row found.");
  return {
    maxDeltaDriftPct: Number(row.max_delta_drift_pct),
    minAnnualizedYieldPct: Number(row.min_annualized_yield_pct),
    maxNetDelta: Number(row.max_net_delta),
    maxPositionPctOfPortfolio: Number(row.max_position_pct_of_portfolio),
    maxConcentrationPerTickerPct: Number(row.max_concentration_per_ticker_pct),
    minCashReservePct: Number(row.min_cash_reserve_pct),
    commissionWarnSharePctOfPremium: Number(row.commission_warn_share_of_premium_pct),
    commissionEstimator,
  };
}
