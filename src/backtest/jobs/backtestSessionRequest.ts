import { validatePlutoSettingsInput, type PlutoSettingsInput } from "../../pluto/settingsStore.js";
import { validateTradingSettingsInput } from "../../lib/tradingSettingsStore.js";
import { normalizeBacktestSymbol } from "../backtestDataDirectory.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import {
  backtestBookPageDefaultLimit,
  backtestBookPageMaxLimit,
  backtestMaxSymbolsPerSession,
  backtestSessionsPageDefaultLimit,
  backtestSessionsPageMaxLimit,
  backtestTickerBaselineKeys,
  activeBacktestDecisionMakers,
  defaultBacktestBaselineSettings,
  defaultBacktestSteadyStakeSettings,
  defaultBacktestVolFarmerSettings,
  defaultBacktestVolFarmerV2Settings,
  volFarmerV2StepRules,
  type BacktestBaselineSettings,
  type BacktestBookMode,
  type BacktestSessionStatusFilter,
  type BacktestSettings,
  type BacktestSettingsOverrides,
  type BacktestSettingsSource,
  type BacktestSteadyStakeSettings,
  type BacktestVolFarmerSettings,
  type BacktestVolFarmerV2Settings,
  type BacktestSymbolResolution,
  type BacktestSymbolSettingSource,
  type BacktestSymbolSettings,
  type BacktestTickerProblem,
  type BacktestTablesMode,
  type BacktestTickerBaselineKey,
  type BacktestTickerBaselineSettings,
  type BacktestTickerValues,
  isRetiredBacktestDecisionMaker,
  retiredBacktestDecisionMakerMessage,
} from "../backtestTypes.js";
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
  /** The ticker's saved lab values (its pot and baseline values); null when it has none. */
  tickerValuesFor: (symbol: string) => BacktestTickerValues | null;
  /** The lab's pot for a ticker without its own; null when none is set. */
  defaultPotDollars: number | null;
}

export interface ValidatedBacktestSessionRequest {
  name: string;
  /** One or more, normalized, without repeats, in the order given. */
  symbols: string[];
  startDate: string;
  endDate: string;
  /** The session's capital: the starting value given, else Σ the pots. */
  startingValue: number;
  tablesMode: BacktestTablesMode;
  /** Only the values that differ from the snapshot. */
  overrides: BacktestSettingsOverrides;
  /** "pots" when the baseline decides; "shared_account" with the Steady Stake and the Vol Farmers. */
  bookMode: BacktestBookMode;
  /** Each ticker's pot, weight and values ("pots"); null otherwise. */
  symbolSettings: Record<string, BacktestSymbolSettings> | null;
  /** The same with where a reset of each value returns ("pots"); null otherwise. */
  symbolResolution: Record<string, BacktestSymbolResolution> | null;
  /** How a "pots" session was asked for (Run again); null otherwise. */
  settingsSource: BacktestSettingsSource | null;
  potsFromStartingValue: boolean | null;
}

/**
 * `warnings` do not stop the session: what it will do differently because of what its data files hold. A request refused
 * only for its tickers' values carries their resolution (`symbolResolution`), each ticker with its problems.
 */
export type BacktestSessionRequestValidation =
  | { ok: true; value: ValidatedBacktestSessionRequest; warnings: string[] }
  | { ok: false; error: string; symbolResolution?: { capital: number | null; bySymbol: Record<string, BacktestSymbolResolution> }; warnings?: string[] };

const maximumNameLength = 120;
/** starting_value is decimal(16,2). */
const maximumStartingValue = 1e12;
const tablesModes: readonly BacktestTablesMode[] = ["walk_forward", "current"];

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The changed values only: an override equal to the snapshot's value is dropped. */
function changedEntries(base: object, changes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(changes).filter(([field, value]) => (base as Record<string, unknown>)[field] !== value));
}

/**
 * A session's overrides, checked against the snapshot: only the changed values are kept. The policy, the model and the
 * Kelly fraction were the retired rules sessions' and are no longer settings a session can change.
 */
