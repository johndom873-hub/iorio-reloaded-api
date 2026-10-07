import type { Knex } from "knex";
import { db } from "../db/connection.js";

// Pluto's parameters: one typed row (pluto_settings) plus an audit trail of every
// change (pluto_settings_audit). Every reader goes through loadPlutoSettings; every
// writer through updatePlutoSettings, which records field-level diffs with who/when.
// Defaults were approved by Marcelo 2026-09-28 and live in the migration.

export type PlutoGrade = "strong" | "good" | "weak";
export type PlutoReasoningEffort = "low" | "medium" | "high";
export type PlutoTelegramVerbosity = "actions" | "off";

export interface PlutoSettings {
  // Capital
  capitalBudgetPct: number;
  maxTickerExposurePct: number;
  maxSectorExposurePct: number;
  maxOpenPositions: number;
  maxActionsPerSession: number;
  /** The standard order: this share of Pluto's capital budget (budget = capitalBudgetPct of NLV). */
  orderSizePctOfBudget: number;
  minCashReservePct: number;
  // Candidate quality
  minGrade: PlutoGrade;
  minEdgeDollars: number;
  maxAbsDelta: number;
  minDte: number;
  maxDte: number;
  minAnnualizedYieldPct: number;
  maxSpreadPct: number;
  minOpenInterest: number;
  minSessionVolume: number;
  maxQuoteAgeMinutes: number;
  maxContractsVolumeSharePct: number;
  // Model risk
  maxSliceRmseVp: number;
  minSlicePointCount: number;
  maxMidVsSurfaceIvVp: number;
  maxIvShiftVp: number;
  /** A ticker whose move today is more than this many times its normal daily move (expectedDailyMovePct) is out for the round. */
  maxDayMoveMultiple: number;
  // Market
  windowStartEt: string;
  windowEndEt: string;
  dailyLossBreakerPct: number;
  spyStressBreakerPct: number;
  // Execution
  maxEdgeDriftVp: number;
  /** Minutes after a filled Pluto action on a symbol before Pluto may act on it again; 0 = no cooldown. */
  tickerCooldownMinutes: number;
  /** A fill this far (% of the reference price) past the reference trips the fill_slippage breaker. */
  maxFillSlippagePct: number;
  // Model
  modelId: string;
  reasoningEffort: PlutoReasoningEffort;
  callTimeoutSeconds: number;
  dailyCostCeilingUsd: number;
  confidenceFloor: number;
  consecutiveModelFailuresBreaker: number;
  promptVersion: string;
  // Real-time
  /** How often the loop checks the Day Signals table for contracts quoted since Pluto last analysed them. */
  daySignalsPollSeconds: number;
  burstLines: number;
  burstSettleSeconds: number;
  perTickerModelCooldownMinutes: number;
  maxEnabledTickers: number;
  messageRateLimitPerSecond: number;
  // Operational
  crashLoopRestartsPerHour: number;
  telegramVerbosity: PlutoTelegramVerbosity;
  // Closing (Formulas P1 / P2)
  unstructuredCloseMinPct: number;
  unstructuredCloseMinDollars: number;
  buybackMinDte: number;
  updatedAt: string;
  updatedByUserId: string | null;
}

type ColumnKind = "number" | "integer" | "text";

