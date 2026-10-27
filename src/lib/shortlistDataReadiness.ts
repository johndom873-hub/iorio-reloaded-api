import { db } from "../db/connection.js";
import { loadEarningsDatesForForecastWindow, loadNextEarningsDate } from "./tickerCalendarQueries.js";
import { loadStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { loadDailyBarsStatus, type DailyBarsStatus } from "./dailyBarsStatus.js";
import { easternIsoDate } from "./easternIsoDate.js";
import { computeIvMetrics } from "./ivMetrics.js";

// Backs the Shortlist screen's data-sanity-check columns (redesigned 2026-09-23, re-based on the Volatility screen
// 2026-10-27): per ticker, what the Volatility screen and the order forms read, so a gap here explains a blank or
// thin figure there (IV Rank and IV %ile from the implied-volatility days, FV21/FV63 from the daily bars and the
// earnings dates, the chain from the stored strikes).

export interface ShortlistDataReadiness extends DailyBarsStatus {
  dailyBarCount: number;
  /** Days of implied-volatility history in the 252-day window IV Rank and IV %ile read (ivMetrics.ts). */
  ivWindowDays: number;
  earningsCount: number;
  nextEarningsDateIso: string | null;
  isEtf: boolean;
  /** One entry per expiry stored in option_chain_expiry_strikes, each with its strike count. */
  optionChainExpiries: { expiry: string; strikeCount: number }[];
}

export async function loadShortlistDataReadiness(tickerId: string, sector: string | null, now: Date = new Date()): Promise<ShortlistDataReadiness> {
  const todayIso = easternIsoDate(now);

  const [dailyBarsStatus, barCountRow, ivMetrics, earningsDatesIso, nextEarningsDateIso, storedOptionChain] = await Promise.all([
    loadDailyBarsStatus(tickerId, now),
    db("daily_price_bars").where({ ticker_id: tickerId }).count<{ count: string }[]>("* as count"),
    computeIvMetrics(tickerId),
    loadEarningsDatesForForecastWindow(tickerId),
    loadNextEarningsDate(tickerId, todayIso),
    loadStoredOptionChain(tickerId),
  ]);

  const optionChainExpiries = Array.from(storedOptionChain.strikesByExpiry.entries())
    .map(([expiry, strikes]) => ({ expiry, strikeCount: strikes.length }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));

  return {
    ...dailyBarsStatus,
    dailyBarCount: Number(barCountRow[0]?.count ?? 0),
    ivWindowDays: ivMetrics.ivWindowDays,
    earningsCount: earningsDatesIso.length,
    nextEarningsDateIso,
    isEtf: sector === "ETF",
    optionChainExpiries,
  };
}