export function validateBacktestSettingsOverrides(raw: unknown, snapshot: BacktestSettings, editablePaths: ReadonlySet<string>): { ok: true; overrides: BacktestSettingsOverrides } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, overrides: {} };
  if (!isPlainObject(raw)) return { ok: false, error: "overrides must be an object." };
  const unknownSection = Object.keys(raw).find((key) => key !== "pluto" && key !== "trading" && key !== "decisionMaker" && key !== "baseline" && key !== "steadyStake" && key !== "volFarmer" && key !== "volFarmerV2");
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

  if (raw.baseline !== undefined) {
    if (!isPlainObject(raw.baseline)) return { ok: false, error: "overrides.baseline must be an object." };
    const snapshotBaseline = { ...defaultBacktestBaselineSettings, ...snapshot.baseline };
    const notEditable = Object.keys(raw.baseline).find((field) => !editablePaths.has(`baseline.${field}`));
    if (notEditable) return { ok: false, error: `baseline.${notEditable} cannot be changed for a session.` };
    const merged = { ...snapshotBaseline, ...raw.baseline } as Record<string, unknown>;
    const problem = validateBaselineSettings(merged);
    if (problem) return { ok: false, error: problem };
    const changed = changedEntries(snapshotBaseline, raw.baseline);
    if (Object.keys(changed).length > 0) overrides.baseline = changed as Partial<BacktestBaselineSettings>;
  }

  // Every Steady Stake value can change for a session.
  if (raw.steadyStake !== undefined) {
    if (!isPlainObject(raw.steadyStake)) return { ok: false, error: "overrides.steadyStake must be an object." };
    const snapshotSteadyStake = { ...defaultBacktestSteadyStakeSettings, ...snapshot.steadyStake };
    const unknownField = Object.keys(raw.steadyStake).find((field) => !(field in defaultBacktestSteadyStakeSettings));
    if (unknownField) return { ok: false, error: `steadyStake.${unknownField} is not a Steady Stake setting.` };
    const problem = validateSteadyStakeSettings({ ...snapshotSteadyStake, ...raw.steadyStake });
    if (problem) return { ok: false, error: problem };
    const changed = changedEntries(snapshotSteadyStake, raw.steadyStake);
    if (Object.keys(changed).length > 0) overrides.steadyStake = changed as Partial<BacktestSteadyStakeSettings>;
  }

  // Every Vol Farmer value can change for a session.
  if (raw.volFarmer !== undefined) {
    if (!isPlainObject(raw.volFarmer)) return { ok: false, error: "overrides.volFarmer must be an object." };
    const snapshotVolFarmer = { ...defaultBacktestVolFarmerSettings, ...snapshot.volFarmer };
    const unknownField = Object.keys(raw.volFarmer).find((field) => !(field in defaultBacktestVolFarmerSettings));
    if (unknownField) return { ok: false, error: `volFarmer.${unknownField} is not a Vol Farmer setting.` };
    const problem = validateVolFarmerSettings({ ...snapshotVolFarmer, ...raw.volFarmer });
    if (problem) return { ok: false, error: problem };
    const changed = changedEntries(snapshotVolFarmer, raw.volFarmer);
    if (Object.keys(changed).length > 0) overrides.volFarmer = changed as Partial<BacktestVolFarmerSettings>;
  }

  // Every Vol Farmer v2 value can change for a session.
  if (raw.volFarmerV2 !== undefined) {
    if (!isPlainObject(raw.volFarmerV2)) return { ok: false, error: "overrides.volFarmerV2 must be an object." };
    const snapshotVolFarmerV2 = { ...defaultBacktestVolFarmerV2Settings, ...snapshot.volFarmerV2 };
    const unknownField = Object.keys(raw.volFarmerV2).find((field) => !(field in defaultBacktestVolFarmerV2Settings));
    if (unknownField) return { ok: false, error: `volFarmerV2.${unknownField} is not a Vol Farmer v2 setting.` };
    const problem = validateVolFarmerV2Settings({ ...snapshotVolFarmerV2, ...raw.volFarmerV2 });
    if (problem) return { ok: false, error: problem };
    const changed = changedEntries(snapshotVolFarmerV2, raw.volFarmerV2);
    if (Object.keys(changed).length > 0) overrides.volFarmerV2 = changed as Partial<BacktestVolFarmerV2Settings>;
  }

  if (raw.decisionMaker !== undefined) {
    if (raw.decisionMaker === "rules" || raw.decisionMaker === "llm") return { ok: false, error: retiredBacktestDecisionMakerMessage };
    if (!(activeBacktestDecisionMakers as readonly unknown[]).includes(raw.decisionMaker)) return { ok: false, error: `decisionMaker must be ${activeBacktestDecisionMakers.slice(0, -1).join(", ")} or ${activeBacktestDecisionMakers.at(-1)}.` };
    if (raw.decisionMaker !== (snapshot.decisionMaker ?? "rules")) overrides.decisionMaker = raw.decisionMaker as BacktestSettingsOverrides["decisionMaker"];
  }
  return { ok: true, overrides };
}

