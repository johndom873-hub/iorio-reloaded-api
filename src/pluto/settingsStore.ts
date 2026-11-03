import type { Knex } from "knex";
import { db } from "../db/connection.js";
import {
  volFarmerV2StepRules,
  volFarmerV3CallsInTheMoneyAtLastLookChoices,
  volFarmerV3AlwaysHoldTheStockChoices,
  volFarmerV3CallStrikeFloorChoices,
  volFarmerV3FirstPositionAfterCalledAwayChoices,
  volFarmerV3OptionsExpiryChoices,
  volFarmerV3PutsSoldChoices,
  volFarmerV3PutStrikeCapChoices,
  volFarmerV3RebalancesChoices,
  volFarmerV3TrimsSellChoices,
  type VolFarmerV3CallsInTheMoneyAtLastLook,
  type VolFarmerV3AlwaysHoldTheStock,
  type VolFarmerV3CallStrikeFloor,
  type VolFarmerV3FirstPositionAfterCalledAway,
  type VolFarmerV3OptionsExpiry,
  type VolFarmerV3PutsSold,
  type VolFarmerV3PutStrikeCap,
  type VolFarmerV3Rebalances,
  type VolFarmerV3TrimsSell,
} from "../backtest/backtestTypes.js";

// Pluto's parameters: one typed row (pluto_settings) plus an audit trail of every
// change (pluto_settings_audit). Every reader goes through loadPlutoSettings; every
// writer through updatePlutoSettings, which records field-level diffs with who/when.
// Defaults were approved by Marcelo 2026-09-28 and live in the migration.

export type PlutoTelegramVerbosity = "actions" | "off";

export interface PlutoSettings {
  // Capital
  capitalBudgetPct: number;
  /** % every ticker's pot is raised above its allocation (tickerPotFraction): the pots may add up to more than the budget. */
  excessAllowancePct: number;
  // Market
  windowStartEt: string;
  windowEndEt: string;
  dailyLossBreakerPct: number;
  // Execution
  /** An option quote band quote older than this is left out of the look. */
  maxQuoteAgeMinutes: number;
  /** A fill this far (% of the reference price) past the reference trips the fill_slippage breaker. */
  maxFillSlippagePct: number;
  // Real-time
  /** How often the loop checks the option quote band's quotes for contracts quoted since Pluto last analysed them. */
  bandQuotePollSeconds: number;
  burstLines: number;
  burstSettleSeconds: number;
  maxEnabledTickers: number;
  // Operational
  crashLoopRestartsPerHour: number;
  telegramVerbosity: PlutoTelegramVerbosity;
  // Safety Limits: they hold Vol Farmer v4's orders (safetyLimits.ts).
  /** At most this many of a ticker's orders work at once; the rest go at the next looks. */
  safetyMaxWorkingOrdersPerTicker: number;
  /** While SPY is down this much on the day, Vol Farmer v4 opens nothing. */
  safetySpyStressBreakerPct: number;
  /** Minutes after a filled Pluto order on a ticker before Pluto may act on it again; 0 = no cooldown. */
  safetyTickerCooldownMinutes: number;
  safetyMaxOpenPositionsPerTicker: number;
  /** Every Pluto order sent on a ticker in a day counts, re-prices included. */
  safetyMaxOrdersPerTickerPerDay: number;
  /** Across every Pluto ticker: open positions plus Pluto's working orders. */
  safetyMaxOpenPositions: number;
  /** Across every Pluto ticker: Pluto's orders sent in a day, counted as the per-ticker daily cap counts them. */
  safetyMaxOrdersPerDay: number;
  // Vol Farmer v4 (the lab's volFarmerV4 keys with a "volFarmerV4" prefix; volFarmerV4RulesOf maps them back). v2's,
  // renamed when v4 replaced it (Marcelo 2026-10-31), and v4's own choices, at the lab's best run; never synced with the lab.
  /** % of the ticker's pot the first position's shares are bought with; the Puts sell on the rest (Marcelo 2026-10-30). */
  volFarmerV4FirstPositionPct: number;
  volFarmerV4PutsStartCallYieldPct: number;
  volFarmerV4PutMaxAbsDelta: number;
  volFarmerV4StepBelowFirstBreakEvenPct: number;
  volFarmerV4StepRule: "fixed" | "implied_move_at_put_sale";
  volFarmerV4LeapsMinDte: number;
  volFarmerV4LeapsAbsDelta: number;
  /** % of the ticker's pot (its allocation raised by the excess allowance) a LEAPS purchase spends at most. */
  volFarmerV4LeapsMaxAllocationPct: number;
  volFarmerV4CallMinAbsDelta: number;
  volFarmerV4CallMaxAbsDelta: number;
  volFarmerV4MaxSpreadPctOfMid: number;
  /** % of the ticker's pot the holding may drift from its target before it is traded back (BacktestVolFarmerV3Settings). */
  volFarmerV4RebalanceBandPct: number;
  volFarmerV4Rebalances: VolFarmerV3Rebalances;
  volFarmerV4FirstPositionAfterCalledAway: VolFarmerV3FirstPositionAfterCalledAway;
  volFarmerV4OptionsExpiry: VolFarmerV3OptionsExpiry;
  volFarmerV4OptionsMaxDaysToExpiry: number;
  volFarmerV4CallStrikeFloor: VolFarmerV3CallStrikeFloor;
  volFarmerV4PutsSold: VolFarmerV3PutsSold;
  volFarmerV4PutStrikeCap: VolFarmerV3PutStrikeCap;
  volFarmerV4TrimsSell: VolFarmerV3TrimsSell;
  /** Top-ups take a ticker's money in (held shares' cost, open Puts' cash) to at most this % of its pot; 0: no cap. */
  volFarmerV4TopUpCapPct: number;
  /** A Call expiring today still in the money in the window's last minutes: assigned at the close, or bought back (every day, or before weekends only). */
  volFarmerV4CallsInTheMoneyAtLastLook: VolFarmerV3CallsInTheMoneyAtLastLook;
  /** Every ticker's Always hold the stock unless it sets its own (pluto_ticker_settings.always_hold_the_stock). */
  volFarmerV4AlwaysHoldTheStock: VolFarmerV3AlwaysHoldTheStock;
  updatedAt: string;
  updatedByUserId: string | null;
}

