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
    // Strip TradingView's "<em>...</em>" match-highlighting before comparing —
    // the API returns fuzzy substring matches (e.g. searching "SMH" also
    // matches "SMHI"), so an exact symbol match is required here. Without it,
    // an ETF/foreign-listing-only ticker like SMH (which never appears as a
    // "stock"/US row) silently fell through to an unrelated company (SMHI —
    // SEACOR Marine Holdings) instead of correctly resolving to null.
    const exactMatches = results.filter((r) => r.symbol.replace(/<\/?em>/g, "").toUpperCase() === symbol.toUpperCase());
    const best =
      exactMatches.find((r) => r.type === "stock" && r.country === "US" && r.is_primary_listing) ??
      exactMatches.find((r) => r.type === "stock" && r.country === "US");
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

/** Writes earnings rows (from fetchEarningsEvents) to ticker_calendar_events. Returns rows written. */
export async function upsertEarningsEvents(rows: Record<string, unknown>[], tickerIdByTvTicker: Map<string, string>): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const tickerId = tickerIdByTvTicker.get(row.tvTicker as string);
    if (!tickerId) continue;
    for (const dateField of ["earnings_release_date", "earnings_release_next_date"] as const) {
      const raw = row[dateField];
      if (raw === null || raw === undefined) continue;
      const eventDate = new Date((raw as number) * 1000).toISOString().slice(0, 10);
      const eventTime = row[dateField === "earnings_release_date" ? "earnings_release_time" : "earnings_release_next_time"];
      await db("ticker_calendar_events")
        .insert({
          ticker_id: tickerId,
          event_type: "earnings",
          event_date: eventDate,
          event_time: eventTime === null || eventTime === undefined ? null : String(eventTime),
          raw: JSON.stringify(row),
        })
        .onConflict(["ticker_id", "event_type", "event_date"])
        .merge(["event_time", "raw", "captured_at"]);
      written++;
    }
  }
  return written;
}

/** Writes dividend rows (from fetchDividendEvents) to ticker_calendar_events. Returns rows written. */
export async function upsertDividendEvents(rows: Record<string, unknown>[], tickerIdByTvTicker: Map<string, string>): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const tickerId = tickerIdByTvTicker.get(row.tvTicker as string);
    if (!tickerId) continue;
    for (const [dateField, amountField] of [
      ["dividend_ex_date_recent", "dividend_amount_recent"],
      ["dividend_ex_date_upcoming", "dividend_amount_upcoming"],
    ] as const) {
      const raw = row[dateField];
      if (raw === null || raw === undefined) continue;
      const eventDate = new Date((raw as number) * 1000).toISOString().slice(0, 10);
      const amount = row[amountField];
      await db("ticker_calendar_events")
        .insert({
          ticker_id: tickerId,
          event_type: "ex_dividend",
          event_date: eventDate,
          amount: amount === null || amount === undefined ? null : Number(amount),
          raw: JSON.stringify(row),
        })
        .onConflict(["ticker_id", "event_type", "event_date"])
        .merge(["amount", "raw", "captured_at"]);
      written++;
    }
  }
  return written;
}

const CALENDAR_LOOKAHEAD_DAYS = 90;

export interface TickerCalendarCaptureResult {
  resolved: boolean;
  tvTicker: string | null;
  earningsWritten: number;
  dividendsWritten: number;
}

/**
 * Resolves and captures earnings/ex-dividend events for a single ticker —
 * same logic as the daily batch job, scoped to one symbol. Used when a
 * ticker is newly added to the screener so its calendar data doesn't wait
 * for the next scheduled run.
 */
export async function captureTickerCalendarEvents(tickerId: string, symbol: string): Promise<TickerCalendarCaptureResult> {
  const tvTicker = await resolveTradingViewTicker(tickerId, symbol);
  if (!tvTicker) {
    return { resolved: false, tvTicker: null, earningsWritten: 0, dividendsWritten: 0 };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - 30 * 24 * 60 * 60;
  const toSec = nowSec + CALENDAR_LOOKAHEAD_DAYS * 24 * 60 * 60;
  const tickerIdByTvTicker = new Map([[tvTicker, tickerId]]);

  const [earningsRows, dividendRows] = await Promise.all([
    fetchEarningsEvents([tvTicker], fromSec, toSec),
    fetchDividendEvents([tvTicker], fromSec, toSec),
  ]);
  const earningsWritten = await upsertEarningsEvents(earningsRows, tickerIdByTvTicker);
  const dividendsWritten = await upsertDividendEvents(dividendRows, tickerIdByTvTicker);

  return { resolved: true, tvTicker, earningsWritten, dividendsWritten };
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