/** The baseline wheel's values (BacktestBaselineSettings): null when they are valid. */
export function validateBaselineSettings(values: Record<string, unknown>): string | null {
  if (values.entry !== "put" && values.entry !== "covered_call" && values.entry !== "higher_yield") return "baseline.entry must be put, covered_call or higher_yield.";
  for (const field of ["minAbsDelta", "maxAbsDelta", "callMinAbsDelta", "callMaxAbsDelta"] as const) {
    const value = values[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) return `baseline.${field} must be a number above 0 and at most 1.`;
  }
  for (const field of ["minDte", "maxDte"] as const) {
    const value = values[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 45) return `baseline.${field} must be a whole number of days from 0 to 45 (the data files hold up to 45; 0 = expiring on the look's day).`;
  }
  if (typeof values.maxSpreadPctOfMid !== "number" || !Number.isFinite(values.maxSpreadPctOfMid) || values.maxSpreadPctOfMid <= 0 || values.maxSpreadPctOfMid > 200) return "baseline.maxSpreadPctOfMid must be a number above 0 and at most 200.";
  if (values.callStrike !== "delta_range" && values.callStrike !== "above_share_cost" && values.callStrike !== "above_break_even" && values.callStrike !== "above_latest_entry" && values.callStrike !== "above_average_cost" && values.callStrike !== "above_average_cost_else_break_even" && values.callStrike !== "none") return "baseline.callStrike must be delta_range, above_share_cost, above_break_even, above_latest_entry, above_average_cost, above_average_cost_else_break_even or none.";
  if (values.callStrike === "none" && values.entry !== "put") return "baseline.callStrike none cannot go with a Covered Call entry, which sells a call on its shares.";
  if (values.entryCallStrike !== "any" && values.entryCallStrike !== "above_purchase_price" && values.entryCallStrike !== "above_average_after_purchase") return "baseline.entryCallStrike must be any, above_purchase_price or above_average_after_purchase.";
  if (values.entryWhenSharesUncovered !== "wait" && values.entryWhenSharesUncovered !== "buy") return "baseline.entryWhenSharesUncovered must be wait or buy.";
  if (typeof values.maxSharesPctOfAccount !== "number" || !Number.isFinite(values.maxSharesPctOfAccount) || values.maxSharesPctOfAccount <= 0 || values.maxSharesPctOfAccount > 100) return "baseline.maxSharesPctOfAccount must be a number above 0 and at most 100.";
  if (values.maxSharesPctOfAccount < 100 && values.entry === "put") return "baseline.maxSharesPctOfAccount needs baseline.entry set to Covered Call: it caps the new Covered Calls' shares. Set baseline.maxSharesPctOfAccount to 100 to use Cash-Secured Put entries.";
  if (typeof values.minCallYieldPct !== "number" || !Number.isFinite(values.minCallYieldPct) || values.minCallYieldPct < 0 || values.minCallYieldPct > 1000) return "baseline.minCallYieldPct must be a number from 0 (any) to 1000.";
  if (values.minCallYieldAppliesTo !== "every_call" && values.minCallYieldAppliesTo !== "new_covered_calls") return "baseline.minCallYieldAppliesTo must be every_call or new_covered_calls.";
  if (values.putsWhenNoCall !== "off" && values.putsWhenNoCall !== "reserve_ladder") return "baseline.putsWhenNoCall must be off or reserve_ladder.";
  const ladderError = values.putsWhenNoCall === "reserve_ladder" ? validateLadderSettings(values) : null;
  if (ladderError) return ladderError;
  if (values.dayValueOptions !== "marked" && values.dayValueOptions !== "excluded") return "baseline.dayValueOptions must be marked or excluded.";
  if (values.callDeltaRange !== "entry_range" && values.callDeltaRange !== "own_range") return "baseline.callDeltaRange must be entry_range or own_range.";
  if (typeof values.takeProfitPct !== "number" || !Number.isFinite(values.takeProfitPct) || values.takeProfitPct < 0 || values.takeProfitPct >= 100) return "baseline.takeProfitPct must be a number from 0 (off) to below 100.";
  if (typeof values.shareStopLossPct !== "number" || !Number.isFinite(values.shareStopLossPct) || values.shareStopLossPct < 0 || values.shareStopLossPct >= 100) return "baseline.shareStopLossPct must be a number from 0 (off) to below 100.";
  if (values.earnings !== "ignore" && values.earnings !== "skip_spanning") return "baseline.earnings must be ignore or skip_spanning.";
  if (typeof values.maxAccountPctPerStock !== "number" || !Number.isFinite(values.maxAccountPctPerStock) || values.maxAccountPctPerStock <= 0 || values.maxAccountPctPerStock > 100) return "baseline.maxAccountPctPerStock must be a number above 0 and at most 100.";
  if (values.looks !== "every_look" && values.looks !== "first_look") return "baseline.looks must be every_look or first_look.";
  if (values.volatilityEdgeFilter !== "off" && values.volatilityEdgeFilter !== "entries" && values.volatilityEdgeFilter !== "all_sales") return "baseline.volatilityEdgeFilter must be off, entries or all_sales.";
  if (typeof values.minVolatilityEdgePoints !== "number" || !Number.isFinite(values.minVolatilityEdgePoints) || Math.abs(values.minVolatilityEdgePoints) > 100) return "baseline.minVolatilityEdgePoints must be a number of volatility points from −100 to 100.";
  if (values.entryExtensionFilter !== "off" && values.entryExtensionFilter !== "on") return "baseline.entryExtensionFilter must be off or on.";
  if (typeof values.entryMaxExtensionZ !== "number" || !Number.isFinite(values.entryMaxExtensionZ) || values.entryMaxExtensionZ <= 0 || values.entryMaxExtensionZ > 10) return "baseline.entryMaxExtensionZ must be a number above 0 and at most 10.";
  if (values.entryIvRankFilter !== "off" && values.entryIvRankFilter !== "on") return "baseline.entryIvRankFilter must be off or on.";
  if (typeof values.entryMaxIvRank !== "number" || !Number.isFinite(values.entryMaxIvRank) || values.entryMaxIvRank <= 0 || values.entryMaxIvRank > 100) return "baseline.entryMaxIvRank must be a number above 0 and at most 100.";
  if (values.ranking !== "premium_yield" && values.ranking !== "edge_yield" && values.ranking !== "time_value" && values.ranking !== "premium_dollars" && values.ranking !== "premium_per_day") return "baseline.ranking must be premium_yield, edge_yield, time_value, premium_dollars or premium_per_day.";
  if (values.expiryChoice !== "any_in_range" && values.expiryChoice !== "nearest_qualifying") return "baseline.expiryChoice must be any_in_range or nearest_qualifying.";
  if (values.coverage !== "best_contract" && values.coverage !== "fill_down_ranking") return "baseline.coverage must be best_contract or fill_down_ranking.";
  if (typeof values.hedgePutTenorDays !== "number" || !Number.isInteger(values.hedgePutTenorDays) || values.hedgePutTenorDays < 0 || values.hedgePutTenorDays > 1000) return "baseline.hedgePutTenorDays must be a whole number of days from 0 (no hedge) to 1000.";
  if (values.hedgePutExpiry !== "nearest" && values.hedgePutExpiry !== "first_at_or_after") return "baseline.hedgePutExpiry must be nearest or first_at_or_after.";
  if (values.hedgePutStrikeFrom !== "stock_price" && values.hedgePutStrikeFrom !== "price_paid") return "baseline.hedgePutStrikeFrom must be stock_price or price_paid.";
  if (typeof values.hedgePutBelowPricePct !== "number" || !Number.isFinite(values.hedgePutBelowPricePct) || values.hedgePutBelowPricePct < 0 || values.hedgePutBelowPricePct >= 100) return "baseline.hedgePutBelowPricePct must be a number from 0 (at the money) to below 100.";
  if (values.hedgePutSize !== "share_level" && values.hedgePutSize !== "rung_level") return "baseline.hedgePutSize must be share_level or rung_level.";
  if (typeof values.hedgePutCoveragePct !== "number" || !Number.isFinite(values.hedgePutCoveragePct) || values.hedgePutCoveragePct <= 0 || values.hedgePutCoveragePct > 100) return "baseline.hedgePutCoveragePct must be a number above 0 and at most 100.";
  if (typeof values.hedgePutRollDaysLeft !== "number" || !Number.isInteger(values.hedgePutRollDaysLeft) || values.hedgePutRollDaysLeft < 0 || values.hedgePutRollDaysLeft > 120) return "baseline.hedgePutRollDaysLeft must be a whole number of days from 0 to 120.";
  if (values.hedgePutCovers !== "entries" && values.hedgePutCovers !== "position") return "baseline.hedgePutCovers must be entries or position.";
  if (typeof values.hedgePutStaggeredExpiries !== "number" || !Number.isInteger(values.hedgePutStaggeredExpiries) || values.hedgePutStaggeredExpiries < 1 || values.hedgePutStaggeredExpiries > 6) return "baseline.hedgePutStaggeredExpiries must be a whole number from 1 to 6.";
  if (values.hedgePutStrikeBy !== "price" && values.hedgePutStrikeBy !== "delta") return "baseline.hedgePutStrikeBy must be price or delta.";
  if (typeof values.hedgePutAbsDelta !== "number" || !Number.isFinite(values.hedgePutAbsDelta) || values.hedgePutAbsDelta <= 0 || values.hedgePutAbsDelta >= 1) return "baseline.hedgePutAbsDelta must be a number above 0 and below 1.";
  if (!["off", "cost_vs_typical_fall", "iv_vs_history", "iv_vs_realized"].includes(values.hedgePutPriceGate as string)) return "baseline.hedgePutPriceGate must be off, cost_vs_typical_fall, iv_vs_history or iv_vs_realized.";
  if (typeof values.hedgePutCostFallShare !== "number" || !Number.isFinite(values.hedgePutCostFallShare) || values.hedgePutCostFallShare <= 0 || values.hedgePutCostFallShare > 5) return "baseline.hedgePutCostFallShare must be a number above 0 and at most 5.";
  if (typeof values.hedgePutIvMultiple !== "number" || !Number.isFinite(values.hedgePutIvMultiple) || values.hedgePutIvMultiple <= 0 || values.hedgePutIvMultiple > 10) return "baseline.hedgePutIvMultiple must be a number above 0 and at most 10.";
  if (values.hedgeInBreakEven !== "excluded" && values.hedgeInBreakEven !== "included") return "baseline.hedgeInBreakEven must be excluded or included.";
  if (!["sell_when_shares_leave", "keep_for_next_entry", "keep_unless_far_below", "wait_between_purchases"].includes(values.hedgePutTurnover as string)) return "baseline.hedgePutTurnover must be sell_when_shares_leave, keep_for_next_entry, keep_unless_far_below or wait_between_purchases.";
  if (typeof values.hedgePutTurnoverDays !== "number" || !Number.isInteger(values.hedgePutTurnoverDays) || values.hedgePutTurnoverDays < 1 || values.hedgePutTurnoverDays > 365) return "baseline.hedgePutTurnoverDays must be a whole number of days from 1 to 365.";
  if (typeof values.hedgePutFarBelowPct !== "number" || !Number.isFinite(values.hedgePutFarBelowPct) || values.hedgePutFarBelowPct <= 0 || values.hedgePutFarBelowPct >= 100) return "baseline.hedgePutFarBelowPct must be a number above 0 and below 100.";
  if (values.hedgePutTenorDays > 0 && values.hedgePutTenorDays <= values.hedgePutRollDaysLeft) return "baseline.hedgePutTenorDays must be above baseline.hedgePutRollDaysLeft: a Put that close to expiry would be sold at once.";
  if (values.hedgePutTenorDays > 0 && values.hedgePutCovers === "position" && values.hedgePutTenorDays - values.hedgePutRollDaysLeft < values.hedgePutStaggeredExpiries) return "baseline.hedgePutStaggeredExpiries must be at most the days between baseline.hedgePutTenorDays and baseline.hedgePutRollDaysLeft: each expiry needs a day of its own.";
  if ((values.minAbsDelta as number) > (values.maxAbsDelta as number)) return "baseline.minAbsDelta must not be above baseline.maxAbsDelta.";
  if ((values.callMinAbsDelta as number) > (values.callMaxAbsDelta as number)) return "baseline.callMinAbsDelta must not be above baseline.callMaxAbsDelta.";
  if ((values.minDte as number) > (values.maxDte as number)) return "baseline.minDte must not be above baseline.maxDte.";
  return null;
}

