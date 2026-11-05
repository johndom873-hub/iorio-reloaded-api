import { db } from "../db/connection.js";
import { previousOpenSessionDate } from "../lib/marketSessionStatus.js";
import type { PerformanceSnapshotRow } from "../lib/performanceReturns.js";
import { isBookKey, type BookKey } from "./bookKeys.js";

// A book's figures for the Dashboard's book switch (formulas approved by Marcelo 2026-11-05). Per-book history starts at
// the cut-over; the All books view keeps the account's own figures.
//   a book's day      = tonight's book value − last night's − cash moved into the book in between (deposit splits and
//                       moves between books; a ticker transfer swaps cash for positions at equal value and is not a move)
//   its performance   = the account's time-weighted method (performanceReturns.ts) on its nightly values, the moves as flows
//   P&L by strategy   = each position's daily P&L in the book its ticker belonged to that night (bookOfPositionAtNightSql)
//   Residual          = the book's day − its strategies' P&L (interest, fees, GST)
// Example: Manual $400,000 last night, $412,000 tonight with $10,000 of a deposit split into it → its day is +$2,000.

/** The book a Dashboard request asks for: ?book=pluto|manual; anything else (or none) is All books. */
export function requestedBook(query: { book?: unknown }): BookKey | null {
  return isBookKey(query.book) ? query.book : null;
}

export interface BookDailyRow {
  snapshotDate: string;
  bookValue: number;
  /** Cash moved into the book since the previous snapshot (deposit splits, moves between books). */
  movedIn: number;
  /** Null on the first row (the cut-over's). */
  dailyPnl: number | null;
}

/** The book's nightly values with each night's moves and P&L, oldest first. */
export async function loadBookDailySeries(book: BookKey): Promise<BookDailyRow[]> {
  const [snapshots, moves] = await Promise.all([
    db("book_value_snapshots").where({ book_key: book }).orderBy("snapshot_date").select(db.raw("snapshot_date::text AS snapshot_date"), "book_value", "captured_at") as Promise<{ snapshot_date: string; book_value: string; captured_at: Date }[]>,
    db("book_cash_entries").where({ book_key: book }).whereIn("kind", ["deposit_split", "book_move"]).select("amount", "effective_at") as Promise<{ amount: string; effective_at: Date }[]>,
  ]);
  return snapshots.map((snapshot, index) => {
    const previous = index === 0 ? null : snapshots[index - 1]!;
    const capturedAt = new Date(snapshot.captured_at).getTime();
    const previousAt = previous === null ? Number.NEGATIVE_INFINITY : new Date(previous.captured_at).getTime();
    const movedIn = previous === null ? 0 : moves.filter((move) => new Date(move.effective_at).getTime() > previousAt && new Date(move.effective_at).getTime() <= capturedAt).reduce((sum, move) => sum + Number(move.amount), 0);
    const bookValue = Number(snapshot.book_value);
    return { snapshotDate: snapshot.snapshot_date, bookValue, movedIn, dailyPnl: previous === null ? null : bookValue - Number(previous.book_value) - movedIn };
  });
}

/** The series as the performance summary reads snapshot rows. */
export function bookPerformanceRows(series: readonly BookDailyRow[]): PerformanceSnapshotRow[] {
  return series.map((row) => ({ snapshotDate: row.snapshotDate, netLiquidationValue: row.bookValue, netCashFlow: row.movedIn }));
}

/** Monday of `dateIso`'s ISO week, and the first of its month and year (YYYY-MM-DD). */
function periodStarts(dateIso: string): { week: string; month: string; year: string } {
  const date = new Date(`${dateIso}T12:00:00Z`);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - mondayOffset);
  return { week: monday.toISOString().slice(0, 10), month: `${dateIso.slice(0, 7)}-01`, year: `${dateIso.slice(0, 4)}-01-01` };
}

/** Pure: the book's day (only when the previous row is the previous open session) and its week, month and year to date. */
export function bookPeriodPnl(series: readonly BookDailyRow[], todayIso: string, previousSessionOfLatest: string | null): { day: number | null; week: number; month: number; year: number } {
  const starts = periodStarts(todayIso);
  const sumFrom = (start: string) => series.filter((row) => row.snapshotDate >= start && row.dailyPnl !== null).reduce((sum, row) => sum + row.dailyPnl!, 0);
  const latest = series.at(-1);
  const previous = series.at(-2);
  const day = latest && previous && latest.dailyPnl !== null && previous.snapshotDate === previousSessionOfLatest ? latest.dailyPnl : null;
  return { day, week: sumFrom(starts.week), month: sumFrom(starts.month), year: sumFrom(starts.year) };
}

