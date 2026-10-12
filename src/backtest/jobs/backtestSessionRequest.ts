import { validatePlutoSettingsInput, type PlutoSettingsInput } from "../../pluto/settingsStore.js";
import { validateTradingSettingsInput } from "../../lib/tradingSettingsStore.js";
import { normalizeBacktestSymbol } from "../backtestDataDirectory.js";
import { backtestBookPageDefaultLimit, backtestBookPageMaxLimit, backtestMaxSymbolsPerSession, defaultBacktestPolicySettings, type BacktestPolicySettings, type BacktestSettings, type BacktestSettingsOverrides, type BacktestTablesMode } from "../backtestTypes.js";
import { backtestClaudeCliPathMissingMessage } from "../backtestClaudeCli.js";
import { isIsoCalendarDate } from "./backtestJobRules.js";

// Validation of a New session request (CreateBacktestSessionRequest). Pure: the data files' coverage and the current
// settings are passed in. A session of several symbols needs every symbol's file, and its dates inside the period all
// the files cover.

export interface DataFileCoverage {
  firstDate: string | null;
  lastDate: string | null;
}

/** What a symbol's file holds inside a session's period. */
export interface DataFilePeriodContents {
  /** Weekdays of the period with no day stored at all, not counting the days recorded as unavailable. */
  missingWeekdays: number;
  firstMissingWeekday: string | null;
  lastMissingWeekday: string | null;
  completeDays: number;
  /** Complete days of the period that have no intraday quotes: they get the 10:00 look only. */
  completeDaysWithoutIntradayQuotes: number;
}

export interface BacktestSessionRequestContext {
  /** The settings as they are now: the session's snapshot. */
  snapshot: BacktestSettings;
  editablePaths: ReadonlySet<string>;
  /** The symbol's data file coverage; null when the symbol has no file. */
  coverageFor: (symbol: string) => DataFileCoverage | null;
  /** What the symbol's file holds between two dates (both included); null when the symbol has no file. */
  periodContentsFor: (symbol: string, startDate: string, endDate: string) => DataFilePeriodContents | null;
  /** BACKTEST_CLAUDE_CLI_PATH is set: the AI model can be the decision maker. */
  claudeCliAvailable: boolean;
}

export interface ValidatedBacktestSessionRequest {
  name: string;
  /** One or more, normalized, without repeats, in the order given. */
  symbols: string[];
  startDate: string;
  endDate: string;
  startingValue: number;
  tablesMode: BacktestTablesMode;
  /** Only the values that differ from the snapshot. */
  overrides: BacktestSettingsOverrides;
}

/** `warnings` do not stop the session: what it will do differently because of what its data files hold. */
export type BacktestSessionRequestValidation = { ok: true; value: ValidatedBacktestSessionRequest; warnings: string[] } | { ok: false; error: string };

const maximumNameLength = 120;
/** starting_value is decimal(16,2). */
const maximumStartingValue = 1e12;
const tablesModes: readonly BacktestTablesMode[] = ["walk_forward", "current"];

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The changed values only: an override equal to the snapshot's value is dropped. */
function changedEntries(base: object, changes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(changes).filter(([field, value]) => (base as Record<string, unknown>)[field] !== value));
}

/** The values each decision rule can take (BacktestPolicySettings). */
export const backtestPolicyChoices: { readonly [Rule in keyof BacktestPolicySettings]: readonly BacktestPolicySettings[Rule][] } = {
  roll: ["flagged_legs", "any_eligible", "never"],
  buyback: ["when_offered", "never"],
  sharesInProfit: ["call_else_sell", "always_sell", "always_keep"],
  eventClose: ["stress_vs_remaining", "never", "always"],
  afterBlockedChoice: ["try_next", "stop"],
};