/** The Steady Stake's values (BacktestSteadyStakeSettings): null when they are valid. */
export function validateSteadyStakeSettings(values: Record<string, unknown>): string | null {
  const isNumberIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  if (!isNumberIn(values.stakePct, 1, 100)) return "steadyStake.stakePct must be a number from 1 to 100.";
  if (!isNumberIn(values.rebalanceBandPct, 0, 50)) return "steadyStake.rebalanceBandPct must be a number from 0 to 50.";
  if (!isNumberIn(values.callCoveragePct, 0, 100)) return "steadyStake.callCoveragePct must be a number from 0 (no Calls) to 100.";
  if (!isNumberIn(values.putCashPct, 0, 100)) return "steadyStake.putCashPct must be a number from 0 (no Puts) to 100.";
  for (const field of ["callAbsDelta", "putAbsDelta"] as const) if (!isNumberIn(values[field], 0.01, 0.99)) return `steadyStake.${field} must be a number from 0.01 to 0.99.`;
  if (!isNumberIn(values.deltaTolerance, 0.005, 0.5)) return "steadyStake.deltaTolerance must be a number from 0.005 to 0.5.";
  if (!isNumberIn(values.maxSpreadPctOfMid, 1, 200)) return "steadyStake.maxSpreadPctOfMid must be a number from 1 to 200.";
  return null;
}

