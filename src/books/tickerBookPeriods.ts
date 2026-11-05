import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { BookKey } from "./bookKeys.js";

// Which book a ticker, and a leg on it, belonged to at a moment (Marcelo 2026-11-05). A ticker is Pluto's during each of
// its ticker_book_periods (opened when Pluto is switched on for it, closed when switched off) and Manual's otherwise.
// A hedge (a protective Put) is always Manual's, on any ticker, as it is outside Pluto's book today (book.ts).
// Example: AMD switched on 5 Nov 14:00 UTC → a fill on AMD at 13:59 is Manual's, at 14:01 Pluto's.

export interface TickerBookPeriod {
  tickerId: string;
  startedAt: Date;
  endedAt: Date | null;
}

export const strategiesAlwaysInManualBook = ["hedge"];

/** Pure: the book of `tickerId` at `at`, given every Pluto period. */
export function bookOfTickerAt(periods: readonly TickerBookPeriod[], tickerId: string, at: Date): BookKey {
  const time = at.getTime();
  const inPlutoPeriod = periods.some((period) => period.tickerId === tickerId && period.startedAt.getTime() <= time && (period.endedAt === null || period.endedAt.getTime() > time));
  return inPlutoPeriod ? "pluto" : "manual";
}

/** Pure: the book of a leg of a position with `strategyKey` on `tickerId`, at `at`. */
export function bookOfLegAt(periods: readonly TickerBookPeriod[], tickerId: string, strategyKey: string, at: Date): BookKey {
  if (strategiesAlwaysInManualBook.includes(strategyKey)) return "manual";
  return bookOfTickerAt(periods, tickerId, at);
}

export async function loadTickerBookPeriods(connection: Knex = db): Promise<TickerBookPeriod[]> {
  const rows: { ticker_id: string; started_at: Date; ended_at: Date | null }[] = await connection("ticker_book_periods").where({ book_key: "pluto" }).select("ticker_id", "started_at", "ended_at");
  return rows.map((row) => ({ tickerId: row.ticker_id, startedAt: new Date(row.started_at), endedAt: row.ended_at === null ? null : new Date(row.ended_at) }));
}
