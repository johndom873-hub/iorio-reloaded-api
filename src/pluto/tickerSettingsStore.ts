import type { Knex } from "knex";
import { db } from "../db/connection.js";

// Pluto's per-ticker settings (Marcelo 2026-10-15): one row per ticker in pluto_ticker_settings, null meaning "the
// default", with a field-level audit trail (pluto_ticker_settings_audit). Read by the CC + Put Ladder through
// loadLadderSettingsForTicker (ladderSettings.ts).

export interface PlutoTickerSettings {
  symbol: string;
  tickerId: string;
  /** % of Pluto's capital budget for this ticker's pot; null = an equal share of what the set allocations leave. */
  allocationPct: number | null;
  /** Overrides the strategy's default share level (pluto_settings.ladder_shares_pct). */
  ladderSharesPct: number | null;
  /** Overrides the recommended shock (the Max drawdown rule). */
  ladderShockOverridePct: number | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export type PlutoTickerSettingsField = "allocationPct" | "ladderSharesPct" | "ladderShockOverridePct";
export type PlutoTickerSettingsInput = Partial<Record<PlutoTickerSettingsField, number | null>>;

/** Above `above` (exclusive) and at most `max`; bounds of the share level and shock are the backtest's. */
export const plutoTickerSettingsColumns: Record<PlutoTickerSettingsField, { column: string; above: number; max: number }> = {
  allocationPct: { column: "allocation_pct", above: 0, max: 100 },
  ladderSharesPct: { column: "ladder_shares_pct", above: 0, max: 99 },
  ladderShockOverridePct: { column: "ladder_shock_override_pct", above: 0, max: 99 },
};

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function rowToTickerSettings(row: Record<string, unknown>): PlutoTickerSettings {
  return {
    symbol: row.symbol as string,
    tickerId: row.ticker_id as string,
    allocationPct: numberOrNull(row.allocation_pct),
    ladderSharesPct: numberOrNull(row.ladder_shares_pct),
    ladderShockOverridePct: numberOrNull(row.ladder_shock_override_pct),
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
    updatedByUserId: (row.updated_by_user_id as string | null) ?? null,
  };
}

function tickerSettingsQuery(connection: Knex) {
  return connection("tickers as t")
    .leftJoin("pluto_ticker_settings as s", "s.ticker_id", "t.id")
    .select("t.symbol", "t.id as ticker_id", "s.allocation_pct", "s.ladder_shares_pct", "s.ladder_shock_override_pct", "s.updated_at", "s.updated_by_user_id");
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

/**
 * Each enabled ticker's allocation, % of Pluto's capital budget (formula approved by Marcelo 2026-10-15): a set
 * allocation as is; every ticker without one gets (100 − the set allocations) ÷ the number of tickers without one,
 * never below 0. Example: 4 enabled tickers, one set to 40% → the other three get 20% each.
 */
export function effectiveAllocationPctBySymbol(enabledTickers: readonly Pick<PlutoTickerSettings, "symbol" | "allocationPct">[]): Map<string, number> {
  const setTotal = enabledTickers.reduce((total, ticker) => total + (ticker.allocationPct ?? 0), 0);
  const unsetCount = enabledTickers.filter((ticker) => ticker.allocationPct === null).length;
  const equalShare = unsetCount === 0 ? 0 : Math.max(0, 100 - setTotal) / unsetCount;
  return new Map(enabledTickers.map((ticker) => [ticker.symbol, ticker.allocationPct ?? equalShare]));
}

export class PlutoTickerSettingsValidationError extends Error {}
export class PlutoTickerNotFoundError extends Error {}

export function validatePlutoTickerSettingsInput(input: Record<string, unknown>): string | null {
  for (const [field, value] of Object.entries(input)) {
    const spec = plutoTickerSettingsColumns[field as PlutoTickerSettingsField];
    if (!spec) return `${field} is not a ticker setting.`;
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a number, or null for the default.`;
    if (value <= spec.above || value > spec.max) return `${field} must be above ${spec.above} and at most ${spec.max}.`;
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
    const update: Record<string, number | null> = {};
    const audit: { ticker_id: string; user_id: string; field: string; old_value: string | null; new_value: string | null }[] = [];
    for (const [field, value] of Object.entries(input) as [PlutoTickerSettingsField, number | null][]) {
      const before = current[field];
      if (before === value) continue;
      update[plutoTickerSettingsColumns[field].column] = value;
      audit.push({ ticker_id: current.tickerId, user_id: userId, field, old_value: before === null ? null : String(before), new_value: value === null ? null : String(value) });
    }
    if (audit.length === 0) return current;
    await trx("pluto_ticker_settings")
      .insert({ ticker_id: current.tickerId, ...update, updated_at: trx.fn.now(), updated_by_user_id: userId })
      .onConflict("ticker_id")
      .merge({ ...update, updated_at: trx.fn.now(), updated_by_user_id: userId });
    await trx("pluto_ticker_settings_audit").insert(audit);
    return (await loadPlutoTickerSettings(symbol, trx))!;
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