/** The Vol Farmer's values (BacktestVolFarmerSettings): null when they are valid. */
export function validateVolFarmerSettings(values: Record<string, unknown>): string | null {
  const isNumberIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  const isWholeNumberIn = (value: unknown, min: number, max: number) => isNumberIn(value, min, max) && Number.isInteger(value);
  for (const field of ["callMinAbsDelta", "callMaxAbsDelta"] as const) if (!isNumberIn(values[field], 0.01, 0.99)) return `volFarmer.${field} must be a number from 0.01 to 0.99.`;
  if ((values.callMinAbsDelta as number) > (values.callMaxAbsDelta as number)) return "volFarmer.callMinAbsDelta must not be above volFarmer.callMaxAbsDelta.";
  for (const field of ["callMinDte", "callMaxDte"] as const) if (!isWholeNumberIn(values[field], 0, 45)) return `volFarmer.${field} must be a whole number from 0 to 45 (the Calls the engine reads).`;
  if ((values.callMinDte as number) > (values.callMaxDte as number)) return "volFarmer.callMinDte must not be above volFarmer.callMaxDte.";
  for (const field of ["putMinDte", "putMaxDte"] as const) if (!isWholeNumberIn(values[field], 0, 1000)) return `volFarmer.${field} must be a whole number from 0 to 1000.`;
  if ((values.putMinDte as number) > (values.putMaxDte as number)) return "volFarmer.putMinDte must not be above volFarmer.putMaxDte.";
  if (!isNumberIn(values.putMaxStrikeAbovePricePct, -20, 10)) return "volFarmer.putMaxStrikeAbovePricePct must be a number from −20 to 10.";
  if (!isNumberIn(values.protectionFallPct, 1, 90)) return "volFarmer.protectionFallPct must be a number from 1 to 90.";
  if (!isNumberIn(values.maxSpreadPctOfMid, 1, 200)) return "volFarmer.maxSpreadPctOfMid must be a number from 1 to 200.";
  if (!isNumberIn(values.putCashReservePct, 0, 50)) return "volFarmer.putCashReservePct must be a number from 0 to 50.";
  const choices: Record<string, readonly string[]> = { callExpiry: ["in_range", "next"], crossing: ["unwind", "hold_to_expiry", "unwind_if_net_positive"], putExpiry: ["in_range", "with_the_call"], hedgeRuleCallPremiums: ["excluded", "included"], hedgeWithoutCall: ["none", "put", "cheapest_per_year"], putChoice: ["most_protection", "cheapest_per_year"], putRoll: ["none", "when_no_call"], hedgeAfterExpiry: ["keep", "sell_if_in_profit"], afterAssignment: ["end", "continue_if_under_water"], hedgeRuleStockPnl: ["excluded", "included"], putCashIn: ["none", "when_no_call"], hedge: ["put", "none"] };
  for (const [field, allowed] of Object.entries(choices)) if (!allowed.includes(values[field] as string)) return `volFarmer.${field} must be one of ${allowed.join(", ")}.`;
  if (!isNumberIn(values.minPutProtectionPct, 0, 100)) return "volFarmer.minPutProtectionPct must be a number from 0 to 100.";
  if (!isNumberIn(values.cashInPutMinProtectionPct, 0, 100)) return "volFarmer.cashInPutMinProtectionPct must be a number from 0 to 100.";
  if (!isNumberIn(values.maxPutCostPctOfCallPremium, 0, 500)) return "volFarmer.maxPutCostPctOfCallPremium must be a number from 0 to 500.";
  return null;
}

/** Vol Farmer v2's values (BacktestVolFarmerV2Settings): null when they are valid. */
export function validateVolFarmerV2Settings(values: Record<string, unknown>): string | null {
  const isNumberIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  if (!isNumberIn(values.putsStartCallYieldPct, 0, 500)) return "volFarmerV2.putsStartCallYieldPct must be a number from 0 to 500.";
  if (!isNumberIn(values.putMaxAbsDelta, 0.01, 0.99)) return "volFarmerV2.putMaxAbsDelta must be a number from 0.01 to 0.99.";
  if (!isNumberIn(values.stepBelowFirstBreakEvenPct, 0, 90)) return "volFarmerV2.stepBelowFirstBreakEvenPct must be a number from 0 to 90.";
  if (!(volFarmerV2StepRules as readonly unknown[]).includes(values.stepRule)) return `volFarmerV2.stepRule must be one of ${volFarmerV2StepRules.join(", ")}.`;
  if (!isNumberIn(values.leapsMinDte, 30, 1000) || !Number.isInteger(values.leapsMinDte)) return "volFarmerV2.leapsMinDte must be a whole number from 30 to 1000.";
  if (!isNumberIn(values.leapsAbsDelta, 0.05, 0.99)) return "volFarmerV2.leapsAbsDelta must be a number from 0.05 to 0.99.";
  return null;
}

