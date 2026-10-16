import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { BacktestBaselineSettings } from "../backtest/backtestTypes.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { ensurePlutoSettingsVersion } from "./settingsVersions.js";
import { loadLadderRecommendedShock, type LadderRecommendedShock } from "./ladderRecommendedShock.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, loadPlutoTickerSettings, type PlutoTickerSettings } from "./tickerSettingsStore.js";

// The CC + Put Ladder's settings for one ticker, in the backtest's names and units, so the live ladder, the ticker
// configuration screen and the Backtesting screen's Analyse modal read the same values and can hand them straight to
// the backtest engine's functions.

/**
 * The choices the strategy's design fixes (adopted 2026-10-14/15, PROGRESS.md "Pluto execution strategies" and
 * "Ladder: a Put when its yield beats the Call's"): code, not settings, so no one turns the ladder into an untested
 * variant from a screen. The tunable values come from pluto_settings and pluto_ticker_settings.
 */
export const ladderFixedBaselineChoices = {
  entry: "covered_call",
  callStrike: "above_break_even",
  entryCallStrike: "any",
  entryWhenSharesUncovered: "buy",
  callDeltaRange: "entry_range",
  ranking: "premium_yield",
  expiryChoice: "any_in_range",
  coverage: "fill_down_ranking",
  earnings: "ignore",
  putsWhenNoCall: "reserve_ladder",
  ladderShock: "history",
  ladderTop: "price",
  ladderPace: "any_look",
  ladderPutVersusCall: "higher_yield",
  ladderPutYieldMarginPct: 0,
  // The |delta| range is the Calls' (Marcelo 2026-10-16): the ladder's Puts go by the rung's cap.
  ladderPutDeltaRange: "none",
  dayValueOptions: "marked",
  takeProfitPct: 0,
  shareStopLossPct: 0,
  maxSharesPctOfAccount: 100,
  maxAccountPctPerStock: 100,
  minCallYieldPct: 0,
  volatilityEdgeFilter: "off",
  looks: "every_look",
} as const satisfies Partial<BacktestBaselineSettings>;

export type LadderBaselineSettings = typeof ladderFixedBaselineChoices &
  Pick<BacktestBaselineSettings, "minAbsDelta" | "maxAbsDelta" | "minDte" | "maxDte" | "maxSpreadPctOfMid" | "ladderRungs" | "ladderSharesPct" | "ladderShockMinPct" | "ladderShockMaxPct" | "ladderShockNoHistoryPct" | "ladderShockLookbackYears">;

export interface LadderTickerSettings {
  symbol: string;
  /** "live": read from Pluto's settings. ("preset" was the stand-in before they existed; kept in the type for the Analyse modal.) */
  source: "live" | "preset";
  /** The ticker is enabled in Pluto and Pluto's active strategy is the CC + Put Ladder. */
  enabled: boolean;
  /** The Pluto settings version these values come from (the one a pass would record). */
  settingsVersionId: string | null;
  /** The ticker's effective values, backtest names and units: each its override where the ticker has one, else the strategy's. */
  baseline: LadderBaselineSettings;
  /** The strategy-wide values alone (no ticker override), for "reset to the strategy value". */
  strategyBaseline: LadderBaselineSettings;
  /** What the ticker overrides, backtest names and units; null = the strategy's value. The shock and allocation are below. */
  tickerOverrides: LadderTickerOverrides;
  /** The ticker's set allocation, % of Pluto's capital budget; null = an equal share (effectiveAllocationPctBySymbol). */
  allocationPct: number | null;
  /**
   * The ticker's pot in dollars, while it is enabled in Pluto: allocation (effective) × Pluto's capital budget at last
   * night's account value. Null when the ticker is not enabled or no account value is recorded. Pots are percentages,
   * recomputed from the account value, with no ledger of their own (Marcelo 2026-10-15).
   */
  potDollars: number | null;
  /** The user's shock; null = the recommended one (computed from the stock's Max drawdown by the backtest's rule). */
  overrideShockPct: number | null;
  /** The shock the system recommends today from the stored daily closes (ladderRecommendedShock.ts); null for an unknown ticker. */
  recommendedShockPct: number | null;
}

/** A ticker's overrides of the strategy's values (pluto_ticker_settings), in backtest names; null = the strategy's value. */
export interface LadderTickerOverrides {
  ladderSharesPct: number | null;
  ladderRungs: number | null;
  minAbsDelta: number | null;
  maxAbsDelta: number | null;
}

export const noLadderTickerOverrides: LadderTickerOverrides = { ladderSharesPct: null, ladderRungs: null, minAbsDelta: null, maxAbsDelta: null };

/** The ladder's values in backtest form: the strategy's, each replaced by the ticker's override where it has one. Pure. */
export function ladderBaselineFromPlutoSettings(settings: PlutoSettings, overrides: LadderTickerOverrides = noLadderTickerOverrides): LadderBaselineSettings {
  return {
    ...ladderFixedBaselineChoices,
    minAbsDelta: overrides.minAbsDelta ?? settings.ladderMinAbsDelta,
    maxAbsDelta: overrides.maxAbsDelta ?? settings.ladderMaxAbsDelta,
    minDte: settings.ladderMinDte,
    maxDte: settings.ladderMaxDte,
    maxSpreadPctOfMid: settings.ladderMaxSpreadPctOfMid,
    ladderRungs: overrides.ladderRungs ?? settings.ladderRungs,
    ladderSharesPct: overrides.ladderSharesPct ?? settings.ladderSharesPct,
    ladderShockMinPct: settings.ladderShockMinPct,
    ladderShockMaxPct: settings.ladderShockMaxPct,
    ladderShockNoHistoryPct: settings.ladderShockNoHistoryPct,
    ladderShockLookbackYears: settings.ladderShockLookbackYears,
  };
}