type ColumnKind = "number" | "integer" | "text";

/** camelCase field → snake_case column, with the kind that decides parsing and validation. */
export const plutoSettingsColumns: Record<Exclude<keyof PlutoSettings, "updatedAt" | "updatedByUserId">, { column: string; kind: ColumnKind; min?: number; max?: number; oneOf?: readonly string[] }> = {
  capitalBudgetPct: { column: "capital_budget_pct", kind: "number", min: 0, max: 100 },
  excessAllowancePct: { column: "excess_allowance_pct", kind: "number", min: 0, max: 1000 },
  maxQuoteAgeMinutes: { column: "max_quote_age_minutes", kind: "integer", min: 0 },
  windowStartEt: { column: "window_start_et", kind: "text" },
  windowEndEt: { column: "window_end_et", kind: "text" },
  dailyLossBreakerPct: { column: "daily_loss_breaker_pct", kind: "number", min: 0, max: 100 },
  maxFillSlippagePct: { column: "max_fill_slippage_pct", kind: "number", min: 0, max: 100 },
  bandQuotePollSeconds: { column: "day_signals_poll_seconds", kind: "integer", min: 1 },
  burstLines: { column: "burst_lines", kind: "integer", min: 1 },
  burstSettleSeconds: { column: "burst_settle_seconds", kind: "integer", min: 1 },
  maxEnabledTickers: { column: "max_enabled_tickers", kind: "integer", min: 0 },
  crashLoopRestartsPerHour: { column: "crash_loop_restarts_per_hour", kind: "integer", min: 1 },
  telegramVerbosity: { column: "telegram_verbosity", kind: "text", oneOf: ["actions", "off"] },
  safetyMaxWorkingOrdersPerTicker: { column: "safety_max_working_orders_per_ticker", kind: "integer", min: 1, max: 100 },
  safetySpyStressBreakerPct: { column: "safety_spy_stress_breaker_pct", kind: "number", min: 0, max: 100 },
  safetyTickerCooldownMinutes: { column: "safety_ticker_cooldown_minutes", kind: "integer", min: 0 },
  safetyMaxOpenPositionsPerTicker: { column: "safety_max_open_positions_per_ticker", kind: "integer", min: 1, max: 1000 },
  safetyMaxOrdersPerTickerPerDay: { column: "safety_max_orders_per_ticker_per_day", kind: "integer", min: 1, max: 1000 },
  safetyMaxOpenPositions: { column: "safety_max_open_positions", kind: "integer", min: 1, max: 10000 },
  safetyMaxOrdersPerDay: { column: "safety_max_orders_per_day", kind: "integer", min: 1, max: 10000 },
  // Vol Farmer v4's bounds and choices are the backtest's (validateVolFarmerV4Settings).
  volFarmerV4FirstPositionPct: { column: "vol_farmer_v4_first_position_pct", kind: "number", min: 10, max: 90 },
  volFarmerV4PutsStartCallYieldPct: { column: "vol_farmer_v4_puts_start_call_yield_pct", kind: "number", min: 0, max: 500 },
  volFarmerV4PutMaxAbsDelta: { column: "vol_farmer_v4_put_max_abs_delta", kind: "number", min: 0.01, max: 0.99 },
  volFarmerV4StepBelowFirstBreakEvenPct: { column: "vol_farmer_v4_step_below_first_break_even_pct", kind: "number", min: 0, max: 90 },
  volFarmerV4StepRule: { column: "vol_farmer_v4_step_rule", kind: "text", oneOf: volFarmerV2StepRules },
  volFarmerV4LeapsMinDte: { column: "vol_farmer_v4_leaps_min_dte", kind: "integer", min: 30, max: 1000 },
  volFarmerV4LeapsAbsDelta: { column: "vol_farmer_v4_leaps_abs_delta", kind: "number", min: 0.05, max: 0.99 },
  volFarmerV4LeapsMaxAllocationPct: { column: "vol_farmer_v4_leaps_max_allocation_pct", kind: "number", min: 0, max: 100 },
  volFarmerV4CallMinAbsDelta: { column: "vol_farmer_v4_call_min_abs_delta", kind: "number", min: 0, max: 1 },
  volFarmerV4CallMaxAbsDelta: { column: "vol_farmer_v4_call_max_abs_delta", kind: "number", min: 0, max: 1 },
  volFarmerV4MaxSpreadPctOfMid: { column: "vol_farmer_v4_max_spread_pct_of_mid", kind: "number", min: 0, max: 200 },
  volFarmerV4RebalanceBandPct: { column: "vol_farmer_v4_rebalance_band_pct", kind: "number", min: 0, max: 50 },
  volFarmerV4Rebalances: { column: "vol_farmer_v4_rebalances", kind: "text", oneOf: volFarmerV3RebalancesChoices },
  volFarmerV4FirstPositionAfterCalledAway: { column: "vol_farmer_v4_first_position_after_called_away", kind: "text", oneOf: volFarmerV3FirstPositionAfterCalledAwayChoices },
  volFarmerV4OptionsExpiry: { column: "vol_farmer_v4_options_expiry", kind: "text", oneOf: volFarmerV3OptionsExpiryChoices },
  volFarmerV4OptionsMaxDaysToExpiry: { column: "vol_farmer_v4_options_max_days_to_expiry", kind: "integer", min: 1, max: 45 },
  volFarmerV4CallStrikeFloor: { column: "vol_farmer_v4_call_strike_floor", kind: "text", oneOf: volFarmerV3CallStrikeFloorChoices },
  volFarmerV4PutsSold: { column: "vol_farmer_v4_puts_sold", kind: "text", oneOf: volFarmerV3PutsSoldChoices },
  volFarmerV4PutStrikeCap: { column: "vol_farmer_v4_put_strike_cap", kind: "text", oneOf: volFarmerV3PutStrikeCapChoices },
  volFarmerV4TrimsSell: { column: "vol_farmer_v4_trims_sell", kind: "text", oneOf: volFarmerV3TrimsSellChoices },
  volFarmerV4TopUpCapPct: { column: "vol_farmer_v4_top_up_cap_pct", kind: "number", min: 0, max: 1000 },
  volFarmerV4CallsInTheMoneyAtLastLook: { column: "vol_farmer_v4_calls_in_the_money_at_last_look", kind: "text", oneOf: volFarmerV3CallsInTheMoneyAtLastLookChoices },
  volFarmerV4AlwaysHoldTheStock: { column: "vol_farmer_v4_always_hold_the_stock", kind: "text", oneOf: volFarmerV3AlwaysHoldTheStockChoices },
};

