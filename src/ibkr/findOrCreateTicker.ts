import { db } from "../db/connection.js";
import { fetchNewTickerData } from "./fetchNewTickerData.js";
import { startTickerBackfill, type TickerBackfillRun } from "./tickerBackfillPipeline.js";

export interface FindOrCreateTickerResult {
  ticker: { id: string; symbol: string; company_name: string | null; sector: string | null };
  created: boolean;
}

/**
 * Idempotent find-or-create for a ticker by symbol, shared by every "add
 * this symbol to the shortlist" entry point (manual add in screener.ts,
 * and adding a screener_scan_results candidate). A brand-new symbol gets a
 * live IBKR lookup (fetchNewTickerData), a `tickers` row, a
 * market_data_snapshots row for today. History backfill is NOT started here —
 * addTickerToShortlist starts the shared backfill pipeline (tickerBackfillPipeline.ts). Extracted 2026-09-05 from screener.ts's POST / handler
 * — see that route's history for the original inline version.
 */
export async function findOrCreateTicker(symbol: string): Promise<FindOrCreateTickerResult> {
  const normalizedSymbol = symbol.trim().toUpperCase();

  const existing = await db("tickers").where({ symbol: normalizedSymbol }).first();
  if (existing) {
    return { ticker: existing, created: false };
  }

  const tickerData = await fetchNewTickerData(normalizedSymbol);
  const [ticker] = await db("tickers")
    .insert({
      symbol: normalizedSymbol,
      company_name: tickerData.companyName,
      sector: tickerData.sector,
      ibkr_contract_id: tickerData.conId,
      primary_exchange: tickerData.primaryExchange,
    })
    .returning("*");

  await db("market_data_snapshots")
    .insert({
      ticker_id: ticker.id,
      snapshot_date: new Date().toISOString().slice(0, 10),
      implied_volatility: tickerData.impliedVolatility,
      avg_option_volume: tickerData.avgOptionVolume,
    })
    .onConflict(["ticker_id", "snapshot_date"])
    .merge();

  return { ticker, created: true };
}

export interface AddTickerToShortlistResult {
  id: string;
  addedAt: string;
  notes: string | null;
  backfillRun: TickerBackfillRun;
}

/**
 * Shared by screener.ts's POST / (manual add) and screenerScan.ts's
 * add-to-shortlist endpoint. Throws with `.code === "23505"` on duplicate
 * (partial unique index on shortlist_entries.ticker_id WHERE removed_at IS
 * NULL) — callers translate that into a 409, matching existing behavior.
 *
 * Starts the new-ticker backfill pipeline (5Y history, calendar, option chain
 * strikes, first snapshot) for every add, including re-adds — it is idempotent,
 * and a run already in progress for the ticker is joined, not duplicated.
 */
export async function addTickerToShortlist(
  tickerId: string,
  symbol: string,
  userId: string | undefined,
  notes?: string | null,
): Promise<AddTickerToShortlistResult> {
  const [entry] = await db("shortlist_entries")
    .insert({
      ticker_id: tickerId,
      added_by_user_id: userId,
      notes: notes ?? null,
    })
    .returning("*");

  const backfillRun = await startTickerBackfill(tickerId, symbol);

  return { id: entry.id, addedAt: entry.added_at, notes: entry.notes, backfillRun };
}