/** What every ticker's settings read in common: Pluto's settings, its version, the enabled tickers and last night's account value. */
interface LadderSettingsContext {
  settings: PlutoSettings;
  settingsVersionId: string;
  enabledTickers: PlutoTickerSettings[];
  /** Last night's account value; null when none is recorded. */
  accountValue: number | null;
}

async function loadLadderSettingsContext(connection: Knex): Promise<LadderSettingsContext> {
  const [settings, enabledTickers, lastSnapshot] = await Promise.all([
    loadPlutoSettings(connection),
    loadEnabledPlutoTickerSettings(connection),
    connection("account_pnl_snapshots").whereNotNull("net_liquidation_value").orderBy("snapshot_date", "desc").first("net_liquidation_value"),
  ]);
  return { settings, settingsVersionId: await ensurePlutoSettingsVersion(settings, connection), enabledTickers, accountValue: lastSnapshot ? Number(lastSnapshot.net_liquidation_value) : null };
}

function ladderTickerSettingsFrom(symbol: string, context: LadderSettingsContext, tickerSettings: PlutoTickerSettings | null, recommendedShock: LadderRecommendedShock | null): LadderTickerSettings {
  const { settings, enabledTickers, accountValue } = context;
  const tickerOverrides: LadderTickerOverrides = {
    ladderSharesPct: tickerSettings?.ladderSharesPct ?? null,
    ladderRungs: tickerSettings?.ladderRungs ?? null,
    minAbsDelta: tickerSettings?.ladderMinAbsDelta ?? null,
    maxAbsDelta: tickerSettings?.ladderMaxAbsDelta ?? null,
  };
  const enabledInPluto = enabledTickers.some((ticker) => ticker.symbol === symbol);
  const allocationEffectivePct = effectiveAllocationPctBySymbol(enabledTickers).get(symbol);
  const potDollars = enabledInPluto && allocationEffectivePct !== undefined && accountValue !== null ? (accountValue * (settings.capitalBudgetPct / 100) * allocationEffectivePct) / 100 : null;
  return {
    symbol,
    source: "live",
    enabled: enabledInPluto && settings.executionStrategy === "cc_put_ladder",
    settingsVersionId: context.settingsVersionId,
    baseline: ladderBaselineFromPlutoSettings(settings, tickerOverrides),
    strategyBaseline: ladderBaselineFromPlutoSettings(settings),
    tickerOverrides,
    allocationPct: tickerSettings?.allocationPct ?? null,
    potDollars,
    overrideShockPct: tickerSettings?.ladderShockOverridePct ?? null,
    recommendedShockPct: recommendedShock?.recommendedShockPct ?? null,
  };
}

/** The ladder's settings for `symbol`; a symbol that is not a known ticker gets the strategy values only. */
export async function loadLadderSettingsForTicker(symbol: string, connection: Knex = db): Promise<LadderTickerSettings> {
  const normalizedSymbol = symbol.toUpperCase();
  const [context, tickerSettings] = await Promise.all([loadLadderSettingsContext(connection), loadPlutoTickerSettings(normalizedSymbol, connection)]);
  const recommendedShock = await loadLadderRecommendedShock(normalizedSymbol, context.settings, easternIsoDate(new Date()), connection);
  return ladderTickerSettingsFrom(normalizedSymbol, context, tickerSettings, recommendedShock);
}

/** A ticker's ladder settings as the Pluto screen shows them: plus the fit checks' price, the budget in dollars and where the recommended shock comes from. */
export interface LadderTickerScreenSettings extends LadderTickerSettings {
  /** The last daily close and its date: the price the fit checks use (Marcelo 2026-10-15). Null without daily bars. */
  lastClose: { price: number; date: string } | null;
  /** Pluto's capital budget in dollars at last night's account value; null when none is recorded. */
  capitalBudgetDollars: number | null;
  /** What the recommended shock was computed from; null for an unknown ticker. */
  recommendedShockSource: Omit<LadderRecommendedShock, "recommendedShockPct"> | null;
}

async function loadLastClose(symbol: string, connection: Knex): Promise<{ price: number; date: string } | null> {
  const row: { date: string; close: string } | undefined = await connection("daily_price_bars as b")
    .join("tickers as t", "t.id", "b.ticker_id")
    .where("t.symbol", symbol)
    .whereNotNull("b.close_price")
    .orderBy("b.trading_date", "desc")
    .first(connection.raw("b.trading_date::text as date"), "b.close_price as close");
  return row ? { price: Number(row.close), date: row.date } : null;
}

/** The screen's settings for each of `symbols` (upper case); the shared reads are made once. */
export async function loadLadderScreenSettings(symbols: readonly string[], connection: Knex = db): Promise<LadderTickerScreenSettings[]> {
  const context = await loadLadderSettingsContext(connection);
  const todayIso = easternIsoDate(new Date());
  const capitalBudgetDollars = context.accountValue === null ? null : (context.accountValue * context.settings.capitalBudgetPct) / 100;
  return Promise.all(
    symbols.map(async (symbol) => {
      const [tickerSettings, recommendedShock, lastClose] = await Promise.all([loadPlutoTickerSettings(symbol, connection), loadLadderRecommendedShock(symbol, context.settings, todayIso, connection), loadLastClose(symbol, connection)]);
      const recommendedShockSource = recommendedShock && { maxDrawdownPct: recommendedShock.maxDrawdownPct, closesUsed: recommendedShock.closesUsed, fromIso: recommendedShock.fromIso, toIso: recommendedShock.toIso };
      return { ...ladderTickerSettingsFrom(symbol, context, tickerSettings, recommendedShock), lastClose, capitalBudgetDollars, recommendedShockSource };
    }),
  );
}