export function validateBacktestSettingsOverrides(
  raw: unknown,
  snapshot: BacktestSettings,
  editablePaths: ReadonlySet<string>,
  decisionMakers: { claudeCliAvailable: boolean },
): { ok: true; overrides: BacktestSettingsOverrides } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, overrides: {} };
  if (!isPlainObject(raw)) return { ok: false, error: "overrides must be an object." };
  const unknownSection = Object.keys(raw).find((key) => key !== "pluto" && key !== "trading" && key !== "kellyFraction" && key !== "policy" && key !== "decisionMaker");
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

  if (raw.policy !== undefined) {
    if (!isPlainObject(raw.policy)) return { ok: false, error: "overrides.policy must be an object." };
    const snapshotPolicy = { ...defaultBacktestPolicySettings, ...snapshot.policy };
    const changedPolicy: Partial<Record<keyof BacktestPolicySettings, string>> = {};
    for (const [rule, value] of Object.entries(raw.policy)) {
      if (!editablePaths.has(`policy.${rule}`)) return { ok: false, error: `policy.${rule} cannot be changed for a session.` };
      const choices: readonly string[] = backtestPolicyChoices[rule as keyof BacktestPolicySettings];
      if (typeof value !== "string" || !choices.includes(value)) return { ok: false, error: `policy.${rule} must be one of ${choices.join(", ")}.` };
      if (value !== snapshotPolicy[rule as keyof BacktestPolicySettings]) changedPolicy[rule as keyof BacktestPolicySettings] = value;
    }
    if (Object.keys(changedPolicy).length > 0) overrides.policy = changedPolicy as Partial<BacktestPolicySettings>;
  }

  if (raw.decisionMaker !== undefined) {
    if (raw.decisionMaker !== "rules" && raw.decisionMaker !== "llm") return { ok: false, error: "decisionMaker must be rules or llm." };
    if (raw.decisionMaker === "llm" && !decisionMakers.claudeCliAvailable) return { ok: false, error: backtestClaudeCliPathMissingMessage };
    if (raw.decisionMaker !== (snapshot.decisionMaker ?? "rules")) overrides.decisionMaker = raw.decisionMaker;
  }
  return { ok: true, overrides };
}

const formatWholeNumber = (value: number) => value.toLocaleString("en-US");

/** The note on a symbol whose file lacks intraday quotes for some of a session's days (the request's warning and the run's note). */
export function describeDaysWithoutIntradayQuotes(symbol: string, daysWithout: number, days: number): string {
  return `${symbol}: ${formatWholeNumber(daysWithout)} of its ${formatWholeNumber(days)} days in the period have no intraday quotes: on those days it gets one look, at 10:00.`;
}

