import { db } from "../db/connection.js";

// Earnings/dividend/economic-calendar data sourced from TradingView's
// public, unauthenticated endpoints -- same pattern already proven in
// production by menaris-admin-api's tradingview-service.js (confirmed by
// reading that repo's actual implementation, 2026-08-30) and independently
// confirmed live via direct curl for the economic-calendar and
// symbol-search endpoints below. No API key; plain browser-style headers.
// Undocumented -- can change shape without notice, same risk class as HTML
// scraping but with a working precedent already running elsewhere.
const tradingViewHeaders = {
  "User-Agent": "Mozilla/5.0",
  Accept: "*/*",
  "Content-Type": "text/plain;charset=UTF-8",
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/",
};

interface SymbolSearchResult {
  symbol: string;
  type: string;
  exchange: string;
  country?: string;
  is_primary_listing?: boolean;
}

// Resolves a bare symbol (e.g. "AAPL") to TradingView's "EXCHANGE:SYMBOL"
// format (e.g. "NASDAQ:AAPL") via TradingView's public symbol-search
// endpoint, and caches the result on tickers.tradingview_ticker so this
// only ever runs once per ticker. Returns null (not a throw) when
// TradingView has no match -- the caller just skips that ticker for
// calendar capture, same graceful-degradation pattern as the rest of this
// codebase's IBKR calls.
export async function resolveTradingViewTicker(tickerId: string, symbol: string): Promise<string | null> {
  const existing = await db("tickers").where({ id: tickerId }).first("tradingview_ticker");
  if (existing?.tradingview_ticker) return existing.tradingview_ticker;

  try {
    const params = new URLSearchParams({ text: symbol, hl: "1", exchange: "", lang: "en", search_type: "stocks", domain: "production" });
    const response = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params.toString()}`, {
      headers: tradingViewHeaders,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`symbol-search HTTP ${response.status}`);
    const data = (await response.json()) as { symbols?: SymbolSearchResult[] };
    const results = data.symbols ?? [];
    // Prefer the primary US common-stock listing; strip TradingView's
    // "<em>...</em>" match-highlighting from the symbol field.
    const best =
      results.find((r) => r.type === "stock" && r.country === "US" && r.is_primary_listing) ??
      results.find((r) => r.type === "stock" && r.country === "US");
    if (!best) return null;

    const cleanSymbol = best.symbol.replace(/<\/?em>/g, "");
    const tvTicker = `${best.exchange}:${cleanSymbol}`;
    await db("tickers").where({ id: tickerId }).update({ tradingview_ticker: tvTicker });
    return tvTicker;
  } catch (error) {
    console.error(`resolveTradingViewTicker: symbol-search failed for ${symbol}`, error);
    return null;
  }
}

const EARNINGS_COLUMNS = [
  "earnings_release_date",
  "earnings_release_next_date",
  "earnings_release_time",
  "earnings_release_next_time",
  "earnings_per_share_fq",
  "earnings_per_share_forecast_next_fq",
  "eps_surprise_fq",
  "eps_surprise_percent_fq",
  "revenue_fq",
  "revenue_forecast_next_fq",
];

const DIVIDEND_COLUMNS = [
  "dividend_ex_date_recent",
  "dividend_ex_date_upcoming",
  "dividend_payment_date_recent",
  "dividend_payment_date_upcoming",
  "dividend_amount_recent",
  "dividend_amount_upcoming",
];

async function scanTradingView(
  tvTickers: string[],
  columns: string[],
  filterColumns: string,
  fromSec: number,
  toSec: number,
): Promise<Record<string, unknown>[]> {
  if (tvTickers.length === 0) return [];
  const body = {
    filter: [{ left: filterColumns, operation: "in_range", right: [fromSec, toSec] }],
    columns,
    options: { lang: "en" },
    symbols: { tickers: tvTickers },
    sort: { sortBy: "logoid", sortOrder: "asc" },
    price_conversion: { to_symbol: true },
  };
  const response = await fetch("https://scanner.tradingview.com/global/scan?label-product=popup-watchlists", {
    method: "POST",
    headers: tradingViewHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`scanner.tradingview.com HTTP ${response.status}`);
  const data = (await response.json()) as { data?: { s: string; d: unknown[] }[] };
  const rows = data.data ?? [];
  return rows.map((row) => {
    const record: Record<string, unknown> = { tvTicker: row.s };
    columns.forEach((col, i) => (record[col] = row.d[i]));
    return record;
  });
}

/** Earnings dates for the given TradingView tickers within [fromSec, toSec] (unix seconds). */
export function fetchEarningsEvents(tvTickers: string[], fromSec: number, toSec: number) {
  return scanTradingView(tvTickers, EARNINGS_COLUMNS, "earnings_release_date,earnings_release_next_date", fromSec, toSec);
}

/** Ex-dividend/payment dates for the given TradingView tickers within [fromSec, toSec] (unix seconds). */
export function fetchDividendEvents(tvTickers: string[], fromSec: number, toSec: number) {
  return scanTradingView(tvTickers, DIVIDEND_COLUMNS, "dividend_ex_date_recent,dividend_ex_date_upcoming", fromSec, toSec);
}

export interface EconomicCalendarEvent {
  id: string;
  title: string;
  country: string;
  category: string | null;
  importance: number | null;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  date: string; // ISO timestamp
}

/** Macro economic calendar events (CPI, FOMC, etc.) for a country in [fromIso, toIso). US only by default -- not ticker-scoped. */
export async function fetchEconomicCalendarEvents(fromIso: string, toIso: string, countries = "US"): Promise<EconomicCalendarEvent[]> {
  const params = new URLSearchParams({ from: fromIso, to: toIso, countries });
  const response = await fetch(`https://economic-calendar.tradingview.com/events?${params.toString()}`, {
    headers: tradingViewHeaders,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`economic-calendar.tradingview.com HTTP ${response.status}`);
  const data = (await response.json()) as { result?: EconomicCalendarEvent[] };
  return data.result ?? [];
}
