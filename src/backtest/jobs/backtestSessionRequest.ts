import { validatePlutoSettingsInput, type PlutoSettingsInput } from "../../pluto/settingsStore.js";
import { validateTradingSettingsInput } from "../../lib/tradingSettingsStore.js";
import { normalizeBacktestSymbol } from "../backtestDataDirectory.js";
import type { BacktestSettings, BacktestSettingsOverrides, BacktestTablesMode } from "../backtestTypes.js";
import { isIsoCalendarDate } from "./backtestJobRules.js";

// Validation of a New session request (CreateBacktestSessionRequest). Pure: the data file's coverage and the current
// settings are passed in.

export interface DataFileCoverage {
  firstDate: string | null;
  lastDate: string | null;
}

export interface BacktestSessionRequestContext {
  /** The settings as they are now: the session's snapshot. */
  snapshot: BacktestSettings;
  editablePaths: ReadonlySet<string>;
  /** The symbol's data file coverage; null when the symbol has no file. */
  coverageFor: (symbol: string) => DataFileCoverage | null;
}

export interface ValidatedBacktestSessionRequest {
  name: string;
  symbol: string;
  startDate: string;
  endDate: string;
  startingValue: number;
  tablesMode: BacktestTablesMode;
  /** Only the values that differ from the snapshot. */
  overrides: BacktestSettingsOverrides;
}

export type BacktestSessionRequestValidation = { ok: true; value: ValidatedBacktestSessionRequest } | { ok: false; error: string };

const maximumNameLength = 120;
/** starting_value is decimal(16,2). */
const maximumStartingValue = 1e12;
const tablesModes: readonly BacktestTablesMode[] = ["walk_forward", "current"];

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The changed values only: an override equal to the snapshot's value is dropped. */
function changedEntries(base: object, changes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(changes).filter(([field, value]) => (base as Record<string, unknown>)[field] !== value));
}

export function validateBacktestSettingsOverrides(raw: unknown, snapshot: BacktestSettings, editablePaths: ReadonlySet<string>): { ok: true; overrides: BacktestSettingsOverrides } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, overrides: {} };
  if (!isPlainObject(raw)) return { ok: false, error: "overrides must be an object." };
  const unknownSection = Object.keys(raw).find((key) => key !== "pluto" && key !== "trading" && key !== "kellyFraction");
  if (unknownSection) return { ok: false, error: `overrides.${unknownSection} is not a setting a session can change.` };

  const overrides: BacktestSettingsOverrides = {};
  for (const section of ["pluto", "trading"] as const) {
    const values = raw[section];
    if (values === undefined) continue;
    if (!isPlainObject(values)) return { ok: false, error: `overrides.${section} must be an object.` };
    const notEditable = Object.keys(values).find((field) => !editablePaths.has(`${section}.${field}`));
    if (notEditable) return { ok: false, error: `${section}.${notEditable} cannot be changed for a session.` };
    const problem = section === "pluto" ? validatePlutoSettingsInput(values as PlutoSettingsInput, snapshot.pluto) : validateTradingSettingsInput({ ...snapshot.trading, ...values });
    if (problem) return { ok: false, error: problem };
    const changed = changedEntries(snapshot[section], values);
    if (Object.keys(changed).length > 0) overrides[section] = changed;
  }

  if (raw.kellyFraction !== undefined) {
    if (!editablePaths.has("kellyFraction")) return { ok: false, error: "kellyFraction cannot be changed for a session." };
    const value = raw.kellyFraction;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) return { ok: false, error: "kellyFraction must be a number above 0 and at most 1." };
    if (value !== snapshot.kellyFraction) overrides.kellyFraction = value;
  }
  return { ok: true, overrides };
}

export function validateCreateBacktestSessionRequest(body: unknown, context: BacktestSessionRequestContext): BacktestSessionRequestValidation {
  if (!isPlainObject(body)) return { ok: false, error: "The request body must be an object." };

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") return { ok: false, error: "Give the session a name." };
  if (name.length > maximumNameLength) return { ok: false, error: `The name can be at most ${maximumNameLength} characters.` };

  let symbol: string;
  try {
    symbol = normalizeBacktestSymbol(typeof body.symbol === "string" ? body.symbol : "");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const coverage = context.coverageFor(symbol);
  if (!coverage) return { ok: false, error: `There is no data file for ${symbol}: download it first.` };
  if (!coverage.firstDate || !coverage.lastDate) return { ok: false, error: `The ${symbol} data file has no complete days yet.` };

  const { startDate, endDate } = body;
  if (!isIsoCalendarDate(startDate)) return { ok: false, error: "startDate must be a date (YYYY-MM-DD)." };
  if (!isIsoCalendarDate(endDate)) return { ok: false, error: "endDate must be a date (YYYY-MM-DD)." };
  if (startDate >= endDate) return { ok: false, error: "The start date must be before the end date." };
  if (startDate < coverage.firstDate || endDate > coverage.lastDate) return { ok: false, error: `The ${symbol} data file covers ${coverage.firstDate} to ${coverage.lastDate}: the dates must be inside it.` };

  const startingValue = body.startingValue;
  if (typeof startingValue !== "number" || !Number.isFinite(startingValue) || startingValue <= 0) return { ok: false, error: "The starting account value must be a number above 0." };
  if (startingValue > maximumStartingValue) return { ok: false, error: "The starting account value is too large." };

  const tablesMode = body.tablesMode;
  if (typeof tablesMode !== "string" || !tablesModes.includes(tablesMode as BacktestTablesMode)) return { ok: false, error: `tablesMode must be one of ${tablesModes.join(", ")}.` };

  const overrides = validateBacktestSettingsOverrides(body.overrides, context.snapshot, context.editablePaths);
  if (!overrides.ok) return overrides;

  return { ok: true, value: { name, symbol, startDate, endDate, startingValue, tablesMode: tablesMode as BacktestTablesMode, overrides: overrides.overrides } };
}