/** The put ladder's values (putsWhenNoCall "reserve_ladder"): null when they are valid. */
function validateLadderSettings(values: Record<string, unknown>): string | null {
  const isNumberIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  const isWholeNumberIn = (value: unknown, min: number, max: number) => isNumberIn(value, min, max) && Number.isInteger(value);
  if (!isNumberIn(values.ladderSharesPct, 1, 99)) return "baseline.ladderSharesPct must be a number from 1 to 99.";
  if (!isWholeNumberIn(values.ladderRungs, 1, 20)) return "baseline.ladderRungs must be a whole number from 1 to 20.";
  if (values.ladderShock !== "history" && values.ladderShock !== "fixed") return "baseline.ladderShock must be history or fixed.";
  for (const field of ["ladderShockPct", "ladderShockMinPct", "ladderShockMaxPct", "ladderShockNoHistoryPct"] as const) if (!isNumberIn(values[field], 1, 99)) return `baseline.${field} must be a number from 1 to 99.`;
  if ((values.ladderShockMinPct as number) > (values.ladderShockMaxPct as number)) return "baseline.ladderShockMinPct must not be above baseline.ladderShockMaxPct.";
  if (!isWholeNumberIn(values.ladderShockLookbackYears, 1, 30)) return "baseline.ladderShockLookbackYears must be a whole number of years from 1 to 30.";
  if (values.ladderTop !== "break_even" && values.ladderTop !== "price") return "baseline.ladderTop must be break_even or price.";
  if (values.ladderPace !== "any_look" && values.ladderPace !== "one_open" && values.ladderPace !== "no_puts") return "baseline.ladderPace must be any_look, one_open or no_puts.";
  if (values.ladderPutDeltaRange !== "delta_range" && values.ladderPutDeltaRange !== "none") return "baseline.ladderPutDeltaRange must be delta_range or none.";
  if (values.ladderPutVersusCall !== "call_first" && values.ladderPutVersusCall !== "higher_yield") return "baseline.ladderPutVersusCall must be call_first or higher_yield.";
  if (!isNumberIn(values.ladderPutYieldMarginPct, 0, 1000)) return "baseline.ladderPutYieldMarginPct must be a number from 0 to 1000.";
  return null;
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
  if (startingValue !== undefined && startingValue !== null) {
    if (typeof startingValue !== "number" || !Number.isFinite(startingValue) || startingValue <= 0) return { ok: false, error: "The starting account value must be a number above 0." };
    if (startingValue > maximumStartingValue) return { ok: false, error: "The starting account value is too large." };
  }

  const tablesMode = body.tablesMode;
  if (typeof tablesMode !== "string" || !tablesModes.includes(tablesMode as BacktestTablesMode)) return { ok: false, error: `tablesMode must be one of ${tablesModes.join(", ")}.` };

  const overrides = validateBacktestSettingsOverrides(body.overrides, context.snapshot, context.editablePaths);
  if (!overrides.ok) return overrides;
  const base = { name, symbols, startDate, endDate, tablesMode: tablesMode as BacktestTablesMode, overrides: overrides.overrides };

  // A lab still set to a retired decision maker starts none: the request must name another.
  const effective = applyBacktestOverrides(context.snapshot, overrides.overrides);
  if (isRetiredBacktestDecisionMaker(effective.decisionMaker)) return { ok: false, error: retiredBacktestDecisionMakerMessage };
  // Per-ticker pots and values are the baseline's; the Steady Stake and the Vol Farmers run on the session's settings and its starting value.
  if (effective.decisionMaker !== "baseline") {
    if (body.symbolSettings !== undefined && body.symbolSettings !== null) return { ok: false, error: "symbolSettings apply to the baseline only." };
    if (typeof startingValue !== "number") return { ok: false, error: "The starting account value must be a number above 0." };
    return { ok: true, value: { ...base, startingValue, bookMode: "shared_account", symbolSettings: null, symbolResolution: null, settingsSource: null, potsFromStartingValue: null }, warnings };
  }

  const settingsSource = body.settingsSource ?? "per_ticker";
  if (settingsSource !== "per_ticker" && settingsSource !== "global") return { ok: false, error: "settingsSource must be per_ticker or global." };
  const requestValues = validateRequestTickerValues(body.symbolSettings, symbols, context.editablePaths);
  if (!requestValues.ok) return requestValues;
  const resolved = resolveBacktestSymbolSettings({
    symbols,
    globalBaseline: { ...defaultBacktestBaselineSettings, ...context.snapshot.baseline },
    sessionBaseline: effective.baseline,
    sessionOverrides: overrides.overrides.baseline ?? {},
    settingsSource,
    tickerValuesFor: context.tickerValuesFor,
    requestValues: requestValues.values,
    startingValue: typeof startingValue === "number" ? startingValue : null,
    defaultPotDollars: context.defaultPotDollars,
  });
  if (!resolved.ok) return resolved;
  const tickerProblem = firstTickerProblem(resolved.bySymbol);
  if (tickerProblem !== null || resolved.capital === null) return { ok: false, error: tickerProblem ?? "A ticker has no pot.", symbolResolution: { capital: resolved.capital, bySymbol: resolved.bySymbol }, warnings };
  return { ok: true, value: { ...base, startingValue: resolved.capital, bookMode: "pots", symbolSettings: storedSymbolSettings(resolved.bySymbol), symbolResolution: resolved.bySymbol, settingsSource, potsFromStartingValue: typeof startingValue === "number" }, warnings };
}

const isTickerBaselineKey = (key: string): key is BacktestTickerBaselineKey => (backtestTickerBaselineKeys as readonly string[]).includes(key);

