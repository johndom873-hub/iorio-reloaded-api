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
  activeBacktestDecisionMakers,
  defaultBacktestBaselineSettings,
  defaultBacktestSteadyStakeSettings,
  defaultBacktestVolFarmerV4Settings,
  volFarmerV2LooksChoices,
  volFarmerV3CallStrikeFloorChoices,
  volFarmerV3PutsSoldChoices,
  volFarmerV3PutStrikeCapChoices,
  volFarmerV3TrimsSellChoices,
  volFarmerV3CallsInTheMoneyAtLastLookChoices,
  volFarmerV3FirstPositionAfterCalledAwayChoices,
  volFarmerV3OptionsExpiryChoices,
  volFarmerV3RebalancesChoices,
  volFarmerV2StepRules,
  type BacktestBaselineSettings,
  type BacktestBookMode,
  type BacktestSessionStatusFilter,
  type BacktestSettings,
  type BacktestSettingsOverrides,
  type BacktestSettingsSource,
  type BacktestSteadyStakeSettings,
  type BacktestVolFarmerV4Settings,
  type BacktestSymbolResolution,
  type BacktestSymbolSettings,
  type BacktestTablesMode,
  isRetiredBacktestDecisionMaker,
  retiredBacktestDecisionMakerMessage,
  retiredBacktestDecisionMakers,
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
}

