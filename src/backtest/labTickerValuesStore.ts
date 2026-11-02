import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { normalizeBacktestSymbol } from "./backtestDataDirectory.js";
import { BacktestLabSettingsValidationError, loadBacktestLabSettings } from "./labSettingsStore.js";
import { validateVolFarmerV4Settings } from "./jobs/backtestSessionRequest.js";
import { defaultBacktestVolFarmerV4Settings, type BacktestVolFarmerV4Settings } from "./backtestTypes.js";

// A ticker's own Vol Farmer v4 lab values (backtest_lab_ticker_values, Marcelo 2026-11-02): five of v4's values a ticker
// can hold apart from the lab's. Its analysis reads them, and New session prefills them for a session of that ticker
// alone; a session of several tickers runs the lab's, and Pluto never reads them. Null is the lab's value; a ticker left
// with no value of its own has no row. Every change is written to backtest_lab_settings_audit under the ticker's symbol.

export const tickerOwnValueFields = ["callMinAbsDelta", "callMaxAbsDelta", "firstPositionPct", "putMaxAbsDelta", "leapsMaxAccountPct"] as const;
export type TickerOwnValueField = (typeof tickerOwnValueFields)[number];

/** The five values a ticker can hold, each a number, or null for the lab's. */
export type TickerOwnValues = Record<TickerOwnValueField, number | null>;
/** The five values as a ticker runs them (its own, else the lab's). */
export type TickerFieldValues = Record<TickerOwnValueField, number>;

export interface StoredTickerOwnValues {
  symbol: string;
  values: TickerOwnValues;
  updatedAt: string;
  updatedByUserId: string | null;
}

/** One value a save changed: null is the lab's value. */
export interface TickerOwnValueChange {
  field: `volFarmerV4.${TickerOwnValueField}`;
  oldValue: number | null;
  newValue: number | null;
}

const columnOfField: Record<TickerOwnValueField, string> = {
  callMinAbsDelta: "call_min_abs_delta",
  callMaxAbsDelta: "call_max_abs_delta",
  firstPositionPct: "first_position_pct",
  putMaxAbsDelta: "put_max_abs_delta",
  leapsMaxAccountPct: "leaps_max_account_pct",
};

/** Each value's range, as the lab checks it (validateVolFarmerV2Settings, validateVolFarmerV4Settings). */
const rangeOfField: Record<TickerOwnValueField, { min: number; max: number }> = {
  callMinAbsDelta: { min: 0.01, max: 0.99 },
  callMaxAbsDelta: { min: 0.01, max: 0.99 },
  firstPositionPct: { min: 10, max: 90 },
  putMaxAbsDelta: { min: 0.01, max: 0.99 },
  leapsMaxAccountPct: { min: 0, max: 100 },
};

export const noTickerOwnValues: TickerOwnValues = { callMinAbsDelta: null, callMaxAbsDelta: null, firstPositionPct: null, putMaxAbsDelta: null, leapsMaxAccountPct: null };

/** The five values of a v4 section. */
export function tickerFieldValuesOf(volFarmerV4: BacktestVolFarmerV4Settings): TickerFieldValues {
  return Object.fromEntries(tickerOwnValueFields.map((field) => [field, volFarmerV4[field]])) as TickerFieldValues;
}

/** A v4 section with the given values on top: each one that is a number replaces the section's; null or absent keeps it. */
export function withTickerOwnValues<Section extends BacktestVolFarmerV4Settings>(volFarmerV4: Section, values: Partial<TickerOwnValues> | null | undefined): Section {
  if (!values) return volFarmerV4;
  const replaced = Object.fromEntries(tickerOwnValueFields.flatMap((field) => (typeof values[field] === "number" ? [[field, values[field]]] : [])));
  return { ...volFarmerV4, ...replaced };
}

/** The values that differ from the lab's v4 section: the overrides a session of the ticker alone runs; {} when none. */
export function tickerValuesDifferingFromLab(volFarmerV4: BacktestVolFarmerV4Settings, lab: BacktestVolFarmerV4Settings): Partial<TickerFieldValues> {
  return Object.fromEntries(tickerOwnValueFields.flatMap((field) => (volFarmerV4[field] !== lab[field] ? [[field, volFarmerV4[field]]] : [])));
}

/** Why one of the five is not a value: null when it is a number in its range. */
export function tickerOwnValueProblem(field: TickerOwnValueField, value: unknown): string | null {
  const { min, max } = rangeOfField[field];
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? null : `volFarmerV4.${field} must be a number from ${min} to ${max}`;
}

/**
 * The given values checked one by one: an object of some of the five, each a number in its range (or, with `allowNull`,
 * null for the lab's value). Throws BacktestLabSettingsValidationError.
 */
export function validateTickerOwnValuesInput(raw: unknown, options: { allowNull: boolean; what: string }): Partial<TickerOwnValues> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BacktestLabSettingsValidationError(`${options.what} must be an object of ${tickerOwnValueFields.join(", ")}.`);
  const unknownField = Object.keys(raw).find((field) => !(tickerOwnValueFields as readonly string[]).includes(field));
  if (unknownField) throw new BacktestLabSettingsValidationError(`${options.what}.${unknownField} is not a value a ticker can have of its own (${tickerOwnValueFields.join(", ")}).`);
  const values: Partial<TickerOwnValues> = {};
  for (const [field, value] of Object.entries(raw) as [TickerOwnValueField, unknown][]) {
    if (value === undefined) continue;
    if (value === null && options.allowNull) {
      values[field] = null;
      continue;
    }
    const problem = tickerOwnValueProblem(field, value);
    if (problem) throw new BacktestLabSettingsValidationError(`${problem}${options.allowNull ? ", or null for the lab's value" : ""}.`);
    values[field] = value as number;
  }
  return values;
}

