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
/** Thrown when IBKR has no contract for the symbol — routes answer 422, nothing is stored. */
export class UnknownSymbolError extends Error {
  constructor(symbol: string) {
    super(`${symbol} is not a symbol IBKR recognises — check the spelling (or IBKR did not answer in time; try again).`);
    this.name = "UnknownSymbolError";
  }
}

export async function findOrCreateTicker(symbol: string): Promise<FindOrCreateTickerResult> {
  const normalizedSymbol = symbol.trim().toUpperCase();

  const existing = await db("tickers").where({ symbol: normalizedSymbol }).first();
  if (existing) {
    return { ticker: existing, created: false };
  }

  const tickerData = await fetchNewTickerData(normalizedSymbol);
  // A symbol IBKR does not recognise (a typo, or a lookup that timed out)
  // used to be saved with a null contract id for good and then fail every
  // later step (2026-09-24). Refuse instead; nothing is written.
  if (tickerData.conId === null || tickerData.conId === undefined) {
    throw new UnknownSymbolError(normalizedSymbol);
  }
  // Two concurrent adds of the same new symbol: the loser re-reads the row
  // the winner inserted instead of surfacing the unique violation as a 500.
  const [inserted] = await db("tickers")
    .insert({
      symbol: normalizedSymbol,
      company_name: tickerData.companyName,
      sector: tickerData.sector,
      ibkr_contract_id: tickerData.conId,
      primary_exchange: tickerData.primaryExchange,
    })
    .onConflict("symbol")
    .ignore()
    .returning("*");
  const ticker = inserted ?? (await db("tickers").where({ symbol: normalizedSymbol }).first());
  if (!ticker) throw new Error(`Ticker ${normalizedSymbol} could not be created.`);
  if (!inserted) return { ticker, created: false };

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
  backfillRun: TickerBackfillRun | null;
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

  // The entry is already saved; a backfill that cannot start must not read
  // as "add failed" (2026-09-24). Reported as null — the row shows no run.
  let backfillRun: TickerBackfillRun | null = null;
  try {
    backfillRun = await startTickerBackfill(tickerId, symbol);
  } catch (error) {
    console.warn(`addTickerToShortlist: backfill for ${symbol} could not start — ${error instanceof Error ? error.message : error}`);
  }

  return { id: entry.id, addedAt: entry.added_at, notes: entry.notes, backfillRun };
}
