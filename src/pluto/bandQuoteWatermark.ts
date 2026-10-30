import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// What drives Pluto's loop (Marcelo, 2026-10-06; the band's quotes since Signals was retired 2026-10-27, its finished
// cycles since 2026-10-30): the market quote loop quotes the option quote band for both strategies in cycles and records
// each ticker's newest finished cycle once all of its quotes are stored (option_quote_band_cycles). Pluto remembers the
// finished cycle it last analysed per ticker and only analyses a ticker again when a newer one has finished, so a cycle is
// never analysed twice, nor while it is still being stored. In memory: after a restart each ticker's cycle today counts as
// new once.

export interface FinishedBandCycleStamp {
  symbol: string;
  finishedAtMs: number;
}

export interface NewlyFinished {
  /** Tickers whose band cycle finished since Pluto last analysed them, sorted. */
  symbols: string[];
  /** The stamps to remember once the analysis has run. */
  stamps: FinishedBandCycleStamp[];
}

/** Pure: the tickers whose newest finished cycle is newer than the one last analysed. */
export function findNewlyFinishedBandCycles(stamps: FinishedBandCycleStamp[], lastAnalysedFinishedAtMs: Map<string, number>): NewlyFinished {
  const fresh = stamps.filter((stamp) => stamp.finishedAtMs > (lastAnalysedFinishedAtMs.get(stamp.symbol) ?? Number.NEGATIVE_INFINITY));
  return { symbols: fresh.map((stamp) => stamp.symbol).sort(), stamps: fresh };
}

export function rememberAnalysed(stamps: FinishedBandCycleStamp[], lastAnalysedFinishedAtMs: Map<string, number>): void {
  for (const stamp of stamps) lastAnalysedFinishedAtMs.set(stamp.symbol, stamp.finishedAtMs);
}

/** Today's (US/Eastern) newest finished band cycle of each ticker Pluto may trade. */
export async function loadTodaysFinishedBandCycles(now: Date = new Date()): Promise<FinishedBandCycleStamp[]> {
  const rows: { symbol: string; finishedAt: Date | string }[] = await db("option_quote_band_cycles as c")
    .join("shortlist_entries as se", "se.ticker_id", "c.ticker_id")
    .join("tickers as t", "t.id", "c.ticker_id")
    .whereNull("se.removed_at")
    .where("se.bot_enabled", true)
    .whereRaw("c.trading_date::text = ?", [easternIsoDate(now)])
    .select("t.symbol", "c.finished_at as finishedAt");
  return rows.map((row) => ({ symbol: row.symbol, finishedAtMs: new Date(row.finishedAt).getTime() }));
}

/**
 * True once the market quote loop has finished a band cycle today with an error-free quote, on a ticker Pluto may trade
 * (the opening look's "data in").
 */
export async function hasTodaysBandQuotes(now: Date = new Date()): Promise<boolean> {
  const row = await db("option_quote_band_cycles as c")
    .join("shortlist_entries as se", "se.ticker_id", "c.ticker_id")
    .join("option_quote_band_quotes as q", function () {
      this.on("q.ticker_id", "c.ticker_id").andOn("q.trading_date", "c.trading_date").andOn("q.quoted_at", ">=", "c.started_at");
    })
    .whereNull("se.removed_at")
    .where("se.bot_enabled", true)
    .whereNull("q.error_code")
    .whereRaw("c.trading_date::text = ?", [easternIsoDate(now)])
    .first(db.raw("1 as found"));
  return row !== undefined;
}
