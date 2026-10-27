import { optionMidLimitPrice } from "../lib/optionLimitPrice.js";

// What is left of Pluto's post-model order checks (design round 3, item 21, approved 2026-09-28) now that no model
// chooses (Marcelo 2026-10-27): the order plan the ladder's executor sends, the mid limit price and the ticker cooldown,
// and the Kelly fraction the retired rules backtests stored with their settings. Pure.

export interface PlutoOrderPlan {
  quantity: number;
  limitPrice: number;
  /** Cash this order commits (0 for a call code sells on held shares). */
  notional: number;
  fullSizeQuantity: number;
}

/**
 * Sell at the mid, clamped inside the current market (design item 22: mid, no concession): live (a symbol given) rounded up
 * to the cent (optionLimitPrice.ts); without one to the nearest cent.
 */
export function midLimitPrice(bid: number, ask: number, symbol?: string): number {
  if (symbol !== undefined) return optionMidLimitPrice(bid, ask, "sell");
  return Math.min(ask, Math.max(bid, Math.round(((bid + ask) / 2) * 100) / 100));
}

/** The ticker cooldown: over once tickerCooldownMinutes have passed since the last Pluto action on the symbol whose order filled. */
export function tickerCooldownStatus(lastFilledActionAt: Date | null, nowMs: number, cooldownMinutes: number): { cooledDown: boolean; detail: string } {
  if (lastFilledActionAt === null) return { cooledDown: true, detail: "no filled Pluto action on this symbol" };
  const minutesSinceLastFill = (nowMs - lastFilledActionAt.getTime()) / 60_000;
  return {
    cooledDown: cooldownMinutes === 0 || minutesSinceLastFill >= cooldownMinutes,
    detail: `last filled Pluto action on this symbol ${Math.floor(minutesSinceLastFill)} min ago (cooldown ${cooldownMinutes} min)`,
  };
}

/** The share of full Kelly Pluto sized with (half-Kelly on Edge $, model review P5); a backtest snapshot still records it. */
export const kellyFraction = 0.5;

/** What the Kelly cap's μ was: the model's Edge $, or history's Hist Edge $ (a rules backtest's stored model settings). */
export type KellyEdgeBasis = "edge_dollars" | "hist_edge_dollars";
