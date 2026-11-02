import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { applyBacktestOverrides } from "./backtestSettingsOverrides.js";
import { editableBacktestSettingPaths, loadCurrentBacktestSettings, readBacktestSettingValue } from "./settingsTemplate.js";
import { validateBacktestSettingsOverrides } from "./jobs/backtestSessionRequest.js";
import {
  defaultBacktestBaselineSettings,
  defaultBacktestModelSettings,
  defaultBacktestPolicySettings,
  defaultBacktestSteadyStakeSettings,
  defaultBacktestVolFarmerSettings,
  defaultBacktestVolFarmerV2Settings,
  defaultBacktestVolFarmerV3Settings,
  defaultBacktestVolFarmerV4Settings,
  type BacktestLabAuditRow,
  type BacktestLabChange,
  type BacktestSettings,
} from "./backtestTypes.js";

// The backtesting lab's settings (Marcelo 2026-10-15): the values every new session and every ticker's analysis start
// from (the tickers' own lab values were the CC + Put Ladder's, retired 2026-11-02). Separate from Pluto's live settings: seeded once, on first read, as a
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

export class BacktestLabSettingsValidationError extends Error {}


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
    decisionMaker: stored.decisionMaker ?? "vol_farmer_v4",
    model: withCodeKeys(defaultBacktestModelSettings, stored.model),
    baseline: withCodeKeys(defaultBacktestBaselineSettings, stored.baseline),
    steadyStake: withCodeKeys(defaultBacktestSteadyStakeSettings, stored.steadyStake),
    volFarmer: withCodeKeys(defaultBacktestVolFarmerSettings, stored.volFarmer),
    volFarmerV2: withCodeKeys(defaultBacktestVolFarmerV2Settings, stored.volFarmerV2),
    volFarmerV3: withCodeKeys(defaultBacktestVolFarmerV3Settings, stored.volFarmerV3),
    volFarmerV4: withCodeKeys(defaultBacktestVolFarmerV4Settings, stored.volFarmerV4),
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
 * Saves changes to the global lab values: `overrides` in the New session's shape (trading, decisionMaker, baseline,
 * steadyStake, volFarmer, volFarmerV2, volFarmerV3, volFarmerV4), checked as a session's overrides are, and `defaultPotDollars`. One audit row per
 * value that changed; an empty list when nothing did.
 */
/** Saves the global lab values; `dryRun` validates and answers the changes and the values the save would leave, without writing (the save's confirmation). */
export async function updateBacktestLabSettings(input: { overrides?: unknown; defaultPotDollars?: unknown }, userId: string | null, connection: Knex = db, options: { dryRun?: boolean } = {}): Promise<{ lab: BacktestLabSettings; changes: BacktestLabChange[]; auditIds: number[] }> {
  return connection.transaction(async (trx) => {
    const current = await loadBacktestLabSettings(trx);
    const validation = validateBacktestSettingsOverrides(input.overrides, current.settings, editableBacktestSettingPaths);
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
    if (changes.length === 0) return { lab: current, changes, auditIds: [] };
    if (options.dryRun) return { lab: { ...current, settings: next, defaultPotDollars }, changes, auditIds: [] };
    await trx("backtest_lab_settings").where({ id: 1 }).update({ settings: JSON.stringify(next), default_pot_dollars: defaultPotDollars, updated_at: trx.fn.now(), updated_by_user_id: userId });
    const inserted: { id: number | string }[] = await trx("backtest_lab_settings_audit")
      .insert(changes.map((change) => ({ user_id: userId, symbol: null, field: change.field, old_value: change.oldValue, new_value: change.newValue })))
      .returning("id");
    return { lab: await loadBacktestLabSettings(trx), changes, auditIds: inserted.map((row) => Number(row.id)) };
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

/** The global values a ticker's analysis reads: it runs Vol Farmer v4 whatever the lab's decision maker (Marcelo 2026-11-01). */
const analysisReadPaths: ReadonlySet<string> = new Set(["lab.defaultPotDollars", "trading.spreadCostChargedPct", "pluto.windowStartEt", "pluto.windowEndEt"]);
export const analysisReadsLabPath = (path: string) => path.startsWith("volFarmerV4.") || analysisReadPaths.has(path);
