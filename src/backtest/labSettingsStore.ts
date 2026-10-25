import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { normalizeBacktestSymbol } from "./backtestDataDirectory.js";
import { applyBacktestOverrides } from "./backtestSettingsOverrides.js";
import { readBacktestClaudeCliPath } from "./backtestClaudeCli.js";
import { editableBacktestSettingPaths, loadCurrentBacktestSettings, readBacktestSettingValue } from "./settingsTemplate.js";
import { validateBacktestSettingsOverrides, validateBaselineSettings } from "./jobs/backtestSessionRequest.js";
import {
  defaultBacktestBaselineSettings,
  defaultBacktestModelSettings,
  defaultBacktestPolicySettings,
  defaultBacktestSteadyStakeSettings,
  defaultBacktestVolFarmerSettings,
  type BacktestLabAuditRow,
  type BacktestLabChange,
  type BacktestLabTickerOverrides,
  type BacktestSettings,
  type BacktestTickerBaselineSettings,
  type BacktestTickerValues,
} from "./backtestTypes.js";

// The backtesting lab's settings (Marcelo 2026-10-15): the global values every new session and every ticker's analysis
// start from, and each ticker's own lab values. Separate from Pluto's live settings: seeded once, on first read, as a
// copy of the New session snapshot of that moment (Pluto's and the trading settings plus the code defaults), and never
// synced with them afterwards.

/** The pot each ticker starts with when it has none of its own (the backtests' $200,000). */
export const labSeedDefaultPotDollars = 200_000;
const maximumPotDollars = 1e12;

export interface BacktestLabSettings {
  settings: BacktestSettings;
  defaultPotDollars: number;
  updatedAt: string;
  updatedByUserId: string | null;
}

export type BacktestLabTickerField = Exclude<keyof BacktestLabTickerOverrides, "symbol" | "updatedAt">;

const tickerColumns: Record<BacktestLabTickerField, string> = {
  potDollars: "pot_dollars",
  ladderSharesPct: "ladder_shares_pct",
  ladderRungs: "ladder_rungs",
  ladderShockPct: "ladder_shock_pct",
  minAbsDelta: "min_abs_delta",
  maxAbsDelta: "max_abs_delta",
};
const tickerFields = Object.keys(tickerColumns) as BacktestLabTickerField[];

export class BacktestLabSettingsValidationError extends Error {}

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** The section with the code's keys only: a stored value where there is one, else `base`'s; a key the code no longer has is dropped. */
/** A stored section in the code's current shape: the code's keys, each from the stored copy when it has it, else `base`. */
export function withCodeKeys<Section extends object>(base: Section, stored: Partial<Section> | undefined): Section {
  return Object.fromEntries(Object.keys(base).map((key) => [key, stored !== undefined && key in stored ? (stored as Record<string, unknown>)[key] : (base as Record<string, unknown>)[key]])) as Section;
}

/**
 * The stored settings in the code's current shape: the policy, model and baseline defaults fill values added to the code
 * after the row was saved, a Pluto or trading field added since (one the stored copy lacks) takes the live value of the
 * moment, so a new setting has a value without the lab ever following live changes to existing ones; a setting the code
 * has since removed is dropped.
 */
async function completeSettings(stored: BacktestSettings, connection: Knex): Promise<BacktestSettings> {
  const live = await loadCurrentBacktestSettings(connection);
  return {
    pluto: withCodeKeys(live.pluto, stored.pluto),
    trading: withCodeKeys(live.trading, stored.trading),
    kellyFraction: stored.kellyFraction ?? live.kellyFraction,
    policy: withCodeKeys(defaultBacktestPolicySettings, stored.policy),
    decisionMaker: stored.decisionMaker ?? "rules",
    model: withCodeKeys(defaultBacktestModelSettings, stored.model),
    baseline: withCodeKeys(defaultBacktestBaselineSettings, stored.baseline),
    steadyStake: withCodeKeys(defaultBacktestSteadyStakeSettings, stored.steadyStake),
    volFarmer: withCodeKeys(defaultBacktestVolFarmerSettings, stored.volFarmer),
  };
}