export interface ValidatedBacktestSessionRequest {
  name: string;
  /** One or more, normalized, without repeats, in the order given. */
  symbols: string[];
  startDate: string;
  endDate: string;
  /** The session's capital: the starting value given. */
  startingValue: number;
  tablesMode: BacktestTablesMode;
  /** Only the values that differ from the snapshot. */
  overrides: BacktestSettingsOverrides;
  /** Always "shared_account" now: "pots" was the retired CC + Put Ladder's, read back from its past sessions only. */
  bookMode: BacktestBookMode;
  /** The CC + Put Ladder's per-ticker pots and values: null for every new session (the columns stay for past ones). */
  symbolSettings: Record<string, BacktestSymbolSettings> | null;
  symbolResolution: Record<string, BacktestSymbolResolution> | null;
  settingsSource: BacktestSettingsSource | null;
  potsFromStartingValue: boolean | null;
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

/**
 * A session's overrides, checked against the snapshot: only the changed values are kept. The policy, the model and the
 * Kelly fraction were the retired rules sessions' and are no longer settings a session can change.
 */
export function validateBacktestSettingsOverrides(raw: unknown, snapshot: BacktestSettings, editablePaths: ReadonlySet<string>): { ok: true; overrides: BacktestSettingsOverrides } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, overrides: {} };
  if (!isPlainObject(raw)) return { ok: false, error: "overrides must be an object." };
  const unknownSection = Object.keys(raw).find((key) => key !== "pluto" && key !== "trading" && key !== "decisionMaker" && key !== "baseline" && key !== "steadyStake" && key !== "volFarmer" && key !== "volFarmerV2" && key !== "volFarmerV3" && key !== "volFarmerV4");
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

  // The retired decision makers' sections (the original Vol Farmer's, v2's and v3's) take no change.
  for (const section of ["volFarmer", "volFarmerV2", "volFarmerV3"] as const) {
    const values = raw[section];
    if (values === undefined) continue;
    if (!isPlainObject(values)) return { ok: false, error: `overrides.${section} must be an object.` };
    const field = Object.keys(values)[0];
    if (field !== undefined) return { ok: false, error: `${section}.${field} cannot be changed for a session.` };
  }

  // Every Vol Farmer v4 value can change for a session.
  if (raw.volFarmerV4 !== undefined) {
    if (!isPlainObject(raw.volFarmerV4)) return { ok: false, error: "overrides.volFarmerV4 must be an object." };
    const snapshotVolFarmerV4 = { ...defaultBacktestVolFarmerV4Settings, ...snapshot.volFarmerV4 };
    const unknownField = Object.keys(raw.volFarmerV4).find((field) => !(field in defaultBacktestVolFarmerV4Settings));
    if (unknownField) return { ok: false, error: `volFarmerV4.${unknownField} is not a Vol Farmer v4 setting.` };
    const problem = validateVolFarmerV4Settings({ ...snapshotVolFarmerV4, ...raw.volFarmerV4 });
    if (problem) return { ok: false, error: problem };
    const changed = changedEntries(snapshotVolFarmerV4, raw.volFarmerV4);
    if (Object.keys(changed).length > 0) overrides.volFarmerV4 = changed as Partial<BacktestVolFarmerV4Settings>;
  }

  if (raw.decisionMaker !== undefined) {
    if ((retiredBacktestDecisionMakers as readonly unknown[]).includes(raw.decisionMaker)) return { ok: false, error: retiredBacktestDecisionMakerMessage };
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

/** Vol Farmer v2's values (BacktestVolFarmerV2Settings), under `section` (v4 has them too): null when they are valid. */
export function validateVolFarmerV2Settings(values: Record<string, unknown>, section: "volFarmerV2" | "volFarmerV4" = "volFarmerV2"): string | null {
  const isNumberIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  if (!isNumberIn(values.firstPositionPct, 10, 90)) return `${section}.firstPositionPct must be a number from 10 to 90.`;
  if (!isNumberIn(values.putsStartCallYieldPct, 0, 500)) return `${section}.putsStartCallYieldPct must be a number from 0 to 500.`;
  if (!isNumberIn(values.putMaxAbsDelta, 0.01, 0.99)) return `${section}.putMaxAbsDelta must be a number from 0.01 to 0.99.`;
  if (!isNumberIn(values.stepBelowFirstBreakEvenPct, 0, 90)) return `${section}.stepBelowFirstBreakEvenPct must be a number from 0 to 90.`;
  if (!(volFarmerV2StepRules as readonly unknown[]).includes(values.stepRule)) return `${section}.stepRule must be one of ${volFarmerV2StepRules.join(", ")}.`;
  if (!isNumberIn(values.leapsMinDte, 30, 1000) || !Number.isInteger(values.leapsMinDte)) return `${section}.leapsMinDte must be a whole number from 30 to 1000.`;
  if (!isNumberIn(values.leapsAbsDelta, 0.05, 0.99)) return `${section}.leapsAbsDelta must be a number from 0.05 to 0.99.`;
  if (!isNumberIn(values.leapsMaxAccountPct, 0, 100)) return `${section}.leapsMaxAccountPct must be a number from 0 to 100.`;
  if (!isNumberIn(values.leapsSpreadCostChargedPct, 0, 100)) return `${section}.leapsSpreadCostChargedPct must be a number from 0 to 100.`;
  if (!(volFarmerV2LooksChoices as readonly unknown[]).includes(values.looks)) return `${section}.looks must be one of ${volFarmerV2LooksChoices.join(", ")}.`;
  if (!isNumberIn(values.excessAllowancePct, 0, 1000)) return `${section}.excessAllowancePct must be a number from 0 to 1000.`;
  const allocations = values.tickerAllocationPct;
  if (!isPlainObject(allocations)) return `${section}.tickerAllocationPct must be an object of symbols.`;
  const notAnAllocation = Object.entries(allocations).find(([, value]) => !isNumberIn(value, 0, 100) || value === 0);
  if (notAnAllocation) return `${section}.tickerAllocationPct.${notAnAllocation[0]} must be a number above 0 and at most 100.`;
  const setTotal = Object.values(allocations).reduce<number>((total, value) => total + (value as number), 0);
  if (setTotal > 100 + 1e-9) return `${section}.tickerAllocationPct: the set allocations add up to ${Number(setTotal.toFixed(4))}%, at most 100%.`;
  return null;
}

/** Vol Farmer v3's own values (BacktestVolFarmerV3Settings), under `section` (v4 has them too): null when they are valid. */
export function validateVolFarmerV3Settings(values: Record<string, unknown>, section: "volFarmerV3" | "volFarmerV4" = "volFarmerV3"): string | null {
  const rebalanceBandPct = values.rebalanceBandPct;
  if (typeof rebalanceBandPct !== "number" || !Number.isFinite(rebalanceBandPct) || rebalanceBandPct < 0 || rebalanceBandPct > 50) return `${section}.rebalanceBandPct must be a number from 0 to 50.`;
  if (!(volFarmerV3RebalancesChoices as readonly unknown[]).includes(values.rebalances)) return `${section}.rebalances must be one of ${volFarmerV3RebalancesChoices.join(", ")}.`;
  if (!(volFarmerV3FirstPositionAfterCalledAwayChoices as readonly unknown[]).includes(values.firstPositionAfterCalledAway)) return `${section}.firstPositionAfterCalledAway must be one of ${volFarmerV3FirstPositionAfterCalledAwayChoices.join(", ")}.`;
  if (!(volFarmerV3OptionsExpiryChoices as readonly unknown[]).includes(values.optionsExpiry)) return `${section}.optionsExpiry must be one of ${volFarmerV3OptionsExpiryChoices.join(", ")}.`;
  const optionsMaxDaysToExpiry = values.optionsMaxDaysToExpiry;
  if (typeof optionsMaxDaysToExpiry !== "number" || !Number.isInteger(optionsMaxDaysToExpiry) || optionsMaxDaysToExpiry < 1 || optionsMaxDaysToExpiry > 45) return `${section}.optionsMaxDaysToExpiry must be a whole number from 1 to 45.`;
  if (!(volFarmerV3CallStrikeFloorChoices as readonly unknown[]).includes(values.callStrikeFloor)) return `${section}.callStrikeFloor must be one of ${volFarmerV3CallStrikeFloorChoices.join(", ")}.`;
  if (!(volFarmerV3PutsSoldChoices as readonly unknown[]).includes(values.putsSold)) return `${section}.putsSold must be one of ${volFarmerV3PutsSoldChoices.join(", ")}.`;
  if (!(volFarmerV3PutStrikeCapChoices as readonly unknown[]).includes(values.putStrikeCap)) return `${section}.putStrikeCap must be one of ${volFarmerV3PutStrikeCapChoices.join(", ")}.`;
  if (!(volFarmerV3TrimsSellChoices as readonly unknown[]).includes(values.trimsSell)) return `${section}.trimsSell must be one of ${volFarmerV3TrimsSellChoices.join(", ")}.`;
  const topUpCapPctOfPot = values.topUpCapPctOfPot;
  if (typeof topUpCapPctOfPot !== "number" || !Number.isFinite(topUpCapPctOfPot) || topUpCapPctOfPot < 0 || topUpCapPctOfPot > 1000) return `${section}.topUpCapPctOfPot must be a number from 0 to 1000.`;
  if (!(volFarmerV3CallsInTheMoneyAtLastLookChoices as readonly unknown[]).includes(values.callsInTheMoneyAtLastLook)) return `${section}.callsInTheMoneyAtLastLook must be one of ${volFarmerV3CallsInTheMoneyAtLastLookChoices.join(", ")}.`;
  return null;
}

/** Vol Farmer v4's values (BacktestVolFarmerV4Settings): its Calls' range and spread limit, then v2's and v3's values. Null when they are valid. */
export function validateVolFarmerV4Settings(values: Record<string, unknown>): string | null {
  const isNumberIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  for (const field of ["callMinAbsDelta", "callMaxAbsDelta"] as const) if (!isNumberIn(values[field], 0.01, 0.99)) return `volFarmerV4.${field} must be a number from 0.01 to 0.99.`;
  if ((values.callMinAbsDelta as number) > (values.callMaxAbsDelta as number)) return "volFarmerV4.callMinAbsDelta must not be above volFarmerV4.callMaxAbsDelta.";
  if (!isNumberIn(values.maxSpreadPctOfMid, 1, 200)) return "volFarmerV4.maxSpreadPctOfMid must be a number from 1 to 200.";
  return validateVolFarmerV2Settings(values, "volFarmerV4") ?? validateVolFarmerV3Settings(values, "volFarmerV4");
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
  // Every decision maker still offered runs one shared account on the session's starting value; per-ticker pots and
  // values were the CC + Put Ladder's.
  if (body.symbolSettings !== undefined && body.symbolSettings !== null) return { ok: false, error: "symbolSettings were the CC + Put Ladder's per-ticker values, retired on 2 Nov 2026." };
  if (typeof startingValue !== "number") return { ok: false, error: "The starting account value must be a number above 0." };
  // Vol Farmer v4's set allocations name the session's tickers.
  if (effective.decisionMaker === "vol_farmer_v4") {
    const stranger = Object.keys({ ...defaultBacktestVolFarmerV4Settings, ...effective.volFarmerV4 }.tickerAllocationPct).find((symbol) => !symbols.includes(symbol));
    if (stranger !== undefined) return { ok: false, error: `volFarmerV4.tickerAllocationPct.${stranger}: ${stranger} is not one of the session's symbols.` };
  }
  return { ok: true, value: { ...base, startingValue, bookMode: "shared_account", symbolSettings: null, symbolResolution: null, settingsSource: null, potsFromStartingValue: null }, warnings };
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
