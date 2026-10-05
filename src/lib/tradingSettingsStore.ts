import { db } from "../db/connection.js";
import { loadCommissionEstimator, type CommissionEstimator } from "./commissionEstimate.js";

// The single home for every trading limit and target (table trading_settings, one row, edited on Risk & Limits).
// Every reader goes through this loader instead of re-querying the row.

export interface TradingSettings {
  /** Order gate: one order's notional may not exceed this share of net liquidation value. */
  maxPositionPctOfPortfolio: number;
  /** Order gate: a ticker's exposure after the order may not exceed this share of net liquidation value. */
  maxConcentrationPerTickerPct: number;
  /** Order gate: free cash after the order may not fall below this share of net liquidation value. */
  minCashReservePct: number;
  /** One delta band (|delta|) for Signals candidates, the order gate and the Recovery Path scan. */
  deltaTargetMin: number;
  deltaTargetMax: number;
  /** Recovery Path expiry window, in days to expiry. */
  recoveryDteMin: number;
  recoveryDteMax: number;
  /** Signals drops candidates whose annualised yield is below this percentage. */
  minAnnualizedYieldPct: number;
  /** Order setup warns when the order's commission is above this percentage of its premium. */
  commissionWarnSharePctOfPremium: number;
  /** Trailing-fills commission estimate used by scoring; absent (flat $0.68) wherever settings are built without a database. */
  commissionEstimator?: CommissionEstimator;
}

export const tradingSettingsColumns = {
  maxPositionPctOfPortfolio: "max_position_pct_of_portfolio",
  maxConcentrationPerTickerPct: "max_concentration_per_ticker_pct",
  minCashReservePct: "min_cash_reserve_pct",
  deltaTargetMin: "delta_target_min",
  deltaTargetMax: "delta_target_max",
  recoveryDteMin: "recovery_dte_min",
  recoveryDteMax: "recovery_dte_max",
  minAnnualizedYieldPct: "min_annualized_yield_pct",
  commissionWarnSharePctOfPremium: "commission_warn_share_of_premium_pct",
} as const;

export type TradingSettingsInput = Record<keyof typeof tradingSettingsColumns, number>;

/** The column is a 32-bit integer; a window beyond this would be refused by the database as a server error instead of a clear message. */
const maximumDteDays = 2_147_483_647;

const percentageFields = ["maxPositionPctOfPortfolio", "maxConcentrationPerTickerPct", "minCashReservePct", "minAnnualizedYieldPct", "commissionWarnSharePctOfPremium"] as const;

/** Pure: the reason a settings payload cannot be saved, or null. The database enforces the same ranges as a last line. */
export function validateTradingSettingsInput(input: Record<string, unknown>): string | null {
  for (const field of Object.keys(tradingSettingsColumns)) {
    const value = input[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a number.`;
  }
  const settings = input as TradingSettingsInput;
  for (const field of percentageFields) {
    if (settings[field] < 0 || settings[field] > 100) return `${field} must be between 0 and 100.`;
  }
  if (settings.deltaTargetMin < 0 || settings.deltaTargetMax > 1) return "The delta band must be between 0 and 1.";
  if (settings.deltaTargetMin > settings.deltaTargetMax) return "deltaTargetMin cannot exceed deltaTargetMax.";
  if (!Number.isInteger(settings.recoveryDteMin) || !Number.isInteger(settings.recoveryDteMax)) return "The Recovery Path DTE window must be whole days.";
  if (settings.recoveryDteMin < 0) return "recoveryDteMin cannot be negative.";
  if (settings.recoveryDteMax > maximumDteDays) return `recoveryDteMax cannot exceed ${maximumDteDays} days.`;
  if (settings.recoveryDteMin > settings.recoveryDteMax) return "recoveryDteMin cannot exceed recoveryDteMax.";
  return null;
}

type TradingSettingsRow = Record<(typeof tradingSettingsColumns)[keyof typeof tradingSettingsColumns], string | number>;

/** Pure: the stored row (numerics arrive as strings) as numbers. */
export function mapTradingSettingsRow(row: TradingSettingsRow): Omit<TradingSettings, "commissionEstimator"> {
  return {
    maxPositionPctOfPortfolio: Number(row.max_position_pct_of_portfolio),
    maxConcentrationPerTickerPct: Number(row.max_concentration_per_ticker_pct),
    minCashReservePct: Number(row.min_cash_reserve_pct),
    deltaTargetMin: Number(row.delta_target_min),
    deltaTargetMax: Number(row.delta_target_max),
    recoveryDteMin: Number(row.recovery_dte_min),
    recoveryDteMax: Number(row.recovery_dte_max),
    minAnnualizedYieldPct: Number(row.min_annualized_yield_pct),
    commissionWarnSharePctOfPremium: Number(row.commission_warn_share_of_premium_pct),
  };
}

export async function loadTradingSettings(): Promise<TradingSettings> {
  const [row, commissionEstimator] = await Promise.all([db("trading_settings").first(), loadCommissionEstimator()]);
  if (!row) throw new Error("No trading_settings row found.");
  return { ...mapTradingSettingsRow(row), commissionEstimator };
}

/** The stored settings as the Risk & Limits form shows them: numbers plus who saved last and when. */
export async function loadTradingSettingsForEditing() {
  const row = await db("trading_settings as ts")
    .leftJoin("users as u", "u.id", "ts.updated_by_user_id")
    .select("ts.*", "u.display_name as updated_by_display_name")
    .first();
  if (!row) throw new Error("No trading_settings row found.");
  return { ...mapTradingSettingsRow(row), updatedAt: new Date(row.updated_at).toISOString(), updatedByDisplayName: (row.updated_by_display_name as string | null) ?? null };
}

/** Saves a validated payload. The caller validates first (validateTradingSettingsInput). */
export async function saveTradingSettings(input: TradingSettingsInput, userId: string): Promise<void> {
  const update: Record<string, number> = {};
  for (const [field, column] of Object.entries(tradingSettingsColumns)) update[column] = input[field as keyof TradingSettingsInput];
  const updatedRows = await db("trading_settings").update({ ...update, updated_at: db.fn.now(), updated_by_user_id: userId });
  if (updatedRows !== 1) throw new Error("No trading_settings row found.");
}