/** The lab's global settings; the first read seeds them from the New session snapshot of that moment. */
export async function loadBacktestLabSettings(connection: Knex = db): Promise<BacktestLabSettings> {
  let row = await connection("backtest_lab_settings").where({ id: 1 }).first();
  if (!row) {
    const seed = await loadCurrentBacktestSettings(connection);
    await connection("backtest_lab_settings").insert({ id: 1, settings: JSON.stringify(seed), default_pot_dollars: labSeedDefaultPotDollars }).onConflict("id").ignore();
    row = await connection("backtest_lab_settings").where({ id: 1 }).first();
  }
  return {
    settings: await completeSettings(row.settings as BacktestSettings, connection),
    defaultPotDollars: Number(row.default_pot_dollars),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

/**
 * Saves changes to the global lab values: `overrides` in the New session's shape (pluto, trading, kellyFraction,
 * policy, decisionMaker, baseline), checked as a session's overrides are, and `defaultPotDollars`. One audit row per
 * value that changed; an empty list when nothing did.
 */
/** Saves the global lab values; `dryRun` validates and answers the changes without writing (the save's confirmation). */
export async function updateBacktestLabSettings(input: { overrides?: unknown; defaultPotDollars?: unknown }, userId: string | null, connection: Knex = db, options: { dryRun?: boolean } = {}): Promise<{ lab: BacktestLabSettings; changes: BacktestLabChange[]; auditIds: number[] }> {
  return connection.transaction(async (trx) => {
    const current = await loadBacktestLabSettings(trx);
    const validation = validateBacktestSettingsOverrides(input.overrides, current.settings, editableBacktestSettingPaths, { claudeCliAvailable: readBacktestClaudeCliPath() !== null });
    if (!validation.ok) throw new BacktestLabSettingsValidationError(validation.error);
    let defaultPotDollars = current.defaultPotDollars;
    if (input.defaultPotDollars !== undefined) {
      const pot = input.defaultPotDollars;
      if (typeof pot !== "number" || !Number.isFinite(pot) || pot <= 0 || pot > maximumPotDollars) throw new BacktestLabSettingsValidationError("defaultPotDollars must be a number above 0.");
      defaultPotDollars = pot;
    }
    const next = applyBacktestOverrides(current.settings, validation.overrides) as BacktestSettings;
    const changes: BacktestLabChange[] = [];
    for (const path of editableBacktestSettingPaths) {
      const before = readBacktestSettingValue(current.settings, path);
      const after = readBacktestSettingValue(next, path);
      if (String(before) !== String(after)) changes.push({ field: path, oldValue: String(before), newValue: String(after) });
    }
    if (defaultPotDollars !== current.defaultPotDollars) changes.push({ field: "lab.defaultPotDollars", oldValue: String(current.defaultPotDollars), newValue: String(defaultPotDollars) });
    if (changes.length === 0 || options.dryRun) return { lab: current, changes, auditIds: [] };
    await trx("backtest_lab_settings").where({ id: 1 }).update({ settings: JSON.stringify(next), default_pot_dollars: defaultPotDollars, updated_at: trx.fn.now(), updated_by_user_id: userId });
    const inserted: { id: number | string }[] = await trx("backtest_lab_settings_audit")
      .insert(changes.map((change) => ({ user_id: userId, symbol: null, field: change.field, old_value: change.oldValue, new_value: change.newValue })))
      .returning("id");
    return { lab: await loadBacktestLabSettings(trx), changes, auditIds: inserted.map((row) => Number(row.id)) };
  });
}

function rowToTickerOverrides(row: Record<string, unknown>): BacktestLabTickerOverrides {
  return {
    symbol: row.symbol as string,
    potDollars: numberOrNull(row.pot_dollars),
    ladderSharesPct: numberOrNull(row.ladder_shares_pct),
    ladderRungs: numberOrNull(row.ladder_rungs),
    ladderShockPct: numberOrNull(row.ladder_shock_pct),
    minAbsDelta: numberOrNull(row.min_abs_delta),
    maxAbsDelta: numberOrNull(row.max_abs_delta),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

/** Every ticker with lab values of its own, by symbol. */
export async function loadBacktestLabTickerOverrides(connection: Knex = db): Promise<BacktestLabTickerOverrides[]> {
  const rows = await connection("backtest_lab_ticker_overrides").orderBy("symbol");
  return rows.map(rowToTickerOverrides);
}

/** A ticker's lab values in a session request's terms: a fixed shock becomes ladderShock "fixed" with its percent. */
export function tickerOverridesToValues(overrides: BacktestLabTickerOverrides): BacktestTickerValues {
  const baseline: Partial<BacktestTickerBaselineSettings> = {};
  if (overrides.ladderSharesPct !== null) baseline.ladderSharesPct = overrides.ladderSharesPct;
  if (overrides.ladderRungs !== null) baseline.ladderRungs = overrides.ladderRungs;
  if (overrides.ladderShockPct !== null) Object.assign(baseline, { ladderShock: "fixed", ladderShockPct: overrides.ladderShockPct });
  if (overrides.minAbsDelta !== null) baseline.minAbsDelta = overrides.minAbsDelta;
  if (overrides.maxAbsDelta !== null) baseline.maxAbsDelta = overrides.maxAbsDelta;
  return { ...(overrides.potDollars !== null ? { potDollars: overrides.potDollars } : {}), ...(Object.keys(baseline).length > 0 ? { baseline } : {}) };
}

/** The lab values of the given tickers that have any, keyed by symbol (the session request's tickerValuesFor). */
export async function loadBacktestTickerOverrides(symbols: readonly string[], connection: Knex = db): Promise<Record<string, BacktestTickerValues>> {
  if (symbols.length === 0) return {};
  const rows = await connection("backtest_lab_ticker_overrides").whereIn("symbol", symbols);
  return Object.fromEntries(rows.map((row) => [row.symbol as string, tickerOverridesToValues(rowToTickerOverrides(row))]));
}

const ranges: Record<BacktestLabTickerField, { min: number; max: number; minExclusive?: boolean; integer?: boolean; label: string }> = {
  potDollars: { min: 0, max: maximumPotDollars, minExclusive: true, label: "potDollars must be a number above 0" },
  ladderSharesPct: { min: 1, max: 99, label: "ladderSharesPct must be a number from 1 to 99" },
  ladderRungs: { min: 1, max: 20, integer: true, label: "ladderRungs must be a whole number from 1 to 20" },
  ladderShockPct: { min: 1, max: 99, label: "ladderShockPct must be a number from 1 to 99" },
  minAbsDelta: { min: 0, max: 1, minExclusive: true, label: "minAbsDelta must be a number above 0 and at most 1" },
  maxAbsDelta: { min: 0, max: 1, minExclusive: true, label: "maxAbsDelta must be a number above 0 and at most 1" },
};

/**
 * Saves a ticker's lab values: each given field a number, or null to use the global value again; fields left out keep
 * theirs. The merged values are checked against the global ones (a |delta| range must stay a range). A ticker left with
 * no values of its own has no row. One audit row per changed field.
 */
export async function saveBacktestLabTickerOverrides(givenSymbol: string, input: Record<string, unknown>, userId: string | null, connection: Knex = db): Promise<{ overrides: BacktestLabTickerOverrides | null; changes: BacktestLabChange[] }> {
  let symbol: string;
  try {
    symbol = normalizeBacktestSymbol(givenSymbol);
  } catch (error) {
    throw new BacktestLabSettingsValidationError(error instanceof Error ? error.message : String(error));
  }
  const unknownField = Object.keys(input).find((field) => !(tickerFields as string[]).includes(field));
  if (unknownField) throw new BacktestLabSettingsValidationError(`${unknownField} is not a ticker lab value (${tickerFields.join(", ")}).`);
  for (const [field, value] of Object.entries(input)) {
    if (value === null) continue;
    const range = ranges[field as BacktestLabTickerField];
    const ok = typeof value === "number" && Number.isFinite(value) && (range.minExclusive ? value > range.min : value >= range.min) && value <= range.max && (!range.integer || Number.isInteger(value));
    if (!ok) throw new BacktestLabSettingsValidationError(`${range.label}, or null for the global value.`);
  }
  return connection.transaction(async (trx) => {
    const lab = await loadBacktestLabSettings(trx);
    const existingRow = await trx("backtest_lab_ticker_overrides").where({ symbol }).first();
    const before: Record<BacktestLabTickerField, number | null> = existingRow ? rowToTickerOverrides(existingRow) : { potDollars: null, ladderSharesPct: null, ladderRungs: null, ladderShockPct: null, minAbsDelta: null, maxAbsDelta: null };
    const after = { ...before };
    for (const field of tickerFields) if (input[field] !== undefined) after[field] = input[field] as number | null;
    const effective = { ...lab.settings.baseline!, ...tickerOverridesToValues({ symbol, ...after, updatedAt: "" }).baseline };
    const problem = validateBaselineSettings(effective as unknown as Record<string, unknown>);
    if (problem) throw new BacktestLabSettingsValidationError(`${symbol}: ${problem}`);
    const changes: BacktestLabChange[] = tickerFields
      .filter((field) => before[field] !== after[field])
      .map((field) => ({ field, oldValue: before[field] === null ? "global" : String(before[field]), newValue: after[field] === null ? "global" : String(after[field]) }));
    if (changes.length === 0) return { overrides: existingRow ? rowToTickerOverrides(existingRow) : null, changes };
    if (tickerFields.every((field) => after[field] === null)) await trx("backtest_lab_ticker_overrides").where({ symbol }).delete();
    else {
      const columns = Object.fromEntries(tickerFields.map((field) => [tickerColumns[field], after[field]]));
      await trx("backtest_lab_ticker_overrides")
        .insert({ symbol, ...columns, updated_at: trx.fn.now(), updated_by_user_id: userId })
        .onConflict("symbol")
        .merge({ ...columns, updated_at: trx.fn.now(), updated_by_user_id: userId });
    }
    await trx("backtest_lab_settings_audit").insert(changes.map((change) => ({ user_id: userId, symbol, field: change.field, old_value: change.oldValue, new_value: change.newValue })));
    const saved = await trx("backtest_lab_ticker_overrides").where({ symbol }).first();
    return { overrides: saved ? rowToTickerOverrides(saved) : null, changes };
  });
}

/** The lab's change history, newest first: every global value, or one ticker's own values. */
export async function loadBacktestLabAudit(options: { symbol?: string | null; limit?: number } = {}, connection: Knex = db): Promise<BacktestLabAuditRow[]> {
  const query = connection("backtest_lab_settings_audit as a").leftJoin("users as u", "u.id", "a.user_id").select("a.*", "u.display_name as user_display_name").orderBy("a.changed_at", "desc").orderBy("a.id", "desc").limit(options.limit ?? 100);
  if (options.symbol !== undefined) {
    if (options.symbol === null) query.whereNull("a.symbol");
    else query.where("a.symbol", options.symbol);
  }
  const rows = await query;
  return rows.map((row) => ({
    id: Number(row.id),
    changedAt: new Date(row.changed_at).toISOString(),
    userDisplayName: row.user_display_name ?? null,
    symbol: row.symbol ?? null,
    field: row.field,
    oldValue: row.old_value ?? null,
    newValue: row.new_value ?? null,
    analysesRerun: row.analyses_rerun ?? null,
  }));
}

/** Records how many stored analyses a global save re-ran, on the audit rows it wrote. */
export async function noteLabAuditAnalysesRerun(auditIds: readonly number[], count: number, connection: Knex = db): Promise<void> {
  if (auditIds.length > 0) await connection("backtest_lab_settings_audit").whereIn("id", auditIds).update({ analyses_rerun: count });
}

/**
 * The global values each ticker field stands in for: a ticker with its own value is not affected by a change to these.
 * A fixed shock replaces the whole shock rule.
 */
const globalPathsByTickerField: Record<BacktestLabTickerField, readonly string[]> = {
  potDollars: ["lab.defaultPotDollars"],
  ladderSharesPct: ["baseline.ladderSharesPct"],
  ladderRungs: ["baseline.ladderRungs"],
  ladderShockPct: ["baseline.ladderShock", "baseline.ladderShockPct", "baseline.ladderShockMinPct", "baseline.ladderShockMaxPct", "baseline.ladderShockNoHistoryPct", "baseline.ladderShockLookbackYears"],
  minAbsDelta: ["baseline.minAbsDelta"],
  maxAbsDelta: ["baseline.maxAbsDelta"],
};

/** Whether a ticker's own values replace this global value (it keeps its override when the value changes). */
export function tickerOverridesGlobalPath(path: string, overrides: Pick<BacktestLabTickerOverrides, BacktestLabTickerField> | null): boolean {
  return overrides !== null && tickerFields.some((field) => overrides[field] !== null && globalPathsByTickerField[field].includes(path));
}

/** The global values a ticker's analysis reads: it runs the Baseline wheel whatever the lab's decision maker. */
const analysisReadPaths: ReadonlySet<string> = new Set(["lab.defaultPotDollars", "trading.spreadCostChargedPct", "pluto.windowStartEt", "pluto.windowEndEt"]);
export const analysisReadsLabPath = (path: string) => path.startsWith("baseline.") || path.startsWith("model.") || analysisReadPaths.has(path);

/** Whether a change to these global values reaches a ticker's analysis: some changed value it reads and its own values don't replace. */
export function globalChangeReachesTicker(changedFields: readonly string[], overrides: Pick<BacktestLabTickerOverrides, BacktestLabTickerField> | null): boolean {
  const covered = new Set(overrides ? tickerFields.filter((field) => overrides[field] !== null).flatMap((field) => globalPathsByTickerField[field]) : []);
  return changedFields.some((field) => analysisReadsLabPath(field) && !covered.has(field));
}
