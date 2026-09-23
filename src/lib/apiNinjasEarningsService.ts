import { db } from "../db/connection.js";

// Historical earnings dates via API Ninjas (chosen 2026-09-23): TradingView's scanner
// endpoint (tradingviewCalendarService.ts) only ever returns the most recent + next
// earnings date, not history -- confirmed by probing its undocumented columns directly.
// API Ninjas' Earnings Calendar API returns full per-ticker history (to 2000) on a free,
// keyless-signup tier; its commercial-use restriction doesn't apply since this project is
// personal use. TradingView stays the ongoing nightly forward-looking source -- this is
// additive, for the backfill only.

const apiNinjasEarningsCalendarUrl = "https://api.api-ninjas.com/v1/earningscalendar";

interface ApiNinjasEarningsRow {
  date: string; // YYYY-MM-DD
  ticker: string;
  fiscal_year?: number;
  fiscal_quarter?: number;
  actual_eps?: number | null;
  actual_revenue?: number | null;
}

function requireApiNinjasKey(): string {
  const key = process.env.API_NINJAS_KEY;
  if (!key) throw new Error("API_NINJAS_KEY is not set");
  return key;
}

/** Every earnings date API Ninjas has on record for a ticker. Throws on a request/auth failure -- callers decide how to degrade. */
export async function fetchHistoricalEarnings(symbol: string): Promise<ApiNinjasEarningsRow[]> {
  const response = await fetch(`${apiNinjasEarningsCalendarUrl}?ticker=${encodeURIComponent(symbol)}`, {
    headers: { "X-Api-Key": requireApiNinjasKey() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`API Ninjas earnings calendar HTTP ${response.status}`);
  const data = (await response.json()) as ApiNinjasEarningsRow[] | { error?: string };
  if (!Array.isArray(data)) throw new Error(`API Ninjas earnings calendar error: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Writes historical earnings rows to ticker_calendar_events -- same table and upsert key (ticker_id,
 * event_type, event_date) the TradingView capture already uses, so a date either source has seen just
 * merges. Returns rows written.
 *
 * Skips rows with no reported EPS/revenue (live-verified 2026-09-23: API Ninjas returns garbage "earnings"
 * dates for at least SPY and QQQ -- both ETFs, which don't report earnings at all -- every field null
 * including fiscal_year/fiscal_quarter, most recent date over a decade stale. A real company's earnings row
 * always carries at least one of actual_eps/actual_revenue, even on its oldest rows where fiscal_year is
 * also null (confirmed against AAOI's real 2014-15 history) -- so this is a clean discriminator without
 * needing a security-type column the schema doesn't have.
 */
export async function upsertHistoricalEarnings(tickerId: string, rows: ApiNinjasEarningsRow[]): Promise<number> {
  let written = 0;
  for (const row of rows) {
    if (!row.date) continue;
    if (row.actual_eps == null && row.actual_revenue == null) continue;
    await db("ticker_calendar_events")
      .insert({ ticker_id: tickerId, event_type: "earnings", event_date: row.date, raw: JSON.stringify(row) })
      .onConflict(["ticker_id", "event_type", "event_date"])
      .merge(["raw", "captured_at"]);
    written++;
  }
  return written;
}

export interface HistoricalEarningsCaptureResult {
  written: number;
  /** True when the ticker is an ETF and the fetch was skipped entirely -- see isEtfTicker below. */
  skippedEtf: boolean;
  /** Null on success. Graceful-degradation match for tradingviewCalendarService.ts's captureTickerCalendarEvents: a
   * third-party outage here shouldn't fail the whole calendar backfill step, since the forward-looking TradingView
   * half is what the earnings guard actually depends on day to day. */
  error: string | null;
}

/**
 * ETFs don't report earnings at all, yet API Ninjas returns garbage rows for at least SPY/QQQ (live-verified
 * 2026-09-23: 12 rows for SPY, every field null down to fiscal_year, dates over a decade stale -- almost
 * certainly a ticker-symbol collision with some long-gone company in their data, not real SPY data). Rather
 * than rely on per-row filtering catching every case, skip the fetch outright for anything already known to
 * be an ETF. `tickers.sector` already reliably holds the literal string "ETF" for every ETF in this DB --
 * `fetchNewTickerData.ts`/`fetchScannerCandidates.ts`'s existing `resolveSector` falls back to IBKR's
 * `stockType === "ETF"` specifically because industry/category come back blank for ETFs -- so this reuses
 * that classification instead of adding a new column or IBKR call.
 */
export async function isEtfTicker(tickerId: string): Promise<boolean> {
  const row = await db("tickers").where({ id: tickerId }).first("sector");
  return row?.sector === "ETF";
}

/** Resolves and writes one ticker's full earnings history. Used by the new-ticker backfill pipeline and any manual re-trigger. Always a no-op for ETFs (see isEtfTicker). */
export async function captureHistoricalEarnings(tickerId: string, symbol: string): Promise<HistoricalEarningsCaptureResult> {
  if (await isEtfTicker(tickerId)) return { written: 0, skippedEtf: true, error: null };
  try {
    const rows = await fetchHistoricalEarnings(symbol);
    const written = await upsertHistoricalEarnings(tickerId, rows);
    return { written, skippedEtf: false, error: null };
  } catch (error) {
    console.error(`captureHistoricalEarnings: failed for ${symbol}`, error);
    return { written: 0, skippedEtf: false, error: error instanceof Error ? error.message : String(error) };
  }
}
