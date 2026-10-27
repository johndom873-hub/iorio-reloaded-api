import type { Knex } from "knex";
import { db } from "../db/connection.js";

// Pluto's parameters: one typed row (pluto_settings) plus an audit trail of every
// change (pluto_settings_audit). Every reader goes through loadPlutoSettings; every
// writer through updatePlutoSettings, which records field-level diffs with who/when.
// Defaults were approved by Marcelo 2026-09-28 and live in the migration.

export type PlutoTelegramVerbosity = "actions" | "off";

export interface PlutoSettings {
  // Capital
  capitalBudgetPct: number;
  maxActionsPerSession: number;
  // Market
  windowStartEt: string;
  windowEndEt: string;
  dailyLossBreakerPct: number;
  // Execution
  /** A ladder band quote older than this is left out of the look. */
  maxQuoteAgeMinutes: number;
  /** A fill this far (% of the reference price) past the reference trips the fill_slippage breaker. */
  maxFillSlippagePct: number;
  // Real-time
  /** How often the loop checks the ladder's band quotes for contracts quoted since Pluto last analysed them. */
  bandQuotePollSeconds: number;
  burstLines: number;
  burstSettleSeconds: number;
  maxEnabledTickers: number;
  // Operational
  crashLoopRestartsPerHour: number;
  telegramVerbosity: PlutoTelegramVerbosity;
  // CC + Put Ladder (the backtest's baseline keys with a "ladder" prefix; loadLadderSettingsForTicker maps them back)
  ladderMinAbsDelta: number;
  ladderMaxAbsDelta: number;
  ladderMinDte: number;
  ladderMaxDte: number;
  ladderMaxSpreadPctOfMid: number;
  ladderRungs: number;
  /** The default share level; a ticker may override it (pluto_ticker_settings). */
  ladderSharesPct: number;
  ladderShockMinPct: number;
  ladderShockMaxPct: number;
  ladderShockNoHistoryPct: number;
  ladderShockLookbackYears: number;
  /** At most this many of a ticker's ladder orders work at once; the rest go at the next looks. */
  ladderMaxWorkingOrdersPerTicker: number;
  /** The ladder's SPY stress breaker. */
  ladderSpyStressBreakerPct: number;
  /** Minutes after a filled ladder order on a ticker before the ladder may act on it again; 0 = no cooldown. */
  ladderTickerCooldownMinutes: number;
  ladderMaxOpenPositionsPerTicker: number;
  /** Every ladder order sent on a ticker in a day counts, re-prices included. */
  ladderMaxOrdersPerTickerPerDay: number;
  /** Across every ladder ticker: open positions plus the ladder's working orders. */
  ladderMaxOpenPositions: number;
  /** Across every ladder ticker: ladder orders sent in a day, counted as the per-ticker daily cap counts them. */
  ladderMaxOrdersPerDay: number;
  updatedAt: string;
  updatedByUserId: string | null;
}

type ColumnKind = "number" | "integer" | "text";

