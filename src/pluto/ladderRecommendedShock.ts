import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { deepestFallFromPeak, ladderShock } from "../backtest/engine/backtestBaselineLadder.js";
import type { PlutoSettings } from "./settingsStore.js";

// The shock the system recommends for a ticker's ladder (formula approved by Marcelo 2026-10-14): the stock's Max
// drawdown over the ladderShockLookbackYears of daily closes before the day, kept within ladderShockMinPct–MaxPct;
// ladderShockNoHistoryPct when those years hold fewer than 250 closes (a new listing). The backtest's own function on
// the live daily bars (IBKR daily TRADES, split-adjusted, as the backtest's), so live and the backtest agree.

export interface LadderRecommendedShock {
  /** The shock to use, percent. */
  recommendedShockPct: number;
  /** The Max drawdown found, percent (before the range is applied); null with too few closes. */
  maxDrawdownPct: number | null;
  closesUsed: number;
  /** First and last close in the window (null when none). */
  fromIso: string | null;
  toIso: string | null;
}

type ShockSettings = Pick<PlutoSettings, "ladderShockMinPct" | "ladderShockMaxPct" | "ladderShockNoHistoryPct" | "ladderShockLookbackYears">;

const minimumHistoryCloses = 250;

/** Pure: the recommendation from the closes before `beforeIso` (closes in any order; only the lookback window counts). */
export function recommendLadderShock(settings: ShockSettings, closes: readonly { date: string; close: number }[], beforeIso: string): LadderRecommendedShock {
  const shockSettings = { ladderShock: "history" as const, ladderShockPct: 0, ladderShockMinPct: settings.ladderShockMinPct, ladderShockMaxPct: settings.ladderShockMaxPct, ladderShockNoHistoryPct: settings.ladderShockNoHistoryPct, ladderShockLookbackYears: settings.ladderShockLookbackYears };
  const fromIso = `${Number(beforeIso.slice(0, 4)) - settings.ladderShockLookbackYears}${beforeIso.slice(4)}`;
  const window = closes.filter((bar) => bar.date >= fromIso && bar.date < beforeIso).sort((a, b) => a.date.localeCompare(b.date));
  const shock = ladderShock(shockSettings, window, beforeIso);
  return {
    recommendedShockPct: Math.round(shock * 100 * 100) / 100,
    maxDrawdownPct: window.length < minimumHistoryCloses ? null : Math.round(deepestFallFromPeak(window.map((bar) => bar.close)) * 100 * 100) / 100,
    closesUsed: window.length,
    fromIso: window[0]?.date ?? null,
    toIso: window[window.length - 1]?.date ?? null,
  };
}

/** The recommendation for `symbol` from the stored daily bars before `beforeIso` (normally today, Eastern); null for an unknown ticker. */
export async function loadLadderRecommendedShock(symbol: string, settings: ShockSettings, beforeIso: string, connection: Knex = db): Promise<LadderRecommendedShock | null> {
  const ticker = await connection("tickers").where({ symbol: symbol.toUpperCase() }).first("id");
  if (!ticker) return null;
  const fromIso = `${Number(beforeIso.slice(0, 4)) - settings.ladderShockLookbackYears}${beforeIso.slice(4)}`;
  const rows: { date: string; close: string }[] = await connection("daily_price_bars")
    .where({ ticker_id: ticker.id })
    .whereNotNull("close_price")
    .where("trading_date", ">=", fromIso)
    .where("trading_date", "<", beforeIso)
    .orderBy("trading_date")
    .select(connection.raw("trading_date::text as date"), "close_price as close");
  return recommendLadderShock(settings, rows.map((row) => ({ date: row.date, close: Number(row.close) })), beforeIso);
}
