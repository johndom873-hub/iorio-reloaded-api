import { db } from "../db/connection.js";
import { fetchNewTickerData } from "./fetchNewTickerData.js";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { backfillOneYearOfTickerHistory, hasSufficientTickerHistory } from "./priceBarCache.js";
import { captureTickerCalendarEvents } from "../lib/tradingviewCalendarService.js";

// Shared by both findOrCreateTicker (brand-new symbol) and
// addTickerToShortlist (symbol already had a `tickers` row, e.g. re-added
// after removal, or created before this fire-and-forget backfill existed) —
// so IV Rank/Percentile and Trend don't depend on which path first touched
// the ticker. Not awaited by either caller: a second IBKR connect here would
// stack on top of the caller's own IBKR round-trip and risk the Heroku
// router timeout on an interactive request.
function backfillTickerHistoryInBackground(tickerId: string, symbol: string): void {
  void (async () => {
    const backfillConnection = await connectToIbkrGateway();
    try {
      const count = await backfillOneYearOfTickerHistory(backfillConnection, tickerId, symbol);
      console.log(`backfillTickerHistoryInBackground: backfilled ${count} daily bar(s) for ${symbol}.`);
    } catch (error) {
      console.error(`backfillTickerHistoryInBackground: backfill failed for ${symbol}`, error);
    } finally {
      backfillConnection.disconnect();
    }
  })();
}

export interface FindOrCreateTickerResult {
  ticker: { id: string; symbol: string; company_name: string | null; sector: string | null };
  created: boolean;
}

/**
 * Idempotent find-or-create for a ticker by symbol, shared by every "add
 * this symbol to the shortlist" entry point (manual add in screener.ts,
 * and adding a screener_scan_results candidate). A brand-new symbol gets a
 * live IBKR lookup (fetchNewTickerData), a `tickers` row, a
 * market_data_snapshots row for today, and a fire-and-forget one-year daily
 * bar backfill so IV Rank/Percentile and chart history don't wait ~99 days
 * to become usable. Extracted 2026-09-05 from screener.ts's POST / handler
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

  backfillTickerHistoryInBackground(ticker.id, ticker.symbol);

  return { ticker, created: true };
}

export interface AddTickerToShortlistResult {
  id: string;
  addedAt: string;
  notes: string | null;
}

/**
 * Shared by screener.ts's POST / (manual add) and screenerScan.ts's
 * add-to-shortlist endpoint. Throws with `.code === "23505"` on duplicate
 * (partial unique index on shortlist_entries.ticker_id WHERE removed_at IS
 * NULL) — callers translate that into a 409, matching existing behavior.
 *
 * `tickerWasJustCreated` skips this function's own history-coverage check —
 * findOrCreateTicker already fired a fire-and-forget backfill for a brand
 * new ticker's `tickers` row a few lines up in the same request, and it has
 * zero daily_price_bars rows at this point regardless, so checking here
 * would just fire a second, redundant IBKR backfill on top of that one.
 */
export async function addTickerToShortlist(
  tickerId: string,
  symbol: string,
  userId: string | undefined,
  notes?: string | null,
  tickerWasJustCreated = false,
): Promise<AddTickerToShortlistResult> {
  const [entry] = await db("shortlist_entries")
    .insert({
      ticker_id: tickerId,
      added_by_user_id: userId,
      notes: notes ?? null,
    })
    .returning("*");

  try {
    await captureTickerCalendarEvents(tickerId, symbol);
  } catch (error) {
    console.error(`addTickerToShortlist: calendar capture failed for ${symbol}`, error);
  }

  if (!tickerWasJustCreated && !(await hasSufficientTickerHistory(tickerId))) {
    backfillTickerHistoryInBackground(tickerId, symbol);
  }

  return { id: entry.id, addedAt: entry.added_at, notes: entry.notes };
}