/** camelCase field → snake_case column, with the kind that decides parsing and validation. */
export const plutoSettingsColumns: Record<Exclude<keyof PlutoSettings, "updatedAt" | "updatedByUserId">, { column: string; kind: ColumnKind; min?: number; max?: number; oneOf?: readonly string[] }> = {
  capitalBudgetPct: { column: "capital_budget_pct", kind: "number", min: 0, max: 100 },
  maxActionsPerSession: { column: "max_actions_per_session", kind: "integer", min: 0 },
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
  // The ladder's bounds are the backtest's (validateBaselineSettings), so every live value can be backtested.
  ladderMinAbsDelta: { column: "ladder_min_abs_delta", kind: "number", min: 0, max: 1 },
  ladderMaxAbsDelta: { column: "ladder_max_abs_delta", kind: "number", min: 0, max: 1 },
  ladderMinDte: { column: "ladder_min_dte", kind: "integer", min: 0, max: 45 },
  ladderMaxDte: { column: "ladder_max_dte", kind: "integer", min: 0, max: 45 },
  ladderMaxSpreadPctOfMid: { column: "ladder_max_spread_pct_of_mid", kind: "number", min: 0, max: 200 },
  ladderRungs: { column: "ladder_rungs", kind: "integer", min: 1, max: 20 },
  ladderSharesPct: { column: "ladder_shares_pct", kind: "number", min: 1, max: 99 },
  ladderShockMinPct: { column: "ladder_shock_min_pct", kind: "number", min: 1, max: 99 },
  ladderShockMaxPct: { column: "ladder_shock_max_pct", kind: "number", min: 1, max: 99 },
  ladderShockNoHistoryPct: { column: "ladder_shock_no_history_pct", kind: "number", min: 1, max: 99 },
  ladderShockLookbackYears: { column: "ladder_shock_lookback_years", kind: "integer", min: 1, max: 30 },
  ladderMaxWorkingOrdersPerTicker: { column: "ladder_max_working_orders_per_ticker", kind: "integer", min: 1, max: 100 },
  ladderSpyStressBreakerPct: { column: "ladder_spy_stress_breaker_pct", kind: "number", min: 0, max: 100 },
  ladderTickerCooldownMinutes: { column: "ladder_ticker_cooldown_minutes", kind: "integer", min: 0 },
  ladderMaxOpenPositionsPerTicker: { column: "ladder_max_open_positions_per_ticker", kind: "integer", min: 1, max: 1000 },
  ladderMaxOrdersPerTickerPerDay: { column: "ladder_max_orders_per_ticker_per_day", kind: "integer", min: 1, max: 1000 },
  ladderMaxOpenPositions: { column: "ladder_max_open_positions", kind: "integer", min: 1, max: 10000 },
  ladderMaxOrdersPerDay: { column: "ladder_max_orders_per_day", kind: "integer", min: 1, max: 10000 },
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
  if (merged.windowStartEt >= merged.windowEndEt) return "windowStartEt must be before windowEndEt.";
  if (merged.ladderMinAbsDelta <= 0) return "ladderMinAbsDelta must be above 0.";
  if (merged.ladderMinAbsDelta > merged.ladderMaxAbsDelta) return "ladderMinAbsDelta cannot exceed ladderMaxAbsDelta.";
  if (merged.ladderMinDte > merged.ladderMaxDte) return "ladderMinDte cannot exceed ladderMaxDte.";
  if (merged.ladderMaxSpreadPctOfMid <= 0) return "ladderMaxSpreadPctOfMid must be above 0.";
  if (merged.ladderShockMinPct > merged.ladderShockMaxPct) return "ladderShockMinPct cannot exceed ladderShockMaxPct.";
  return null;
}

/** Applies the changed fields only, writing one audit row per field that actually changed. */
export async function updatePlutoSettings(input: PlutoSettingsInput, userId: string): Promise<PlutoSettings> {
  return db.transaction(async (trx) => {
    const current = await loadPlutoSettings(trx);
    const problem = validatePlutoSettingsInput(input, current);
    if (problem) throw new PlutoSettingsValidationError(problem);
    if (input.ladderMinAbsDelta !== undefined || input.ladderMaxAbsDelta !== undefined) {
      const broken = await tickersWithBrokenDeltaRange({ ...current, ...input } as PlutoSettings, trx);
      if (broken.length > 0) throw new PlutoSettingsValidationError(`${broken.map((entry) => `${entry.symbol}'s |delta| range would be ${entry.from.toFixed(2)}–${entry.to.toFixed(2)} (it sets its own ${entry.ownLimits}).`).join(" ")} Change ${broken.length === 1 ? "that ticker's override" : "those tickers' overrides"} in the ticker window first.`);
    }
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

/**
 * Tickers whose effective |delta| range the strategy's would leave empty (lower limit above upper): each limit is the
 * ticker's override where it has one, else the strategy's. A strategy save that does this is refused (Marcelo 2026-10-15).
 */
export async function tickersWithBrokenDeltaRange(settings: Pick<PlutoSettings, "ladderMinAbsDelta" | "ladderMaxAbsDelta">, connection: Knex = db): Promise<{ symbol: string; from: number; to: number; ownLimits: string }[]> {
  const rows: { symbol: string; ladder_min_abs_delta: string | null; ladder_max_abs_delta: string | null }[] = await connection("pluto_ticker_settings as s")
    .join("tickers as t", "t.id", "s.ticker_id")
    .where((inner) => inner.whereNotNull("s.ladder_min_abs_delta").orWhereNotNull("s.ladder_max_abs_delta"))
    .orderBy("t.symbol")
    .select("t.symbol", "s.ladder_min_abs_delta", "s.ladder_max_abs_delta");
  return rows.flatMap((row) => {
    const ownMin = row.ladder_min_abs_delta === null ? null : Number(row.ladder_min_abs_delta);
    const ownMax = row.ladder_max_abs_delta === null ? null : Number(row.ladder_max_abs_delta);
    const from = ownMin ?? settings.ladderMinAbsDelta;
    const to = ownMax ?? settings.ladderMaxAbsDelta;
    if (from <= to) return [];
    return [{ symbol: row.symbol, from, to, ownLimits: ownMin !== null && ownMax !== null ? "lower and upper limits" : ownMin !== null ? "lower limit" : "upper limit" }];
  });
}

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