export function validateCreateBacktestSessionRequest(body: unknown, context: BacktestSessionRequestContext): BacktestSessionRequestValidation {
  if (!isPlainObject(body)) return { ok: false, error: "The request body must be an object." };

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") return { ok: false, error: "Give the session a name." };
  if (name.length > maximumNameLength) return { ok: false, error: `The name can be at most ${maximumNameLength} characters.` };

  // `symbols` is the list; a request written before sessions took one gives `symbol`.
  const givenSymbols: unknown = body.symbols === undefined ? (body.symbol === undefined ? [] : [body.symbol]) : body.symbols;
  if (!Array.isArray(givenSymbols) || givenSymbols.length === 0) return { ok: false, error: "Give the session at least one symbol." };
  const symbols: string[] = [];
  for (const given of givenSymbols) {
    let symbol: string;
    try {
      symbol = normalizeBacktestSymbol(typeof given === "string" ? given : "");
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  if (symbols.length > backtestMaxSymbolsPerSession) return { ok: false, error: `A session takes at most ${backtestMaxSymbolsPerSession} symbols.` };
  const coverages: { symbol: string; firstDate: string; lastDate: string }[] = [];
  for (const symbol of symbols) {
    const coverage = context.coverageFor(symbol);
    if (!coverage) return { ok: false, error: `There is no data file for ${symbol}: download it first.` };
    if (!coverage.firstDate || !coverage.lastDate) return { ok: false, error: `The ${symbol} data file has no complete days yet.` };
    coverages.push({ symbol, firstDate: coverage.firstDate, lastDate: coverage.lastDate });
  }
  // The dates must be inside what every file covers: from the file that starts last to the file that ends first.
  const startsLast = coverages.reduce((latest, coverage) => (coverage.firstDate > latest.firstDate ? coverage : latest));
  const endsFirst = coverages.reduce((earliest, coverage) => (coverage.lastDate < earliest.lastDate ? coverage : earliest));
  if (startsLast.firstDate > endsFirst.lastDate) return { ok: false, error: `The data files do not overlap: ${startsLast.symbol} starts ${startsLast.firstDate}, after ${endsFirst.symbol} ends ${endsFirst.lastDate}.` };

  const { startDate, endDate } = body;
  if (!isIsoCalendarDate(startDate)) return { ok: false, error: "startDate must be a date (YYYY-MM-DD)." };
  if (!isIsoCalendarDate(endDate)) return { ok: false, error: "endDate must be a date (YYYY-MM-DD)." };
  if (startDate >= endDate) return { ok: false, error: "The start date must be before the end date." };
  if (startDate < startsLast.firstDate || endDate > endsFirst.lastDate) {
    if (symbols.length === 1) return { ok: false, error: `The ${symbols[0]} data file covers ${startsLast.firstDate} to ${endsFirst.lastDate}: the dates must be inside it.` };
    const limits = [startDate < startsLast.firstDate ? `${startsLast.symbol} starts ${startsLast.firstDate}` : null, endDate > endsFirst.lastDate ? `${endsFirst.symbol} ends ${endsFirst.lastDate}` : null].filter((limit) => limit !== null);
    return { ok: false, error: `The data files together cover ${startsLast.firstDate} to ${endsFirst.lastDate} (${limits.join(", ")}): the dates must be inside that.` };
  }

  // A file whose download is not finished has weekdays with nothing stored inside its range: the session would skip
  // them silently. Days the downloader recorded as unavailable are known gaps and stay allowed.
  const warnings: string[] = [];
  for (const symbol of symbols) {
    const contents = context.periodContentsFor(symbol, startDate, endDate);
    if (!contents) continue;
    if (contents.missingWeekdays > 0) {
      const where = contents.missingWeekdays === 1 ? `on ${contents.firstMissingWeekday}` : `between ${contents.firstMissingWeekday} and ${contents.lastMissingWeekday}`;
      return { ok: false, error: `${symbol}'s file has ${formatWholeNumber(contents.missingWeekdays)} weekday${contents.missingWeekdays === 1 ? "" : "s"} missing ${where}: finish its download or shorten the period.` };
    }
    if (contents.completeDaysWithoutIntradayQuotes > 0) warnings.push(describeDaysWithoutIntradayQuotes(symbol, contents.completeDaysWithoutIntradayQuotes, contents.completeDays));
  }

  const startingValue = body.startingValue;
  if (typeof startingValue !== "number" || !Number.isFinite(startingValue) || startingValue <= 0) return { ok: false, error: "The starting account value must be a number above 0." };
  if (startingValue > maximumStartingValue) return { ok: false, error: "The starting account value is too large." };

  const tablesMode = body.tablesMode;
  if (typeof tablesMode !== "string" || !tablesModes.includes(tablesMode as BacktestTablesMode)) return { ok: false, error: `tablesMode must be one of ${tablesModes.join(", ")}.` };

  const overrides = validateBacktestSettingsOverrides(body.overrides, context.snapshot, context.editablePaths, { claudeCliAvailable: context.claudeCliAvailable });
  if (!overrides.ok) return overrides;

  return { ok: true, value: { name, symbols, startDate, endDate, startingValue, tablesMode: tablesMode as BacktestTablesMode, overrides: overrides.overrides }, warnings };
}

/** The filters of a page of a session's actions or fills, every default filled in. */
export interface BacktestBookPageFilters {
  from: string | null;
  to: string | null;
  symbol: string | null;
  outcome: "filled" | "blocked" | null;
  limit: number;
  offset: number;
}

/**
 * Validation of the query of GET /backtest/sessions/:id/actions and /fills (BacktestBookPageQuery): trading dates from
 * and to (inclusive), a symbol, the actions' outcome, and the page (limit 200 unless given, at most 1,000; offset 0).
 */
export function validateBacktestBookPageQuery(raw: Record<string, unknown>, options: { outcomeAllowed: boolean }): { ok: true; filters: BacktestBookPageFilters } | { ok: false; error: string } {
  const given = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const filters: BacktestBookPageFilters = { from: given("from"), to: given("to"), symbol: null, outcome: null, limit: backtestBookPageDefaultLimit, offset: 0 };
  for (const key of ["from", "to"] as const) if (filters[key] !== null && !isIsoCalendarDate(filters[key])) return { ok: false, error: `${key} must be a date (YYYY-MM-DD).` };
  if (filters.from !== null && filters.to !== null && filters.from > filters.to) return { ok: false, error: "from must be on or before to." };
  const symbol = given("symbol");
  if (symbol !== null) {
    try {
      filters.symbol = normalizeBacktestSymbol(symbol);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const outcome = given("outcome");
  if (outcome !== null) {
    if (!options.outcomeAllowed) return { ok: false, error: "outcome filters actions only." };
    if (outcome !== "filled" && outcome !== "blocked") return { ok: false, error: "outcome must be filled or blocked." };
    filters.outcome = outcome;
  }
  const wholeNumber = (key: "limit" | "offset", minimum: number, maximum: number): number | string => {
    const text = given(key);
    if (text === null) return filters[key];
    const value = Number(text);
    return Number.isInteger(value) && value >= minimum && value <= maximum ? value : `${key} must be a whole number from ${minimum} to ${maximum}.`;
  };
  const limit = wholeNumber("limit", 1, backtestBookPageMaxLimit);
  if (typeof limit === "string") return { ok: false, error: limit };
  const offset = wholeNumber("offset", 0, Number.MAX_SAFE_INTEGER);
  if (typeof offset === "string") return { ok: false, error: "offset must be a whole number from 0." };
  return { ok: true, filters: { ...filters, limit, offset } };
}