/** Why the merged v4 section is not one the lab could run (the Calls' |delta| from above its to): null when it is. */
export function mergedVolFarmerV4Problem(volFarmerV4: BacktestVolFarmerV4Settings): string | null {
  return validateVolFarmerV4Settings(volFarmerV4 as unknown as Record<string, unknown>);
}

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function rowToStoredValues(row: Record<string, unknown>): StoredTickerOwnValues {
  return {
    symbol: row.symbol as string,
    values: Object.fromEntries(tickerOwnValueFields.map((field) => [field, numberOrNull(row[columnOfField[field]])])) as TickerOwnValues,
    updatedAt: new Date(row.updated_at as string).toISOString(),
    updatedByUserId: (row.updated_by_user_id as string | null) ?? null,
  };
}

/** A ticker's own values; null when it has none. */
export async function loadTickerOwnValues(symbol: string, connection: Knex = db): Promise<StoredTickerOwnValues | null> {
  const row = await connection("backtest_lab_ticker_values").where({ symbol }).first();
  return row ? rowToStoredValues(row) : null;
}

/** Every ticker with values of its own, by symbol. */
export async function loadAllTickerOwnValues(connection: Knex = db): Promise<Record<string, StoredTickerOwnValues>> {
  const rows: Record<string, unknown>[] = await connection("backtest_lab_ticker_values").orderBy("symbol");
  return Object.fromEntries(rows.map((row) => [row.symbol as string, rowToStoredValues(row)]));
}

/** The lab's v4 section with every key (loadBacktestLabSettings completes it; the defaults stand in when it has none). */
const withCodeKeysOfVolFarmerV4 = (stored: Partial<BacktestVolFarmerV4Settings> | undefined): BacktestVolFarmerV4Settings => ({ ...defaultBacktestVolFarmerV4Settings, ...stored });

/** What the screens read: every ticker's own values, and the lab's five now (what a null reads). */
export async function loadTickerOwnValuesOverview(connection: Knex = db): Promise<{ labValues: TickerFieldValues; bySymbol: Record<string, StoredTickerOwnValues> }> {
  const [lab, bySymbol] = await Promise.all([loadBacktestLabSettings(connection), loadAllTickerOwnValues(connection)]);
  return { labValues: tickerFieldValuesOf(withCodeKeysOfVolFarmerV4(lab.settings.volFarmerV4)), bySymbol };
}

/**
 * Saves a ticker's own values: each given field a number, or null for the lab's; fields left out keep theirs. A value
 * equal to the lab's now is stored as null, the merged values must be ones the lab could run (the Calls' |delta| from at
 * most its to), and a ticker left with none has no row. One audit row per changed value.
 */
export async function saveTickerOwnValues(givenSymbol: string, input: unknown, userId: string | null, connection: Knex = db): Promise<{ saved: StoredTickerOwnValues | null; changes: TickerOwnValueChange[] }> {
  let symbol: string;
  try {
    symbol = normalizeBacktestSymbol(givenSymbol);
  } catch (error) {
    throw new BacktestLabSettingsValidationError(error instanceof Error ? error.message : String(error));
  }
  const given = validateTickerOwnValuesInput(input, { allowNull: true, what: "values" });
  return connection.transaction(async (transaction) => {
    const lab = await loadBacktestLabSettings(transaction);
    const labVolFarmerV4 = withCodeKeysOfVolFarmerV4(lab.settings.volFarmerV4);
    const existing = await transaction("backtest_lab_ticker_values").where({ symbol }).forUpdate().first();
    const before: TickerOwnValues = existing ? rowToStoredValues(existing).values : { ...noTickerOwnValues };
    const after: TickerOwnValues = { ...before };
    for (const field of tickerOwnValueFields) {
      const value = given[field];
      if (value !== undefined) after[field] = value === null || value === labVolFarmerV4[field] ? null : value;
    }
    const problem = mergedVolFarmerV4Problem(withTickerOwnValues(labVolFarmerV4, after));
    if (problem) throw new BacktestLabSettingsValidationError(`${symbol}: ${problem}`);
    const changes: TickerOwnValueChange[] = tickerOwnValueFields.filter((field) => before[field] !== after[field]).map((field) => ({ field: `volFarmerV4.${field}`, oldValue: before[field], newValue: after[field] }));
    if (changes.length === 0) return { saved: existing ? rowToStoredValues(existing) : null, changes };
    if (tickerOwnValueFields.every((field) => after[field] === null)) await transaction("backtest_lab_ticker_values").where({ symbol }).delete();
    else {
      const columns = Object.fromEntries(tickerOwnValueFields.map((field) => [columnOfField[field], after[field]]));
      await transaction("backtest_lab_ticker_values")
        .insert({ symbol, ...columns, updated_at: transaction.fn.now(), updated_by_user_id: userId })
        .onConflict("symbol")
        .merge({ ...columns, updated_at: transaction.fn.now(), updated_by_user_id: userId });
    }
    await transaction("backtest_lab_settings_audit").insert(changes.map((change) => ({ user_id: userId, symbol, field: change.field, old_value: change.oldValue === null ? null : String(change.oldValue), new_value: change.newValue === null ? null : String(change.newValue) })));
    return { saved: await loadTickerOwnValues(symbol, transaction), changes };
  });
}