/** The request's symbolSettings: keyed by the session's symbols (normalized), each a pot above 0 and per-ticker baseline values only. Their values are checked once merged. */
function validateRequestTickerValues(raw: unknown, symbols: readonly string[], editablePaths: ReadonlySet<string>): { ok: true; values: Record<string, BacktestTickerValues> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, values: {} };
  if (!isPlainObject(raw)) return { ok: false, error: "symbolSettings must be an object of symbols." };
  const values: Record<string, BacktestTickerValues> = {};
  for (const [givenSymbol, given] of Object.entries(raw)) {
    let symbol: string;
    try {
      symbol = normalizeBacktestSymbol(givenSymbol);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!symbols.includes(symbol)) return { ok: false, error: `symbolSettings.${givenSymbol}: ${symbol} is not one of the session's symbols.` };
    if (!isPlainObject(given)) return { ok: false, error: `symbolSettings.${symbol} must be an object.` };
    const unknownKey = Object.keys(given).find((key) => key !== "potDollars" && key !== "baseline");
    if (unknownKey) return { ok: false, error: `symbolSettings.${symbol}.${unknownKey} is not a ticker value (potDollars or baseline).` };
    const tickerValues: BacktestTickerValues = {};
    if (given.potDollars !== undefined) {
      const pot = given.potDollars;
      if (typeof pot !== "number" || !Number.isFinite(pot) || pot <= 0 || pot > maximumStartingValue) return { ok: false, error: `symbolSettings.${symbol}.potDollars must be a number above 0.` };
      tickerValues.potDollars = pot;
    }
    if (given.baseline !== undefined) {
      if (!isPlainObject(given.baseline)) return { ok: false, error: `symbolSettings.${symbol}.baseline must be an object.` };
      const sessionWide = Object.keys(given.baseline).find((key) => !isTickerBaselineKey(key));
      if (sessionWide) return { ok: false, error: `baseline.${sessionWide} cannot differ between tickers: change it for the whole session.` };
      const notEditable = Object.keys(given.baseline).find((key) => !editablePaths.has(`baseline.${key}`));
      if (notEditable) return { ok: false, error: `baseline.${notEditable} cannot be changed for a session.` };
      tickerValues.baseline = given.baseline as Partial<BacktestTickerBaselineSettings>;
    }
    values[symbol] = tickerValues;
  }
  return { ok: true, values };
}

/**
 * Each ticker's pot, weight and baseline values in a session of per-ticker pots (approved by Marcelo 2026-10-15). A
 * value comes from, last one given winning: the lab's global values < the ticker's lab values (settingsSource
 * "per_ticker") < the request's session-wide overrides < the request's values for the ticker. Pots: a starting value
 * splits equally (pot = starting value ÷ tickers); without one, the request's pot, else the ticker's lab pot
 * ("per_ticker"), else the lab's default pot. w = pot ÷ Σ pots; the session's capital is Σ pots.
 */
export function resolveBacktestSymbolSettings(input: {
  symbols: readonly string[];
  /** The lab's global values, every default filled in. */
  globalBaseline: BacktestBaselineSettings;
  /** The global values with the session-wide overrides: every value the tickers share. */
  sessionBaseline: BacktestBaselineSettings;
  /** Only the values the request changes for the whole session. */
  sessionOverrides: Partial<BacktestBaselineSettings>;
  settingsSource: BacktestSettingsSource;
  tickerValuesFor: (symbol: string) => BacktestTickerValues | null;
  requestValues: Record<string, BacktestTickerValues>;
  startingValue: number | null;
  defaultPotDollars: number | null;
}): { ok: true; bySymbol: Record<string, BacktestSymbolResolution>; capital: number | null } | { ok: false; error: string } {
  const { symbols, globalBaseline, sessionBaseline, sessionOverrides, settingsSource, requestValues, startingValue, defaultPotDollars } = input;
  if (startingValue !== null) {
    const withPot = symbols.find((symbol) => requestValues[symbol]?.potDollars !== undefined);
    if (withPot) return { ok: false, error: `Give either a starting value (split equally) or each ticker's pot, not both (${withPot} has a pot).` };
  }
  const tickers: Omit<BacktestSymbolResolution, "weight">[] = [];
  for (const symbol of symbols) {
    const fromLab = settingsSource === "per_ticker" ? input.tickerValuesFor(symbol) : null;
    const fromRequest = requestValues[symbol] ?? null;
    const baseline = {} as Record<BacktestTickerBaselineKey, unknown>;
    const source = {} as BacktestSymbolResolution["source"];
    const fallback: BacktestSymbolResolution["fallback"] = {};
    for (const key of backtestTickerBaselineKeys) {
      // Each layer given, lowest first; the last one wins and the one before it is where a reset returns.
      const layers: [BacktestSymbolSettingSource, unknown][] = [["global", globalBaseline[key]]];
      for (const [layer, value] of [["ticker", fromLab?.baseline?.[key]], ["session", sessionOverrides[key]], ["request", fromRequest?.baseline?.[key]]] as const) if (value !== undefined) layers.push([layer, value]);
      const [winner, below] = [layers.at(-1)!, layers.at(-2)];
      [source[key], baseline[key]] = winner;
      if (below) fallback[key] = { value: below[1] as number | string, source: below[0] };
    }
    const tickerBaseline = baseline as BacktestTickerBaselineSettings;
    const problems: BacktestTickerProblem[] = [];
    const problem = validateBaselineSettings({ ...sessionBaseline, ...tickerBaseline });
    if (problem) problems.push({ key: /^baseline\.(\w+)/.exec(problem)?.[1] ?? null, message: problem });
    let potDollars: number | null = null;
    if (startingValue !== null) [potDollars, source.potDollars] = [startingValue / symbols.length, "session"];
    else {
      const potLayers: [BacktestSymbolSettingSource, number][] = [];
      if (defaultPotDollars !== null) potLayers.push(["global", defaultPotDollars]);
      if (fromLab?.potDollars !== undefined) potLayers.push(["ticker", fromLab.potDollars]);
      if (fromRequest?.potDollars !== undefined) potLayers.push(["request", fromRequest.potDollars]);
      const [winner, below] = [potLayers.at(-1), potLayers.at(-2)];
      if (winner) [source.potDollars, potDollars] = winner;
      else {
        source.potDollars = "global";
        problems.push({ key: "potDollars", message: `${symbol} has no pot: give the session a starting value or the ticker a pot.` });
      }
      if (below) fallback.potDollars = { value: below[1], source: below[0] };
    }
    tickers.push({ potDollars, baseline: tickerBaseline, source, fallback, problems });
  }
  const everyPot = tickers.every((ticker) => ticker.potDollars !== null);
  const capital = startingValue ?? (everyPot ? tickers.reduce((sum, ticker) => sum + ticker.potDollars!, 0) : null);
  if (capital !== null && capital > maximumStartingValue) return { ok: false, error: "The pots add up to too large a starting account value." };
  const bySymbol = Object.fromEntries(symbols.map((symbol, index) => [symbol, { ...tickers[index]!, weight: capital === null ? null : tickers[index]!.potDollars! / capital }]));
  return { ok: true, bySymbol, capital };
}

