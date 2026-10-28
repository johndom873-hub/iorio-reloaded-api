import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { effectiveAllocationPctBySymbol, tickerPotShare } from "../lib/tickerAllocation.js";
import { updatePlutoSettings, type PlutoSettings } from "./settingsStore.js";

// Pluto's per-ticker settings (Marcelo 2026-10-15): one row per ticker in pluto_ticker_settings, null meaning "the
// default", with a field-level audit trail (pluto_ticker_settings_audit). Read by the CC + Put Ladder through
// loadLadderSettingsForTicker (ladderSettings.ts). Each ticker runs one strategy (Marcelo 2026-10-27): Vol Farmer v2
// unless it is set to the CC + Put Ladder.

export const plutoStrategies = ["vol_farmer_v2", "cc_put_ladder"] as const;
export type PlutoStrategy = (typeof plutoStrategies)[number];
/** The strategy of a ticker with none set. */
export const defaultPlutoStrategy: PlutoStrategy = "vol_farmer_v2";

/** The strategy Pluto runs on the ticker: its own, else the default. */
export function effectivePlutoStrategy(ticker: Pick<PlutoTickerSettings, "strategy">): PlutoStrategy {
  return ticker.strategy ?? defaultPlutoStrategy;
}

export interface PlutoTickerSettings {
  symbol: string;
  tickerId: string;
  /** The strategy set for the ticker; null = the default (effectivePlutoStrategy). */
  strategy: PlutoStrategy | null;
  /** % of Pluto's capital budget for this ticker's pot; null = an equal share of what the set allocations leave. */
  allocationPct: number | null;
  /** Overrides the strategy's default share level (pluto_settings.ladder_shares_pct). */
  ladderSharesPct: number | null;
  /** Overrides the recommended shock (the Max drawdown rule). */
  ladderShockOverridePct: number | null;
  /** Override the strategy's rungs and |delta| range (pluto_settings.ladder_rungs, ladder_min_abs_delta, ladder_max_abs_delta). */
  ladderRungs: number | null;
  ladderMinAbsDelta: number | null;
  ladderMaxAbsDelta: number | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export type PlutoTickerSettingsField = "allocationPct" | "ladderSharesPct" | "ladderShockOverridePct" | "ladderRungs" | "ladderMinAbsDelta" | "ladderMaxAbsDelta";
export type PlutoTickerSettingsInput = Partial<Record<PlutoTickerSettingsField, number | null>> & { strategy?: PlutoStrategy | null };

/** Above `above` (exclusive) and at most `max`, whole when `integer`; the ladder's bounds are the backtest's. */
export const plutoTickerSettingsColumns: Record<PlutoTickerSettingsField, { column: string; above: number; max: number; integer?: true }> = {
  allocationPct: { column: "allocation_pct", above: 0, max: 100 },
  ladderSharesPct: { column: "ladder_shares_pct", above: 0, max: 99 },
  ladderShockOverridePct: { column: "ladder_shock_override_pct", above: 0, max: 99 },
  ladderRungs: { column: "ladder_rungs", above: 0, max: 20, integer: true },
  ladderMinAbsDelta: { column: "ladder_min_abs_delta", above: 0, max: 1 },
  ladderMaxAbsDelta: { column: "ladder_max_abs_delta", above: 0, max: 1 },
};

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function rowToTickerSettings(row: Record<string, unknown>): PlutoTickerSettings {
  return {
    symbol: row.symbol as string,
    tickerId: row.ticker_id as string,
    strategy: (row.strategy as PlutoStrategy | null) ?? null,
    allocationPct: numberOrNull(row.allocation_pct),
    ladderSharesPct: numberOrNull(row.ladder_shares_pct),
    ladderShockOverridePct: numberOrNull(row.ladder_shock_override_pct),
    ladderRungs: numberOrNull(row.ladder_rungs),
    ladderMinAbsDelta: numberOrNull(row.ladder_min_abs_delta),
    ladderMaxAbsDelta: numberOrNull(row.ladder_max_abs_delta),
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
    updatedByUserId: (row.updated_by_user_id as string | null) ?? null,
  };
}

function tickerSettingsQuery(connection: Knex) {
  return connection("tickers as t")
    .leftJoin("pluto_ticker_settings as s", "s.ticker_id", "t.id")
    .select("t.symbol", "t.id as ticker_id", "s.strategy", "s.allocation_pct", "s.ladder_shares_pct", "s.ladder_shock_override_pct", "s.ladder_rungs", "s.ladder_min_abs_delta", "s.ladder_max_abs_delta", "s.updated_at", "s.updated_by_user_id");
}

/** The ticker's settings (every field null when none were set), or null when the symbol is not a known ticker. */
export async function loadPlutoTickerSettings(symbol: string, connection: Knex = db): Promise<PlutoTickerSettings | null> {
  const row = await tickerSettingsQuery(connection).where("t.symbol", symbol.toUpperCase()).first();
  return row ? rowToTickerSettings(row) : null;
}

/** Every ticker Pluto is enabled on (shortlisted, bot enabled), with its settings. */
export async function loadEnabledPlutoTickerSettings(connection: Knex = db): Promise<PlutoTickerSettings[]> {
  const rows = await tickerSettingsQuery(connection)
    .join("shortlist_entries as se", "se.ticker_id", "t.id")
    .whereNull("se.removed_at")
    .where("se.bot_enabled", true)
    .orderBy("t.symbol");
  return rows.map(rowToTickerSettings);
}

/** Each enabled ticker's allocation, % of Pluto's capital budget (the pool): the lab's rule (tickerAllocation.ts). */
export { effectiveAllocationPctBySymbol };

/**
 * A ticker's pot as a share of the account's value (Marcelo 2026-10-28): its allocation of Pluto's budget raised by the
 * excess allowance, so the pots may add up to more than the budget, whose cash they share (tickerPotShare).
 * Example: a $1,000,000 account, a 50% budget, 10 tickers on an equal share (10%) and a 20% allowance: each pot is
 * 10% × 1.2 × 50% = 6% of the account, $60,000; together $600,000 on the budget's $500,000.
 */
export function tickerPotFraction(allocationPct: number, settings: Pick<PlutoSettings, "capitalBudgetPct" | "excessAllowancePct">): number {
  return tickerPotShare(allocationPct, settings.excessAllowancePct, settings.capitalBudgetPct);
}

export class PlutoTickerSettingsValidationError extends Error {}
export class PlutoTickerNotFoundError extends Error {}

export function validatePlutoTickerSettingsInput(input: Record<string, unknown>): string | null {
  for (const [field, value] of Object.entries(input)) {
    if (field === "strategy") {
      if (value !== null && !(plutoStrategies as readonly unknown[]).includes(value)) return `strategy must be one of ${plutoStrategies.join(", ")}, or null for the default.`;
      continue;
    }
    const spec = plutoTickerSettingsColumns[field as PlutoTickerSettingsField];
    if (!spec) return `${field} is not a ticker setting.`;
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a number, or null for the default.`;
    if (value <= spec.above || value > spec.max) return `${field} must be above ${spec.above} and at most ${spec.max}.`;
    if (spec.integer && !Number.isInteger(value)) return `${field} must be a whole number.`;
  }
  return null;
}

const allocationLockKey = "pluto_ticker_settings_allocations";

/** Applies the given fields (null clears one back to the default), one audit row per field that changed. */
export async function updatePlutoTickerSettings(symbol: string, input: PlutoTickerSettingsInput, userId: string): Promise<PlutoTickerSettings> {
  const problem = validatePlutoTickerSettingsInput(input);
  if (problem) throw new PlutoTickerSettingsValidationError(problem);
  return db.transaction(async (trx) => {
    // Two saves at once must not both pass the 100% check.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [allocationLockKey]);
    const current = await loadPlutoTickerSettings(symbol, trx);
    if (!current) throw new PlutoTickerNotFoundError(`${symbol.toUpperCase()} is not a known ticker.`);
    if (input.allocationPct !== undefined && input.allocationPct !== null) {
      // Every set allocation counts, enabled or not, so enabling a ticker can never take the total past 100%.
      const others = await trx("pluto_ticker_settings").whereNot("ticker_id", current.tickerId).whereNotNull("allocation_pct").sum({ total: "allocation_pct" }).first();
      const othersTotal = Number(others?.total ?? 0);
      if (othersTotal + input.allocationPct > 100) throw new PlutoTickerSettingsValidationError(`The set allocations would add up to ${othersTotal + input.allocationPct}%: at most 100% (other tickers hold ${othersTotal}%).`);
    }
    if (input.ladderMinAbsDelta !== undefined || input.ladderMaxAbsDelta !== undefined) {
      // The ticker's range, each side its override or else the strategy's, must stay a range.
      const strategy = await trx("pluto_settings").where({ id: 1 }).first("ladder_min_abs_delta", "ladder_max_abs_delta");
      const minimum = (input.ladderMinAbsDelta !== undefined ? input.ladderMinAbsDelta : current.ladderMinAbsDelta) ?? Number(strategy.ladder_min_abs_delta);
      const maximum = (input.ladderMaxAbsDelta !== undefined ? input.ladderMaxAbsDelta : current.ladderMaxAbsDelta) ?? Number(strategy.ladder_max_abs_delta);
      if (minimum > maximum) throw new PlutoTickerSettingsValidationError(`The ticker's |delta| range would be ${minimum}–${maximum}: the lower limit cannot exceed the upper one.`);
    }
    const update: Record<string, number | string | null> = {};
    const audit: { ticker_id: string; user_id: string; field: string; old_value: string | null; new_value: string | null }[] = [];
    for (const [field, value] of Object.entries(input) as [PlutoTickerSettingsField | "strategy", number | string | null][]) {
      const before = current[field];
      if (before === value) continue;
      update[field === "strategy" ? "strategy" : plutoTickerSettingsColumns[field].column] = value;
      audit.push({ ticker_id: current.tickerId, user_id: userId, field, old_value: before === null ? null : String(before), new_value: value === null ? null : String(value) });
    }
    if (audit.length === 0) return current;
    // A ticker changing strategy is looked at afresh by the new one: v2 adopts its holdings, the ladder's cycle starts there.
    if (audit.some((row) => row.field === "strategy")) {
      await trx("pluto_vol_farmer_v2_cycles").where({ ticker_id: current.tickerId }).delete();
      await trx("pluto_ladder_cycles").where({ ticker_id: current.tickerId }).delete();
    }
    await trx("pluto_ticker_settings")
      .insert({ ticker_id: current.tickerId, ...update, updated_at: trx.fn.now(), updated_by_user_id: userId })
      .onConflict("ticker_id")
      .merge({ ...update, updated_at: trx.fn.now(), updated_by_user_id: userId });
    await trx("pluto_ticker_settings_audit").insert(audit);
    return (await loadPlutoTickerSettings(symbol, trx))!;
  });
}

