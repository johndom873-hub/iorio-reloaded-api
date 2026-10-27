import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// What drives Pluto's loop (Marcelo, 2026-10-06; the band's quotes since Signals was retired 2026-10-27): the CC + Put
// Ladder's band quotes the market quote loop writes, one row per contract, each with its own quoted_at. Pluto remembers the quoted_at it last analysed per contract and only analyses a ticker again when at
// least one of its contracts carries a newer one, so the same quote is never analysed twice. In memory: after a
// restart every contract quoted today counts as new once.

export interface BandQuoteStamp {
  symbol: string;
  expiry: string;
  strike: number;
  right: string;
  quotedAtMs: number;
}

export interface NewlyQuoted {
  /** Tickers with at least one contract quoted since Pluto last analysed it, sorted. */
  symbols: string[];
  /** How many contracts carry a newer quote. */
  contractCount: number;
  /** The stamps to remember once the analysis has run. */
  stamps: BandQuoteStamp[];
}

export function contractKey(stamp: Pick<BandQuoteStamp, "symbol" | "expiry" | "strike" | "right">): string {
  return `${stamp.symbol}|${stamp.expiry}|${stamp.strike}|${stamp.right}`;
}

/** Pure: the contracts whose quoted_at is newer than the one last analysed. */
export function findNewlyQuotedContracts(stamps: BandQuoteStamp[], lastAnalysedQuotedAtMs: Map<string, number>): NewlyQuoted {
  const fresh = stamps.filter((stamp) => stamp.quotedAtMs > (lastAnalysedQuotedAtMs.get(contractKey(stamp)) ?? Number.NEGATIVE_INFINITY));
  return { symbols: [...new Set(fresh.map((stamp) => stamp.symbol))].sort(), contractCount: fresh.length, stamps: fresh };
}

export function rememberAnalysed(stamps: BandQuoteStamp[], lastAnalysedQuotedAtMs: Map<string, number>): void {
  for (const stamp of stamps) lastAnalysedQuotedAtMs.set(contractKey(stamp), stamp.quotedAtMs);
}

/** Today's (US/Eastern) error-free band quotes the market quote loop wrote for the tickers Pluto may trade. */
export async function loadTodaysBandQuoteStamps(now: Date = new Date()): Promise<BandQuoteStamp[]> {
  const rows: { symbol: string; expiry: string; strike: string; right: string; quotedAt: Date | string }[] = await db("ladder_band_quotes as q")
    .join("shortlist_entries as se", "se.ticker_id", "q.ticker_id")
    .join("tickers as t", "t.id", "q.ticker_id")
    .whereNull("se.removed_at")
    .where("se.bot_enabled", true)
    .whereNull("q.error_code")
    .select("t.symbol", db.raw("q.expiry::text as expiry"), "q.strike", "q.option_right as right", "q.quoted_at as quotedAt");
  const todayIso = easternIsoDate(now);
  return rows
    .map((row) => ({ symbol: row.symbol, expiry: row.expiry, strike: Number(row.strike), right: row.right, quotedAtMs: new Date(row.quotedAt).getTime() }))
    .filter((stamp) => easternIsoDate(new Date(stamp.quotedAtMs)) === todayIso);
}

/** True once the market quote loop has written an error-free band quote today for a ticker Pluto may trade (the opening look's "data in"). */
export async function hasTodaysBandQuotes(now: Date = new Date()): Promise<boolean> {
  return (await loadTodaysBandQuoteStamps(now)).length > 0;
}
