import { db } from "../db/connection.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";

// What drives Pluto's loop (Marcelo, 2026-10-06): the Day Signals table, one row per contract, each with its own
// quoted_at. Pluto remembers the quoted_at it last analysed per contract and only analyses a ticker again when at
// least one of its contracts carries a newer one, so the same quote is never analysed twice. In memory: after a
// restart every contract quoted today counts as new once.

export interface DaySignalQuoteStamp {
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
  stamps: DaySignalQuoteStamp[];
}

export function contractKey(stamp: Pick<DaySignalQuoteStamp, "symbol" | "expiry" | "strike" | "right">): string {
  return `${stamp.symbol}|${stamp.expiry}|${stamp.strike}|${stamp.right}`;
}

/** Pure: the contracts whose quoted_at is newer than the one last analysed. */
export function findNewlyQuotedContracts(stamps: DaySignalQuoteStamp[], lastAnalysedQuotedAtMs: Map<string, number>): NewlyQuoted {
  const fresh = stamps.filter((stamp) => stamp.quotedAtMs > (lastAnalysedQuotedAtMs.get(contractKey(stamp)) ?? Number.NEGATIVE_INFINITY));
  return { symbols: [...new Set(fresh.map((stamp) => stamp.symbol))].sort(), contractCount: fresh.length, stamps: fresh };
}

export function rememberAnalysed(stamps: DaySignalQuoteStamp[], lastAnalysedQuotedAtMs: Map<string, number>): void {
  for (const stamp of stamps) lastAnalysedQuotedAtMs.set(contractKey(stamp), stamp.quotedAtMs);
}

/** Today's (US/Eastern) error-free Day Signals quotes on the tickers Pluto may trade. */
export async function loadTodaysDaySignalQuoteStamps(now: Date = new Date()): Promise<DaySignalQuoteStamp[]> {
  const rows: { symbol: string; expiry: string; strike: string; right: string; quotedAt: Date | string }[] = await db("day_signal_quotes as q")
    .join("shortlist_entries as se", "se.ticker_id", "q.ticker_id")
    .join("tickers as t", "t.id", "q.ticker_id")
    .whereNull("se.removed_at")
    .where("se.bot_enabled", true)
    .whereNull("q.error_code")
    .select("t.symbol", db.raw("q.expiry::text as expiry"), "q.strike", "q.option_right as right", "q.quoted_at as quotedAt");
  const todayIso = easternDateIso(now);
  return rows
    .map((row) => ({ symbol: row.symbol, expiry: row.expiry, strike: Number(row.strike), right: row.right, quotedAtMs: new Date(row.quotedAt).getTime() }))
    .filter((stamp) => easternDateIso(new Date(stamp.quotedAtMs)) === todayIso);
}
