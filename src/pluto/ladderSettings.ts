import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { BacktestBaselineSettings } from "../backtest/backtestTypes.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { ensurePlutoSettingsVersion } from "./settingsVersions.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, loadPlutoTickerSettings } from "./tickerSettingsStore.js";

// The CC + Put Ladder's settings for one ticker, in the backtest's names and units, so the live ladder, the ticker
// configuration screen and the Backtesting screen's Analyse modal read the same values and can hand them straight to
// the backtest engine's functions.

/**
 * The choices the strategy's design fixes (adopted 2026-10-14/15, PROGRESS.md "Pluto execution strategies" and
 * "Ladder: a Put when its yield beats the Call's"): code, not settings, so no one turns the ladder into an untested
 * variant from a screen. The tunable values come from pluto_settings and pluto_ticker_settings.
 */
export const ladderFixedBaselineChoices = {
  entry: "buy_write",
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
  ladderMinutesBetweenRungs: 0,
  ladderMaxRungsPerSession: 0,
  ladderPutVersusCall: "higher_yield",
  ladderPutYieldMarginPct: 0,
  shareFill: "plus_one_cent",
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
  /** Backtest names and units; the share level is the ticker's override, else the strategy default. */
  baseline: LadderBaselineSettings;
  /** The ticker's set allocation, % of Pluto's capital budget; null = an equal share (effectiveAllocationPctBySymbol). */
  allocationPct: number | null;
  /**
   * The ticker's pot in dollars, while it is enabled in Pluto: allocation (effective) × Pluto's capital budget at last
   * night's account value. Null when the ticker is not enabled or no account value is recorded. Becomes the pot's own
   * ledger value once the pot ledger exists.
   */
  potDollars: number | null;
  /** The user's shock; null = the recommended one (computed from the stock's Max drawdown by the backtest's rule). */
  overrideShockPct: number | null;
}

/** The strategy-wide ladder values in backtest form, with the given share level. Pure. */
export function ladderBaselineFromPlutoSettings(settings: PlutoSettings, sharesPct: number): LadderBaselineSettings {
  return {
    ...ladderFixedBaselineChoices,
    minAbsDelta: settings.ladderMinAbsDelta,
    maxAbsDelta: settings.ladderMaxAbsDelta,
    minDte: settings.ladderMinDte,
    maxDte: settings.ladderMaxDte,
    maxSpreadPctOfMid: settings.ladderMaxSpreadPctOfMid,
    ladderRungs: settings.ladderRungs,
    ladderSharesPct: sharesPct,
    ladderShockMinPct: settings.ladderShockMinPct,
    ladderShockMaxPct: settings.ladderShockMaxPct,
    ladderShockNoHistoryPct: settings.ladderShockNoHistoryPct,
    ladderShockLookbackYears: settings.ladderShockLookbackYears,
  };
}

/** The ladder's settings for `symbol`; a symbol that is not a known ticker gets the strategy values only. */
export async function loadLadderSettingsForTicker(symbol: string, connection: Knex = db): Promise<LadderTickerSettings> {
  const normalizedSymbol = symbol.toUpperCase();
  const [settings, tickerSettings, enabledTickers, lastSnapshot] = await Promise.all([
    loadPlutoSettings(connection),
    loadPlutoTickerSettings(normalizedSymbol, connection),
    loadEnabledPlutoTickerSettings(connection),
    connection("account_pnl_snapshots").whereNotNull("net_liquidation_value").orderBy("snapshot_date", "desc").first("net_liquidation_value"),
  ]);
  const settingsVersionId = await ensurePlutoSettingsVersion(settings, connection);
  const enabledInPluto = enabledTickers.some((ticker) => ticker.symbol === normalizedSymbol);
  const allocationEffectivePct = effectiveAllocationPctBySymbol(enabledTickers).get(normalizedSymbol);
  const potDollars =
    enabledInPluto && allocationEffectivePct !== undefined && lastSnapshot
      ? (Number(lastSnapshot.net_liquidation_value) * (settings.capitalBudgetPct / 100) * allocationEffectivePct) / 100
      : null;
  return {
    symbol: normalizedSymbol,
    source: "live",
    enabled: enabledInPluto && settings.executionStrategy === "cc_put_ladder",
    settingsVersionId,
    baseline: ladderBaselineFromPlutoSettings(settings, tickerSettings?.ladderSharesPct ?? settings.ladderSharesPct),
    allocationPct: tickerSettings?.allocationPct ?? null,
    potDollars,
    overrideShockPct: tickerSettings?.ladderShockOverridePct ?? null,
  };
}
