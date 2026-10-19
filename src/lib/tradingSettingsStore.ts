import { db } from "../db/connection.js";
import { loadCommissionEstimator, type CommissionEstimator } from "./commissionEstimate.js";

// The single home for every trading limit and target (table trading_settings, one row, edited on Risk & Limits).
// Every reader goes through this loader instead of re-querying the row.

export interface TradingSettings {
  /** Order gate: one order's notional may not exceed this share of net liquidation value. */
  maxOrderPctOfPortfolio: number;
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
  /** Limit-price check: an order's limit may be worse than the live mid by at most this share of the mid... */
  priceCheckMaxDeviationPct: number;
  /** ...or this many dollars, whichever is larger (so a cheap option is not blocked on a rounding difference). */
  priceCheckMinToleranceDollars: number;
  /** Signals friction charges this percentage of the half-spread: the expected give-up of a mid-limit order (0 = always the mid, 100 = always the bid). */
  spreadCostChargedPct: number;
  /** The worker cancels an order that has rested unfilled at IBKR this many minutes (whole minutes; 0 = never). */
  orderUnfilledCancelMinutes: number;
  /** Trailing-fills commission estimate used by scoring; absent (flat $0.68) wherever settings are built without a database. */
  commissionEstimator?: CommissionEstimator;
}

export const tradingSettingsColumns = {
  maxOrderPctOfPortfolio: "max_order_pct_of_portfolio",
  maxConcentrationPerTickerPct: "max_concentration_per_ticker_pct",
  minCashReservePct: "min_cash_reserve_pct",
  deltaTargetMin: "delta_target_min",
  deltaTargetMax: "delta_target_max",
  recoveryDteMin: "recovery_dte_min",
  recoveryDteMax: "recovery_dte_max",
  minAnnualizedYieldPct: "min_annualized_yield_pct",
  commissionWarnSharePctOfPremium: "commission_warn_share_of_premium_pct",
  priceCheckMaxDeviationPct: "price_check_max_deviation_pct",
  priceCheckMinToleranceDollars: "price_check_min_tolerance_dollars",
  spreadCostChargedPct: "spread_cost_charged_pct",
  orderUnfilledCancelMinutes: "order_unfilled_cancel_minutes",
} as const;

export type TradingSettingsInput = Record<keyof typeof tradingSettingsColumns, number>;

/** The column is a 32-bit integer; a window beyond this would be refused by the database as a server error instead of a clear message. */
const maximumDteDays = 2_147_483_647;

const percentageFields = ["maxOrderPctOfPortfolio", "maxConcentrationPerTickerPct", "minCashReservePct", "minAnnualizedYieldPct", "commissionWarnSharePctOfPremium", "priceCheckMaxDeviationPct", "spreadCostChargedPct"] as const;

const maximumToleranceDollars = 1000;
const maximumUnfilledCancelMinutes = 1440;

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
  if (!Number.isInteger(settings.orderUnfilledCancelMinutes) || settings.orderUnfilledCancelMinutes < 0 || settings.orderUnfilledCancelMinutes > maximumUnfilledCancelMinutes) return `orderUnfilledCancelMinutes must be a whole number of minutes between 0 and ${maximumUnfilledCancelMinutes}.`;
  if (settings.priceCheckMinToleranceDollars < 0 || settings.priceCheckMinToleranceDollars > maximumToleranceDollars) return `priceCheckMinToleranceDollars must be between 0 and ${maximumToleranceDollars}.`;
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
    maxOrderPctOfPortfolio: Number(row.max_order_pct_of_portfolio),
    maxConcentrationPerTickerPct: Number(row.max_concentration_per_ticker_pct),
    minCashReservePct: Number(row.min_cash_reserve_pct),
    deltaTargetMin: Number(row.delta_target_min),
    deltaTargetMax: Number(row.delta_target_max),
    recoveryDteMin: Number(row.recovery_dte_min),
    recoveryDteMax: Number(row.recovery_dte_max),
    minAnnualizedYieldPct: Number(row.min_annualized_yield_pct),
    commissionWarnSharePctOfPremium: Number(row.commission_warn_share_of_premium_pct),
    priceCheckMaxDeviationPct: Number(row.price_check_max_deviation_pct),
    priceCheckMinToleranceDollars: Number(row.price_check_min_tolerance_dollars),
    spreadCostChargedPct: Number(row.spread_cost_charged_pct),
    orderUnfilledCancelMinutes: Number(row.order_unfilled_cancel_minutes),
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

/** Saves a validated payload, writing one risk_limits_audit row per field that changed. The caller validates first (validateTradingSettingsInput). */
export async function saveTradingSettings(input: TradingSettingsInput, userId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const currentRow = await trx("trading_settings").forUpdate().first();
    if (!currentRow) throw new Error("No trading_settings row found.");
    const current = mapTradingSettingsRow(currentRow);
    const update: Record<string, number> = {};
    const audit: { user_id: string; field: string; old_value: string; new_value: string }[] = [];
    for (const [field, column] of Object.entries(tradingSettingsColumns)) {
      const key = field as keyof TradingSettingsInput;
      update[column] = input[key];
      if (current[key] !== input[key]) audit.push({ user_id: userId, field, old_value: String(current[key]), new_value: String(input[key]) });
    }
    await trx("trading_settings").update({ ...update, updated_at: trx.fn.now(), updated_by_user_id: userId });
    if (audit.length > 0) await trx("risk_limits_audit").insert(audit);
  });
}

export interface RiskLimitsAuditRow {
  id: number;
  changedAt: string;
  userDisplayName: string | null;
  /** A TradingSettings field name, or "tradingHalt" (values "on" / "off", with the reason given). */
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
}

/** Every change to the trading settings and the trading halt, newest first. */
export async function loadRiskLimitsAudit(limit = 100): Promise<RiskLimitsAuditRow[]> {
  const rows = await db("risk_limits_audit as a").leftJoin("users as u", "u.id", "a.user_id").select("a.*", "u.display_name as user_display_name").orderBy("a.changed_at", "desc").orderBy("a.id", "desc").limit(limit);
  return rows.map((row) => ({
    id: Number(row.id),
    changedAt: new Date(row.changed_at).toISOString(),
    userDisplayName: row.user_display_name ?? null,
    field: row.field,
    oldValue: row.old_value ?? null,
    newValue: row.new_value ?? null,
    reason: row.reason ?? null,
  }));
}

/** Just the unfilled-order cancel limit, for the worker's sweep (which must not pay for the commission estimator). */
export async function loadOrderUnfilledCancelMinutes(): Promise<number> {
  const row = await db("trading_settings").first("order_unfilled_cancel_minutes");
  if (!row) throw new Error("No trading_settings row found.");
  return Number(row.order_unfilled_cancel_minutes);
}

/** Just the limit-price check tolerance, for the order paths that must not pay for the commission estimator (the worker's placement step). */
export async function loadPriceCheckTolerance(): Promise<{ maxDeviationPct: number; minToleranceDollars: number }> {
  const row = await db("trading_settings").first("price_check_max_deviation_pct", "price_check_min_tolerance_dollars");
  if (!row) throw new Error("No trading_settings row found.");
  return { maxDeviationPct: Number(row.price_check_max_deviation_pct), minToleranceDollars: Number(row.price_check_min_tolerance_dollars) };
}
