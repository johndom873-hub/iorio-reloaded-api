import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { effectiveAllocationPctBySymbol, tickerPotShare } from "../lib/tickerAllocation.js";
import { volFarmerV3AlwaysHoldTheStockChoices, type VolFarmerV3AlwaysHoldTheStock } from "../backtest/backtestTypes.js";
import { updatePlutoSettings, type PlutoSettings } from "./settingsStore.js";

// Pluto's per-ticker settings (Marcelo 2026-10-15): one row per ticker in pluto_ticker_settings, null meaning "the
// default", with a field-level audit trail (pluto_ticker_settings_audit). Pluto runs Vol Farmer v4 on every ticker
// (Marcelo 2026-10-31); a ticker's own settings are its allocation and its Always hold the stock (Marcelo 2026-11-03; the
// CC + Put Ladder's strategy choice and per-ticker values retired 2026-11-02).

export interface PlutoTickerSettings {
  symbol: string;
  tickerId: string;
  /** % of Pluto's capital budget for this ticker's pot; null = an equal share of what the set allocations leave. */
  allocationPct: number | null;
  /** The ticker's own Always hold the stock; null = Pluto's (volFarmerV4AlwaysHoldTheStock). */
  alwaysHoldTheStock: VolFarmerV3AlwaysHoldTheStock | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export type PlutoTickerSettingsField = "allocationPct" | "alwaysHoldTheStock";
export type PlutoTickerSettingsInput = { allocationPct?: number | null; alwaysHoldTheStock?: VolFarmerV3AlwaysHoldTheStock | null };

/** A number above `above` (exclusive) and at most `max`, or one of `oneOf`. */
export const plutoTickerSettingsColumns: Record<PlutoTickerSettingsField, { column: string } & ({ kind: "number"; above: number; max: number } | { kind: "text"; oneOf: readonly string[] })> = {
  allocationPct: { column: "allocation_pct", kind: "number", above: 0, max: 100 },
  alwaysHoldTheStock: { column: "always_hold_the_stock", kind: "text", oneOf: volFarmerV3AlwaysHoldTheStockChoices },
};

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function rowToTickerSettings(row: Record<string, unknown>): PlutoTickerSettings {
  return {
    symbol: row.symbol as string,
    tickerId: row.ticker_id as string,
    allocationPct: numberOrNull(row.allocation_pct),
    alwaysHoldTheStock: (row.always_hold_the_stock as VolFarmerV3AlwaysHoldTheStock | null) ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
    updatedByUserId: (row.updated_by_user_id as string | null) ?? null,
  };
}

function tickerSettingsQuery(connection: Knex) {
  return connection("tickers as t")
    .leftJoin("pluto_ticker_settings as s", "s.ticker_id", "t.id")
    .select("t.symbol", "t.id as ticker_id", "s.allocation_pct", "s.always_hold_the_stock", "s.updated_at", "s.updated_by_user_id");
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

/** Every shortlisted ticker with its settings, and whether Pluto is enabled on it (the after-close volume capture covers them all). */
export async function loadShortlistedPlutoTickerSettings(connection: Knex = db): Promise<(PlutoTickerSettings & { enabled: boolean })[]> {
  const rows = await tickerSettingsQuery(connection)
    .join("shortlist_entries as se", "se.ticker_id", "t.id")
    .whereNull("se.removed_at")
    .select("se.bot_enabled")
    .orderBy("t.symbol");
  return rows.map((row) => ({ ...rowToTickerSettings(row), enabled: row.bot_enabled === true }));
}

/** Each enabled ticker's allocation, % of Pluto's capital budget (the pool): the lab's rule (tickerAllocation.ts). */
export { effectiveAllocationPctBySymbol };

/**
 * A ticker's pot as a share of Pluto's book value (Marcelo 2026-10-28; of the book's value since the books, 2026-11-05):
 * its allocation raised by the excess allowance, so the pots may add up to more than the book, whose cash they share
 * (tickerPotShare). Example: Pluto worth $600,000, 10 tickers on an equal share (10%) and a 20% allowance: each pot is
 * 10% × 1.2 = 12% of the book, $72,000; together $720,000 on the book's $600,000.
 */
export function tickerPotFraction(allocationPct: number, settings: Pick<PlutoSettings, "excessAllowancePct">): number {
  return tickerPotShare(allocationPct, settings.excessAllowancePct, 100);
}

export class PlutoTickerSettingsValidationError extends Error {}
export class PlutoTickerNotFoundError extends Error {}

export function validatePlutoTickerSettingsInput(input: Record<string, unknown>): string | null {
  for (const [field, value] of Object.entries(input)) {
    const spec = plutoTickerSettingsColumns[field as PlutoTickerSettingsField];
    if (!spec) return `${field} is not a ticker setting.`;
    if (value === null) continue;
    if (spec.kind === "text") {
      if (!spec.oneOf.includes(value as string)) return `${field} must be one of ${spec.oneOf.join(", ")}, or null for Pluto's setting.`;
      continue;
    }
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
    const update: Record<string, number | string | null> = {};
    const audit: { ticker_id: string; user_id: string; field: string; old_value: string | null; new_value: string | null }[] = [];
    for (const [field, value] of Object.entries(input) as [PlutoTickerSettingsField, number | string | null][]) {
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

/** What a save of the Tickers tab's allocations changed. */
export interface PlutoAllocationChanges {
  allocations: { symbol: string; from: number | null; to: number | null }[];
  alwaysHoldTheStock: { symbol: string; from: VolFarmerV3AlwaysHoldTheStock | null; to: VolFarmerV3AlwaysHoldTheStock | null }[];
  excessAllowance: { from: number; to: number } | null;
}

/**
 * The Tickers tab's save (Marcelo 2026-10-28): the allocations given (null: back to an equal share; kept to the column's
 * two decimals), each ticker's Always hold the stock given (Marcelo 2026-11-03; null: back to Pluto's) and the excess
 * allowance, in one transaction, all or nothing. The set allocations, every ticker's counted, add up to 100% at most; one
 * audit row per change.
 */
export async function updatePlutoAllocations(input: { allocationPctBySymbol: Record<string, number | null>; alwaysHoldTheStockBySymbol?: Record<string, VolFarmerV3AlwaysHoldTheStock | null>; excessAllowancePct?: number }, userId: string): Promise<PlutoAllocationChanges> {
  for (const [symbol, value] of Object.entries(input.allocationPctBySymbol)) {
    const problem = validatePlutoTickerSettingsInput({ allocationPct: value });
    if (problem) throw new PlutoTickerSettingsValidationError(`${symbol.toUpperCase()}: ${problem}`);
  }
  for (const [symbol, value] of Object.entries(input.alwaysHoldTheStockBySymbol ?? {})) {
    const problem = validatePlutoTickerSettingsInput({ alwaysHoldTheStock: value });
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
    const changes: PlutoAllocationChanges = { allocations: [], alwaysHoldTheStock: [], excessAllowance: null };
    for (const { current, to } of named) {
      if (current.allocationPct === to) continue;
      await trx("pluto_ticker_settings")
        .insert({ ticker_id: current.tickerId, allocation_pct: to, updated_at: trx.fn.now(), updated_by_user_id: userId })
        .onConflict("ticker_id")
        .merge({ allocation_pct: to, updated_at: trx.fn.now(), updated_by_user_id: userId });
      await trx("pluto_ticker_settings_audit").insert({ ticker_id: current.tickerId, user_id: userId, field: "allocationPct", old_value: current.allocationPct === null ? null : String(current.allocationPct), new_value: to === null ? null : String(to) });
      changes.allocations.push({ symbol: current.symbol, from: current.allocationPct, to });
    }
    for (const [symbol, to] of Object.entries(input.alwaysHoldTheStockBySymbol ?? {})) {
      const current = await loadPlutoTickerSettings(symbol, trx);
      if (!current) throw new PlutoTickerNotFoundError(`${symbol.toUpperCase()} is not a known ticker.`);
      if (current.alwaysHoldTheStock === to) continue;
      await trx("pluto_ticker_settings")
        .insert({ ticker_id: current.tickerId, always_hold_the_stock: to, updated_at: trx.fn.now(), updated_by_user_id: userId })
        .onConflict("ticker_id")
        .merge({ always_hold_the_stock: to, updated_at: trx.fn.now(), updated_by_user_id: userId });
      await trx("pluto_ticker_settings_audit").insert({ ticker_id: current.tickerId, user_id: userId, field: "alwaysHoldTheStock", old_value: current.alwaysHoldTheStock, new_value: to });
      changes.alwaysHoldTheStock.push({ symbol: current.symbol, from: current.alwaysHoldTheStock, to });
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