/** The book's summary figures for the Dashboard's tiles: last night's value, its day and its period P&L. */
export async function loadBookSummary(book: BookKey, todayIso: string) {
  const series = await loadBookDailySeries(book);
  const latest = series.at(-1) ?? null;
  const periods = bookPeriodPnl(series, todayIso, latest ? await previousOpenSessionDate(latest.snapshotDate) : null);
  const base = latest !== null && periods.day !== null ? latest.bookValue - latest.movedIn - periods.day : null;
  return {
    series,
    asOf: latest?.snapshotDate ?? null,
    bookValue: latest?.bookValue ?? null,
    periods,
    dayPnlPercent: base !== null && base !== 0 ? (periods.day! / base) * 100 : null,
  };
}

/**
 * SQL: the book ('pluto' or 'manual') of the position aliased `positionAlias` at the end of the New York day `dateSql`
 * (a date expression): Pluto's while its ticker is in a ticker_book_periods row then, hedges always Manual's.
 */
export function bookOfPositionAtNightSql(positionAlias: string, dateSql: string): string {
  const nightEnd = `((${dateSql})::date + 1)::timestamp AT TIME ZONE 'America/New_York'`;
  return `(CASE WHEN ${positionAlias}.strategy_key = 'hedge' THEN 'manual'
    WHEN EXISTS (SELECT 1 FROM ticker_book_periods tbp WHERE tbp.ticker_id = ${positionAlias}.ticker_id AND tbp.started_at < ${nightEnd} AND (tbp.ended_at IS NULL OR tbp.ended_at >= ${nightEnd})) THEN 'pluto'
    ELSE 'manual' END)`;
}

/** SQL: the position's book now. */
export function bookOfPositionNowSql(positionAlias: string): string {
  return `(CASE WHEN ${positionAlias}.strategy_key = 'hedge' THEN 'manual'
    WHEN EXISTS (SELECT 1 FROM ticker_book_periods tbp WHERE tbp.ticker_id = ${positionAlias}.ticker_id AND tbp.ended_at IS NULL) THEN 'pluto'
    ELSE 'manual' END)`;
}

/** The first New York date of the books' history (the cut-over's), or null before the books are started. */
export async function loadBooksFirstDate(): Promise<string | null> {
  const row = await db("book_value_snapshots").first(db.raw("min(snapshot_date)::text AS first"));
  return row?.first ?? null;
}

/** Each open position's book now. */
export async function loadOpenPositionBooksNow(): Promise<Map<string, BookKey>> {
  const result = await db.raw(`SELECT p.id, ${bookOfPositionNowSql("p")} AS book FROM positions p WHERE p.status = 'open'`);
  return new Map((result.rows as { id: string; book: BookKey }[]).map((row) => [row.id, row.book]));
}

/** Each position's book now, open or closed (the Dashboard's Latest Transactions). */
export async function loadPositionBooksNow(positionIds: readonly string[]): Promise<Map<string, BookKey>> {
  if (positionIds.length === 0) return new Map();
  const rows: { id: string; book: BookKey }[] = await db("positions as p").whereIn("p.id", [...positionIds]).select("p.id", db.raw(`${bookOfPositionNowSql("p")} AS book`));
  return new Map(rows.map((row) => [row.id, row.book]));
}

/**
 * Each position's book now and its cost adjustment: what its open legs' sources took when moved between the books at
 * the mark (book_leg_transfers). The book's own unrealised is the position's unrealised less the adjustment (Marcelo
 * 2026-11-05: the book's cost is the transfer's mark). Read by the positions list, outside positionSelect, which the
 * trading worker also loads.
 */
export async function loadPositionBookFigures(positionIds: readonly string[]): Promise<Map<string, { bookKey: BookKey; bookCostAdjustmentDollars: number }>> {
  if (positionIds.length === 0) return new Map();
  const rows: { id: string; book: BookKey; adjustment: number }[] = await db("positions as p")
    .whereIn("p.id", [...positionIds])
    .select(
      "p.id",
      db.raw(`${bookOfPositionNowSql("p")} AS book`),
      db.raw(`COALESCE((SELECT SUM(blt.realized_dollars) FROM book_leg_transfers blt JOIN position_legs transferred ON transferred.id = blt.position_leg_id
        WHERE transferred.position_id = p.id AND transferred.exit_at IS NULL), 0)::float AS adjustment`),
    );
  return new Map(rows.map((row) => [row.id, { bookKey: row.book, bookCostAdjustmentDollars: row.adjustment }]));
}
