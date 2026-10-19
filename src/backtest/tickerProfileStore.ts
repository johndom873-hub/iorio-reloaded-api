import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { fetchTradingViewSymbolProfiles } from "../lib/tradingviewCalendarService.js";
import type { BacktestTickerProfile } from "./backtestTypes.js";

// The Analyse window header's name and classification (Marcelo 2026-10-19): TradingView's, stored per ticker and refreshed
// when its analysis runs; until TradingView has answered once, the IBKR name and sector stored for the ticker.

/** Fetches and stores the symbols' TradingView profiles; returns the symbols TradingView doesn't list. Throws when the request fails. */
export async function refreshTickerProfiles(symbols: readonly string[], connection: Knex = db): Promise<string[]> {
  const profiles = await fetchTradingViewSymbolProfiles(symbols);
  for (const [symbol, profile] of profiles) {
    await connection("backtest_ticker_profiles")
      .insert({ symbol, tradingview_ticker: profile.tvTicker, company_name: profile.companyName, sector: profile.sector, industry: profile.industry, kind: profile.kind, fetched_at: connection.fn.now() })
      .onConflict("symbol")
      .merge();
  }
  return symbols.filter((symbol) => !profiles.has(symbol));
}

export async function loadTickerProfile(symbol: string, connection: Knex = db): Promise<BacktestTickerProfile | null> {
  const stored = await connection("backtest_ticker_profiles").where({ symbol }).first("tradingview_ticker", "company_name", "sector", "industry", "kind");
  if (stored) return { source: "tradingview", companyName: stored.company_name, exchange: stored.tradingview_ticker.split(":")[0] ?? null, sector: stored.sector, industry: stored.industry, kind: stored.kind };
  const fallback =
    (await connection("tickers").where({ symbol }).whereNotNull("company_name").first("company_name", "sector", "primary_exchange")) ??
    (await connection("screener_universe").where({ symbol }).whereNotNull("company_name").first("company_name", "sector", "primary_exchange"));
  if (!fallback) return null;
  return { source: "ibkr", companyName: fallback.company_name, exchange: fallback.primary_exchange ?? null, sector: fallback.sector === "ETF" ? null : fallback.sector, industry: null, kind: fallback.sector === "ETF" ? "etf" : null };
}