/** The first ticker problem as the create route words it ("HOOD: baseline.ladderRungs must be …", "HOOD has no pot: …"); null when every ticker can run. */
export function firstTickerProblem(bySymbol: Record<string, BacktestSymbolResolution>): string | null {
  for (const [symbol, resolution] of Object.entries(bySymbol)) {
    const problem = resolution.problems[0];
    if (problem) return problem.key === "potDollars" ? problem.message : `${symbol}: ${problem.message}`;
  }
  return null;
}

/** The settings a session stores per ticker: the resolution of a request whose tickers can all run. */
export function storedSymbolSettings(bySymbol: Record<string, BacktestSymbolResolution>): Record<string, BacktestSymbolSettings> {
  return Object.fromEntries(Object.entries(bySymbol).map(([symbol, { potDollars, weight, baseline, source }]) => [symbol, { potDollars: potDollars!, weight: weight!, baseline, source }]));
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

/** A query parameter's text, trimmed; null when it is absent or blank. */
function queryText(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The query's symbol filter, normalized; null when absent. */
function validateSymbolQuery(raw: Record<string, unknown>): { ok: true; symbol: string | null } | { ok: false; error: string } {
  const symbol = queryText(raw, "symbol");
  if (symbol === null) return { ok: true, symbol: null };
  try {
    return { ok: true, symbol: normalizeBacktestSymbol(symbol) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The query's page: `limit` (1 to `maxLimit`, `defaultLimit` unless given) and `offset` (0 unless given). */
function validatePageQuery(raw: Record<string, unknown>, defaultLimit: number, maxLimit: number): { ok: true; limit: number; offset: number } | { ok: false; error: string } {
  const wholeNumber = (key: "limit" | "offset", fallback: number, minimum: number, maximum: number): number | null => {
    const text = queryText(raw, key);
    if (text === null) return fallback;
    const value = Number(text);
    return Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;
  };
  const limit = wholeNumber("limit", defaultLimit, 1, maxLimit);
  if (limit === null) return { ok: false, error: `limit must be a whole number from 1 to ${maxLimit}.` };
  const offset = wholeNumber("offset", 0, 0, Number.MAX_SAFE_INTEGER);
  if (offset === null) return { ok: false, error: "offset must be a whole number from 0." };
  return { ok: true, limit, offset };
}

/**
 * Validation of the query of GET /backtest/sessions/:id/actions and /fills (BacktestBookPageQuery): trading dates from
 * and to (inclusive), a symbol, the actions' outcome, and the page (limit 200 unless given, at most 1,000; offset 0).
 */
export function validateBacktestBookPageQuery(raw: Record<string, unknown>, options: { outcomeAllowed: boolean }): { ok: true; filters: BacktestBookPageFilters } | { ok: false; error: string } {
  const from = queryText(raw, "from");
  const to = queryText(raw, "to");
  for (const [key, value] of [["from", from], ["to", to]] as const) if (value !== null && !isIsoCalendarDate(value)) return { ok: false, error: `${key} must be a date (YYYY-MM-DD).` };
  if (from !== null && to !== null && from > to) return { ok: false, error: "from must be on or before to." };
  const symbol = validateSymbolQuery(raw);
  if (!symbol.ok) return symbol;
  const outcome = queryText(raw, "outcome");
  if (outcome !== null) {
    if (!options.outcomeAllowed) return { ok: false, error: "outcome filters actions only." };
    if (outcome !== "filled" && outcome !== "blocked") return { ok: false, error: "outcome must be filled or blocked." };
  }
  const page = validatePageQuery(raw, backtestBookPageDefaultLimit, backtestBookPageMaxLimit);
  if (!page.ok) return page;
  return { ok: true, filters: { from, to, symbol: symbol.symbol, outcome: outcome as BacktestBookPageFilters["outcome"], limit: page.limit, offset: page.offset } };
}

/** The filters of a page of the Sessions list, every default filled in. */
export interface BacktestSessionsPageFilters {
  /** Matches any part of the name, ignoring case. */
  search: string | null;
  symbol: string | null;
  status: BacktestSessionStatusFilter | null;
  limit: number;
  offset: number;
}

const sessionStatusFilters: readonly BacktestSessionStatusFilter[] = ["succeeded", "running", "failed", "cancelled"];

/**
 * Validation of the query of GET /backtest/sessions (BacktestSessionsPageQuery): a name search, a symbol, a status
 * ("running" also matches a queued session), and the page (limit 50 unless given, at most 200; offset 0).
 */
export function validateBacktestSessionsPageQuery(raw: Record<string, unknown>): { ok: true; filters: BacktestSessionsPageFilters } | { ok: false; error: string } {
  const symbol = validateSymbolQuery(raw);
  if (!symbol.ok) return symbol;
  const status = queryText(raw, "status");
  if (status !== null && !sessionStatusFilters.includes(status as BacktestSessionStatusFilter)) return { ok: false, error: "status must be succeeded, running, failed or cancelled." };
  const page = validatePageQuery(raw, backtestSessionsPageDefaultLimit, backtestSessionsPageMaxLimit);
  if (!page.ok) return page;
  return { ok: true, filters: { search: queryText(raw, "search"), symbol: symbol.symbol, status: status as BacktestSessionStatusFilter | null, limit: page.limit, offset: page.offset } };
}
