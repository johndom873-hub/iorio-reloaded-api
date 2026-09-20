import { db } from "../db/connection.js";

// Shared stock price service — approved 2026-09-19 (price consistency audit, PROGRESS.md).
//
// One hierarchy for "the price of a ticker", used by every screen and job so they always agree:
//   1. a live or frozen LAST TRADE from IBKR (recorded here the moment any path receives one)
//   2. the persisted last known good price (table last_known_prices) if it is not older than maxKnownPriceAgeMs
//   3. the latest daily bar close (daily_price_bars), if newer than the persisted price
//   4. nothing (null) — never a previous-session close, which outside market hours is a session old
//
// A price from step 2/3 is returned with its as-of time so a caller can label it; callers that only need a number
// (P&L, strike selection) just use it.

export type KnownPriceSource = "live" | "frozen" | "daily_close" | "known" | "bar";

export interface KnownPrice {
  price: number;
  asOf: Date;
  source: KnownPriceSource;
}

const maxKnownPriceAgeMs = 14 * 24 * 60 * 60 * 1000;
// Live tick storms must not become a DB write per tick: write a symbol at most this often unless the source upgrades.
const minWriteIntervalMs = 5_000;

const lastWrite = new Map<string, { price: number; at: number }>();

/** Records real last-trade prices (fire-and-forget safe: never throws into a price stream). */
export async function recordStockPrices(entries: { symbol: string; price: number; source: "live" | "frozen" | "daily_close" }[]): Promise<void> {
  const now = Date.now();
  const due = entries.filter((entry) => {
    if (!(entry.price > 0)) return false;
    const previous = lastWrite.get(entry.symbol);
    if (previous && previous.price === entry.price) return false;
    return !previous || now - previous.at >= minWriteIntervalMs;
  });
  if (due.length === 0) return;
  try {
    await db("last_known_prices")
      .insert(due.map((entry) => ({ symbol: entry.symbol, price: entry.price, as_of: new Date(now), source: entry.source })))
      .onConflict("symbol")
      .merge();
    for (const entry of due) lastWrite.set(entry.symbol, { price: entry.price, at: now });
  } catch (error) {
    console.warn(`priceService: could not record prices — ${error instanceof Error ? error.message : error}`);
  }
}

/** Best non-live price per symbol from storage: the persisted last known good, or a newer daily close. Missing symbols are absent. */
export async function loadFallbackStockPrices(symbols: string[]): Promise<Map<string, KnownPrice>> {
  const result = new Map<string, KnownPrice>();
  const unique = [...new Set(symbols)];
  if (unique.length === 0) return result;
  try {
    const [knownRows, barRows] = await Promise.all([
      db("last_known_prices").whereIn("symbol", unique).select("symbol", "price", "as_of", "source"),
      db.raw(
        `SELECT DISTINCT ON (t.symbol) t.symbol, b.close_price::float AS price, b.trading_date::text AS date
         FROM daily_price_bars b JOIN tickers t ON t.id = b.ticker_id
         WHERE t.symbol = ANY(?) AND b.close_price IS NOT NULL
         ORDER BY t.symbol, b.trading_date DESC`,
        [unique],
      ),
    ]);
    const cutoff = Date.now() - maxKnownPriceAgeMs;
    for (const row of knownRows) {
      const asOf = new Date(row.as_of);
      if (asOf.getTime() >= cutoff) result.set(row.symbol, { price: Number(row.price), asOf, source: "known" });
    }
    for (const row of barRows.rows) {
      // A bar is dated to its session; its close is as of that session's end (21:00 UTC covers the US close).
      const asOf = new Date(`${row.date}T21:00:00Z`);
      const existing = result.get(row.symbol);
      if (!existing || asOf.getTime() > existing.asOf.getTime()) result.set(row.symbol, { price: Number(row.price), asOf, source: "bar" });
    }
  } catch (error) {
    console.warn(`priceService: could not load fallback prices — ${error instanceof Error ? error.message : error}`);
  }
  return result;
}

/** One-symbol convenience for one-shot callers (alert generation, quote tools): best stored price or null. */
export async function getBestKnownStockPrice(symbol: string): Promise<number | null> {
  return (await loadFallbackStockPrices([symbol])).get(symbol)?.price ?? null;
}