export type PlutoSettingsField = keyof typeof plutoSettingsColumns;
export type PlutoSettingsInput = Partial<Pick<PlutoSettings, PlutoSettingsField>>;

const timeOfDayPattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function rowToSettings(row: Record<string, unknown>): PlutoSettings {
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(plutoSettingsColumns)) {
    // A missing column would read as NaN, and a cap of NaN never holds: code older than the schema fails instead.
    if (!(spec.column in row)) throw new Error(`pluto_settings has no ${spec.column} column.`);
    const raw = row[spec.column];
    out[field] = spec.kind === "text" ? String(raw) : Number(raw);
  }
  out.updatedAt = new Date(row.updated_at as string).toISOString();
  out.updatedByUserId = (row.updated_by_user_id as string | null) ?? null;
  return out as unknown as PlutoSettings;
}

export async function loadPlutoSettings(connection: Knex = db): Promise<PlutoSettings> {
  const row = await connection("pluto_settings").where({ id: 1 }).first();
  if (!row) throw new Error("No pluto_settings row found.");
  return rowToSettings(row);
}

/** Field-by-field validation; returns the first problem, or null. Cross-field rules (window, DTE) included. */
export function validatePlutoSettingsInput(input: PlutoSettingsInput, current: PlutoSettings): string | null {
  for (const [field, value] of Object.entries(input)) {
    const spec = plutoSettingsColumns[field as PlutoSettingsField];
    if (!spec) return `${field} is not a Pluto setting.`;
    if (spec.kind === "text") {
      if (typeof value !== "string" || value.trim() === "") return `${field} must be text.`;
      if (spec.oneOf && !spec.oneOf.includes(value)) return `${field} must be one of ${spec.oneOf.join(", ")}.`;
      if ((field === "windowStartEt" || field === "windowEndEt") && !timeOfDayPattern.test(value)) return `${field} must be HH:MM (24 h, ET).`;
      continue;
    }
    if (typeof value !== "number" || Number.isNaN(value)) return `${field} must be a number.`;
    if (spec.kind === "integer" && !Number.isInteger(value)) return `${field} must be a whole number.`;
    if (spec.min !== undefined && value < spec.min) return `${field} cannot be below ${spec.min}.`;
    if (spec.max !== undefined && value > spec.max) return `${field} cannot be above ${spec.max}.`;
  }
  const merged = { ...current, ...input };
  if (merged.windowStartEt >= merged.windowEndEt) return "windowStartEt must be before windowEndEt.";
  if (merged.volFarmerV4CallMinAbsDelta > merged.volFarmerV4CallMaxAbsDelta) return "volFarmerV4CallMinAbsDelta cannot exceed volFarmerV4CallMaxAbsDelta.";
  if (merged.volFarmerV4MaxSpreadPctOfMid <= 0) return "volFarmerV4MaxSpreadPctOfMid must be above 0.";
  return null;
}