/** camelCase field → snake_case column, with the kind that decides parsing and validation. */
export const plutoSettingsColumns: Record<Exclude<keyof PlutoSettings, "updatedAt" | "updatedByUserId">, { column: string; kind: ColumnKind; min?: number; max?: number; oneOf?: readonly string[] }> = {
  capitalBudgetPct: { column: "capital_budget_pct", kind: "number", min: 0, max: 100 },
  maxTickerExposurePct: { column: "max_ticker_exposure_pct", kind: "number", min: 0, max: 100 },
  maxSectorExposurePct: { column: "max_sector_exposure_pct", kind: "number", min: 0, max: 100 },
  maxOpenPositions: { column: "max_open_positions", kind: "integer", min: 0 },
  maxActionsPerSession: { column: "max_actions_per_session", kind: "integer", min: 0 },
  orderSizePctOfBudget: { column: "order_size_pct_of_budget", kind: "number", min: 0, max: 100 },
  minCashReservePct: { column: "min_cash_reserve_pct", kind: "number", min: 0, max: 100 },
  minGrade: { column: "min_grade", kind: "text", oneOf: ["strong", "good", "weak"] },
  minEdgeDollars: { column: "min_edge_dollars", kind: "number", min: 0 },
  maxAbsDelta: { column: "max_abs_delta", kind: "number", min: 0, max: 1 },
  minDte: { column: "min_dte", kind: "integer", min: 0 },
  maxDte: { column: "max_dte", kind: "integer", min: 0 },
  minAnnualizedYieldPct: { column: "min_annualized_yield_pct", kind: "number", min: 0 },
  maxSpreadPct: { column: "max_spread_pct", kind: "number", min: 0 },
  minOpenInterest: { column: "min_open_interest", kind: "integer", min: 0 },
  minSessionVolume: { column: "min_session_volume", kind: "integer", min: 0 },
  maxQuoteAgeMinutes: { column: "max_quote_age_minutes", kind: "integer", min: 0 },
  maxContractsVolumeSharePct: { column: "max_contracts_volume_share_pct", kind: "number", min: 0, max: 100 },
  maxSliceRmseVp: { column: "max_slice_rmse_vp", kind: "number", min: 0 },
  minSlicePointCount: { column: "min_slice_point_count", kind: "integer", min: 0 },
  maxMidVsSurfaceIvVp: { column: "max_mid_vs_surface_iv_vp", kind: "number", min: 0 },
  maxIvShiftVp: { column: "max_iv_shift_vp", kind: "number", min: 0 },
  maxDayMoveMultiple: { column: "max_day_move_multiple", kind: "number", min: 0 },
  windowStartEt: { column: "window_start_et", kind: "text" },
  windowEndEt: { column: "window_end_et", kind: "text" },
  dailyLossBreakerPct: { column: "daily_loss_breaker_pct", kind: "number", min: 0, max: 100 },
  spyStressBreakerPct: { column: "spy_stress_breaker_pct", kind: "number", min: 0, max: 100 },
  maxEdgeDriftVp: { column: "max_edge_drift_vp", kind: "number", min: 0 },
  tickerCooldownMinutes: { column: "ticker_cooldown_minutes", kind: "integer", min: 0 },
  maxFillSlippagePct: { column: "max_fill_slippage_pct", kind: "number", min: 0, max: 100 },
  modelId: { column: "model_id", kind: "text" },
  reasoningEffort: { column: "reasoning_effort", kind: "text", oneOf: ["low", "medium", "high"] },
  callTimeoutSeconds: { column: "call_timeout_seconds", kind: "integer", min: 5 },
  dailyCostCeilingUsd: { column: "daily_cost_ceiling_usd", kind: "number", min: 0 },
  confidenceFloor: { column: "confidence_floor", kind: "number", min: 0, max: 1 },
  consecutiveModelFailuresBreaker: { column: "consecutive_model_failures_breaker", kind: "integer", min: 1 },
  promptVersion: { column: "prompt_version", kind: "text" },
  daySignalsPollSeconds: { column: "day_signals_poll_seconds", kind: "integer", min: 1 },
  burstLines: { column: "burst_lines", kind: "integer", min: 1 },
  burstSettleSeconds: { column: "burst_settle_seconds", kind: "integer", min: 1 },
  perTickerModelCooldownMinutes: { column: "per_ticker_model_cooldown_minutes", kind: "integer", min: 0 },
  maxEnabledTickers: { column: "max_enabled_tickers", kind: "integer", min: 0 },
  messageRateLimitPerSecond: { column: "message_rate_limit_per_second", kind: "integer", min: 1 },
  crashLoopRestartsPerHour: { column: "crash_loop_restarts_per_hour", kind: "integer", min: 1 },
  telegramVerbosity: { column: "telegram_verbosity", kind: "text", oneOf: ["actions", "off"] },
  unstructuredCloseMinPct: { column: "unstructured_close_min_pct", kind: "number", min: 0 },
  unstructuredCloseMinDollars: { column: "unstructured_close_min_dollars", kind: "number", min: 0 },
  buybackMinDte: { column: "buyback_min_dte", kind: "integer", min: 0 },
};

export type PlutoSettingsField = keyof typeof plutoSettingsColumns;
export type PlutoSettingsInput = Partial<Pick<PlutoSettings, PlutoSettingsField>>;

const timeOfDayPattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function rowToSettings(row: Record<string, unknown>): PlutoSettings {
  const out: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(plutoSettingsColumns)) {
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
  if (merged.minDte > merged.maxDte) return "minDte cannot exceed maxDte.";
  if (merged.windowStartEt >= merged.windowEndEt) return "windowStartEt must be before windowEndEt.";
  return null;
}

/** Applies the changed fields only, writing one audit row per field that actually changed. */
export async function updatePlutoSettings(input: PlutoSettingsInput, userId: string): Promise<PlutoSettings> {
  return db.transaction(async (trx) => {
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
  });
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