/** What a save of the Tickers tab's allocations changed. */
export interface PlutoAllocationChanges {
  allocations: { symbol: string; from: number | null; to: number | null }[];
  excessAllowance: { from: number; to: number } | null;
}

/**
 * The Tickers tab's save (Marcelo 2026-10-28): the allocations given (null: back to an equal share; kept to the column's
 * two decimals) and the excess allowance, in one transaction, all or nothing. The set allocations, every ticker's
 * counted, add up to 100% at most; one audit row per change.
 */
export async function updatePlutoAllocations(input: { allocationPctBySymbol: Record<string, number | null>; excessAllowancePct?: number }, userId: string): Promise<PlutoAllocationChanges> {
  for (const [symbol, value] of Object.entries(input.allocationPctBySymbol)) {
    const problem = validatePlutoTickerSettingsInput({ allocationPct: value });
    if (problem) throw new PlutoTickerSettingsValidationError(`${symbol.toUpperCase()}: ${problem}`);
  }
  return db.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [allocationLockKey]);
    const named: { current: PlutoTickerSettings; to: number | null }[] = [];
    for (const [symbol, value] of Object.entries(input.allocationPctBySymbol)) {
      const current = await loadPlutoTickerSettings(symbol, trx);
      if (!current) throw new PlutoTickerNotFoundError(`${symbol.toUpperCase()} is not a known ticker.`);
      named.push({ current, to: value === null ? null : Math.round(value * 100) / 100 });
    }
    // Every set allocation counts, enabled or not, so enabling a ticker can never take the total past 100%.
    const others = await trx("pluto_ticker_settings").whereNotIn("ticker_id", named.map((entry) => entry.current.tickerId)).whereNotNull("allocation_pct").sum({ total: "allocation_pct" }).first();
    const total = Number(others?.total ?? 0) + named.reduce((sum, entry) => sum + (entry.to ?? 0), 0);
    if (total > 100 + 1e-9) throw new PlutoTickerSettingsValidationError(`The set allocations would add up to ${Number(total.toFixed(2))}%: at most 100%.`);
    const changes: PlutoAllocationChanges = { allocations: [], excessAllowance: null };
    for (const { current, to } of named) {
      if (current.allocationPct === to) continue;
      await trx("pluto_ticker_settings")
        .insert({ ticker_id: current.tickerId, allocation_pct: to, updated_at: trx.fn.now(), updated_by_user_id: userId })
        .onConflict("ticker_id")
        .merge({ allocation_pct: to, updated_at: trx.fn.now(), updated_by_user_id: userId });
      await trx("pluto_ticker_settings_audit").insert({ ticker_id: current.tickerId, user_id: userId, field: "allocationPct", old_value: current.allocationPct === null ? null : String(current.allocationPct), new_value: to === null ? null : String(to) });
      changes.allocations.push({ symbol: current.symbol, from: current.allocationPct, to });
    }
    if (input.excessAllowancePct !== undefined) {
      const before = Number((await trx("pluto_settings").where({ id: 1 }).first("excess_allowance_pct")).excess_allowance_pct);
      const after = await updatePlutoSettings({ excessAllowancePct: input.excessAllowancePct }, userId, trx);
      if (after.excessAllowancePct !== before) changes.excessAllowance = { from: before, to: after.excessAllowancePct };
    }
    return changes;
  });
}

export interface PlutoTickerSettingsAuditRow {
  id: number;
  changedAt: string;
  symbol: string;
  userDisplayName: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export async function loadPlutoTickerSettingsAudit(limit = 100, symbol?: string): Promise<PlutoTickerSettingsAuditRow[]> {
  const query = db("pluto_ticker_settings_audit as a")
    .join("tickers as t", "t.id", "a.ticker_id")
    .leftJoin("users as u", "u.id", "a.user_id")
    .select("a.*", "t.symbol", "u.display_name as user_display_name")
    .orderBy("a.changed_at", "desc")
    .orderBy("a.id", "desc")
    .limit(limit);
  if (symbol) query.where("t.symbol", symbol.toUpperCase());
  const rows = await query;
  return rows.map((row) => ({
    id: Number(row.id),
    changedAt: new Date(row.changed_at).toISOString(),
    symbol: row.symbol,
    userDisplayName: row.user_display_name ?? null,
    field: row.field,
    oldValue: row.old_value ?? null,
    newValue: row.new_value ?? null,
  }));
}