/** Applies the changed fields only, writing one audit row per field that actually changed; within `transaction` when given. */
export async function updatePlutoSettings(input: PlutoSettingsInput, userId: string, transaction?: Knex.Transaction): Promise<PlutoSettings> {
  const apply = async (trx: Knex.Transaction) => {
    const current = await loadPlutoSettings(trx);
    const problem = validatePlutoSettingsInput(input, current);
    if (problem) throw new PlutoSettingsValidationError(problem);
    const update: Record<string, unknown> = {};
    const audit: { user_id: string; field: string; old_value: string; new_value: string }[] = [];
    for (const [field, value] of Object.entries(input)) {
      const spec = plutoSettingsColumns[field as PlutoSettingsField];
      const before = current[field as PlutoSettingsField];
      if (String(before) === String(value)) continue;
      update[spec.column] = value;
      audit.push({ user_id: userId, field, old_value: String(before), new_value: String(value) });
    }
    if (audit.length === 0) return current;
    await trx("pluto_settings").where({ id: 1 }).update({ ...update, updated_at: trx.fn.now(), updated_by_user_id: userId });
    await trx("pluto_settings_audit").insert(audit);
    return loadPlutoSettings(trx);
  };
  return transaction ? apply(transaction) : db.transaction(apply);
}

export class PlutoSettingsValidationError extends Error {}

export interface PlutoSettingsAuditRow {
  id: number;
  changedAt: string;
  userId: string | null;
  userDisplayName: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export async function loadPlutoSettingsAudit(limit = 100): Promise<PlutoSettingsAuditRow[]> {
  const rows = await db("pluto_settings_audit as a")
    .leftJoin("users as u", "u.id", "a.user_id")
    .select("a.*", "u.display_name as user_display_name")
    .orderBy("a.changed_at", "desc")
    .limit(limit);
  return rows.map((row) => ({
    id: Number(row.id),
    changedAt: new Date(row.changed_at).toISOString(),
    userId: row.user_id ?? null,
    userDisplayName: row.user_display_name ?? null,
    field: row.field,
    oldValue: row.old_value ?? null,
    newValue: row.new_value ?? null,
  }));
}
