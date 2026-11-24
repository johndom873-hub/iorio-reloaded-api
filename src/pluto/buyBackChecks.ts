import { db } from "../db/connection.js";
import type { VolFarmerV3CallsInTheMoneyAtLastLook } from "../backtest/backtestTypes.js";
import { formatEasternTime } from "../lib/easternIsoDate.js";
import { isLastSessionBeforeWeekend } from "../lib/tradingWeek.js";
import { volFarmerV4BuyBackMinutesBeforeWindowEnd } from "./volFarmerV4LiveBook.js";

// v4's buybacks of Calls in the money, watched on the stock's live price (Marcelo 2026-11-24). From shortly before the
// window's end until a minute before the close, a ticker with one of Pluto's Calls expiring today gets a buyback round of
// its own whenever its stock trades at or above that Call's strike, at most once every volFarmerV4BuyBackCheckSeconds, and
// not while one of its orders works (a buyback working follows the mid on its own). The round decides on its own price,
// memory and ledger (volFarmerV4Round.ts buyBackCallsInTheMoney); this only says when to run one.

/** A ticker gets at most one buyback round this often while its stock is at or above a strike. */
export const volFarmerV4BuyBackCheckSeconds = 5;

/** Pure: whether v4 buys back Calls in the money today: every day, or only on the last session before a weekend. */
export function volFarmerV4BuysBackToday(callsInTheMoneyAtLastLook: VolFarmerV3CallsInTheMoneyAtLastLook, todayIso: string, nextSessionIso: string | undefined): boolean {
  if (callsInTheMoneyAtLastLook === "assigned") return false;
  return callsInTheMoneyAtLastLook === "bought_back" || isLastSessionBeforeWeekend(todayIso, nextSessionIso);
}

/** Pure: when v4's buyback minutes run. Example: the window ending 15:30 ET, the close 16:00: "15:28–15:59 ET". */
export function describeVolFarmerV4BuyBackHours(windowEndAtMs: number, buyBacksStopAtMs: number): string {
  const start = formatEasternTime(new Date(windowEndAtMs - volFarmerV4BuyBackMinutesBeforeWindowEnd * 60_000)).replace(" ET", "");
  return `${start}–${formatEasternTime(new Date(buyBacksStopAtMs))}`;
}

/** Pure: v4's buyback minutes as a round's notes word them, e.g. "the buyback minutes (15:28–15:59 ET)". */
export function describeVolFarmerV4BuyBackMinutes(windowEndAtMs: number | null, buyBacksStopAtMs: number | null): string {
  return windowEndAtMs === null || buyBacksStopAtMs === null ? "the buyback minutes" : `the buyback minutes (${describeVolFarmerV4BuyBackHours(windowEndAtMs, buyBacksStopAtMs)})`;
}

/** A short Call expiring today on one of Pluto's tickers, still open in the ledger. */
export interface PlutoCallExpiringToday {
  symbol: string;
  strike: number;
}

/** The short Calls expiring today, still open, on the tickers Pluto is switched on for (orders by hand are locked on them). */
export async function loadPlutoCallsExpiringToday(todayIso: string): Promise<PlutoCallExpiringToday[]> {
  const rows: { symbol: string; strike_price: string }[] = await db("position_legs as leg")
    .join("positions as position", "position.id", "leg.position_id")
    .join("tickers as ticker", "ticker.id", "position.ticker_id")
    .join("shortlist_entries as entry", "entry.ticker_id", "ticker.id")
    .whereNull("entry.removed_at")
    .where("entry.bot_enabled", true)
    .where("position.status", "open")
    .whereNull("leg.exit_at")
    .where({ "leg.leg_type": "option", "leg.option_type": "call", "leg.side": "short" })
    .where("leg.expiry_date", todayIso)
    .whereNotNull("leg.strike_price")
    .select("ticker.symbol", "leg.strike_price");
  return rows.map((row) => ({ symbol: row.symbol, strike: Number(row.strike_price) }));
}

/**
 * Pure: the tickers due a buyback round now: a Call expiring today at or below the stock's price, no order of theirs
 * working, and no check in the last `intervalMs`. Example: TQQQ's $49.50 Call, the stock at 49.51, last checked 6 s ago,
 * no order working: due; at 49.49, or checked 3 s ago, or its buyback working: not due.
 */
export function symbolsDueForBuyBackCheck(input: {
  nowMs: number;
  calls: readonly PlutoCallExpiringToday[];
  stockPriceOf: (symbol: string) => number | null;
  lastCheckedAtMs: ReadonlyMap<string, number>;
  symbolsWithWorkingOrders: ReadonlySet<string>;
  intervalMs: number;
}): string[] {
  const due = new Set<string>();
  for (const call of input.calls) {
    if (due.has(call.symbol) || input.symbolsWithWorkingOrders.has(call.symbol)) continue;
    const lastChecked = input.lastCheckedAtMs.get(call.symbol);
    if (lastChecked !== undefined && input.nowMs - lastChecked < input.intervalMs) continue;
    const price = input.stockPriceOf(call.symbol);
    if (price !== null && price >= call.strike) due.add(call.symbol);
  }
  return [...due].sort();
}
