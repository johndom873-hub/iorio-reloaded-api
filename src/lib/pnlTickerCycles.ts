import { db } from "../db/connection.js";
import { bookOfTickerAt, loadTickerBookPeriods } from "../books/tickerBookPeriods.js";
import type { BookKey } from "../books/bookKeys.js";
import { loadCycleInputsForTickers } from "./cycleQueries.js";
import { deriveCycles, type CycleBucket } from "./cycles.js";
import { bookBaselineNight, resolveRange, type AnalysisBook } from "./pnlAnalysis.js";
import { attributeTickerCycles, attributionBuckets, bucketBookAtNight, isEmptyBucketAttribution, splitNightAtMoves, type BucketAttribution } from "./pnlAttribution.js";
import { cycleInputAsOfNight, cycleInputAtMove, loadBookMoves, loadNightlyMarks, nightCapturedAtOrAfter, nightEndsAt } from "./pnlAttributionSnapshots.js";

// The P&L Analyser's drill-down (Marcelo 2026-11-13): one ticker's cycles over a range, each bucket's change split by the
// book it was in each night (split at a move between the books, as nightChanges does), computed on request from the same as-of-night ledger and snapshot prices as the stored
// attribution (pnlAttributionSnapshots.ts), so a ticker's cycles add up to its row in the analysis.

export interface TickerCycleRow {
  /** The cycle's identity: its start, ISO. */
  cycleStartedAt: string;
  cycleEndedAt: string | null;
  status: "open" | "closed";
  book: BookKey;
  bucket: CycleBucket;
  premiumGross: number;
  stockGross: number;
  commissions: number;
  total: number;
  unrealizedChange: number;
  capitalDays: number;
  flaggedChange: number;
  flagReasons: string[];
}

export interface TickerCycleAnalysis {
  symbol: string;
  range: { baselineNight: string; lastNight: string } | null;
  rows: TickerCycleRow[];
}

function calendarDaysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

/** Null when the symbol is unknown. */
export async function loadTickerCycleAnalysis(symbol: string, book: AnalysisBook, firstDay: string | null, lastDay: string | null): Promise<TickerCycleAnalysis | null> {
  const ticker = await db("tickers").where({ symbol }).first("id");
  if (!ticker) return null;
  const [nightRows, booksFirst] = await Promise.all([
    db.raw(`SELECT snapshot_date::text AS night, captured_at AS "capturedAt" FROM account_pnl_snapshots ORDER BY snapshot_date`),
    db("book_value_snapshots").first(db.raw("min(snapshot_date)::text AS first")),
  ]);
  const nights: string[] = nightRows.rows.map((row: { night: string }) => row.night);
  const capturedAtByNight = new Map<string, Date>(nightRows.rows.map((row: { night: string; capturedAt: Date }) => [row.night, new Date(row.capturedAt)]));
  const range = resolveRange(nights, firstDay, lastDay);
  if (range === null) return { symbol, range: null, rows: [] };
  const baselineNight = bookBaselineNight(book, range.baselineNight, booksFirst?.first ?? null);
  if (baselineNight >= range.lastNight) return { symbol, range: null, rows: [] };
  const rangeNights = nights.filter((night) => night >= baselineNight && night <= range.lastNight);

  const [[symbolInput], periods, marks, allMoves] = await Promise.all([loadCycleInputsForTickers([ticker.id]), loadTickerBookPeriods(), loadNightlyMarks(rangeNights, "nightlySnapshot"), loadBookMoves()]);
  if (!symbolInput) return { symbol, range: { baselineNight, lastNight: range.lastNight }, rows: [] };

  // Each night: every cycle's attribution by bucket, keyed by its start.
  const byNight = rangeNights.map((night) => {
    const asOfNight = cycleInputAsOfNight(symbolInput.input, ticker.id, night, marks.snapshotMarksByNight.get(night) ?? new Map(), marks.snapshotPricesByNight?.get(night) ?? null, capturedAtByNight.get(night) ?? null);
    const cycles = asOfNight === null ? [] : deriveCycles(asOfNight);
    return { night, cycles: new Map(cycles.map((cycle) => [cycle.startAt.toISOString(), { cycle, buckets: attributeTickerCycles([cycle], asOfNight!) }])) };
  });

  // Each move between the books inside the range: the cycles' attribution at the move, by the night it falls in.
  const movesByNight = new Map<string, { movedAt: Date; fromBook: BookKey; cycles: Map<string, Record<CycleBucket, BucketAttribution>> }[]>();
  for (const move of allMoves) {
    if (move.tickerId !== ticker.id) continue;
    const night = nightCapturedAtOrAfter(nights, capturedAtByNight, move.movedAt);
    if (night === null || night <= baselineNight || night > range.lastNight) continue;
    const previousNight = nights[nights.indexOf(night) - 1]!;
    const atMove = cycleInputAtMove(symbolInput.input, move, marks.snapshotMarksByNight.get(previousNight) ?? new Map());
    const cycles = atMove === null ? [] : deriveCycles(atMove);
    movesByNight.set(night, [...(movesByNight.get(night) ?? []), { movedAt: move.movedAt, fromBook: move.fromBook, cycles: new Map(cycles.map((cycle) => [cycle.startAt.toISOString(), attributeTickerCycles([cycle], atMove!)])) }]);
  }

  const latestCycles = byNight.at(-1)!.cycles;
  const totals = new Map<string, TickerCycleRow>();
  for (let index = 1; index < byNight.length; index += 1) {
    const { night, cycles } = byNight[index]!;
    const previous = byNight[index - 1]!;
    const tickerBook = bookOfTickerAt(periods, ticker.id, capturedAtByNight.get(night) ?? nightEndsAt(night));
    const daysHeld = calendarDaysBetween(previous.night, night);
    const nightMoves = movesByNight.get(night) ?? [];
    const nightSpan = { startsAt: capturedAtByNight.get(previous.night) ?? nightEndsAt(previous.night), endsAt: capturedAtByNight.get(night) ?? nightEndsAt(night) };
    for (const cycleKey of new Set([...cycles.keys(), ...previous.cycles.keys(), ...nightMoves.flatMap((move) => [...move.cycles.keys()])])) {
      const now = cycles.get(cycleKey);
      const before = previous.cycles.get(cycleKey);
      for (const bucket of attributionBuckets) {
        const nowBucket: BucketAttribution | undefined = now?.buckets[bucket];
        const beforeBucket: BucketAttribution | undefined = before?.buckets[bucket];
        const moveBuckets = nightMoves.map((move) => move.cycles.get(cycleKey)?.[bucket]);
        if ([nowBucket, beforeBucket, ...moveBuckets].every((attribution) => attribution === undefined || isEmptyBucketAttribution(attribution))) continue;
        const segments = splitNightAtMoves(bucket, beforeBucket, nowBucket, bucketBookAtNight(bucket, tickerBook), nightMoves.map((move, index) => ({ atMove: moveBuckets[index], movedAt: move.movedAt, fromBook: move.fromBook })), nightSpan);
        for (const segment of segments) {
          if (book !== "all" && segment.book !== book) continue;
          const change = (pick: (attribution: BucketAttribution) => number) => (segment.to ? pick(segment.to) : 0) - (segment.from ? pick(segment.from) : 0);
          const reference = (now ?? before)?.cycle ?? latestCycles.get(cycleKey)?.cycle;
          const latest = latestCycles.get(cycleKey)?.cycle ?? reference;
          const key = `${cycleKey}|${segment.book}|${bucket}`;
          const row = totals.get(key) ?? {
            cycleStartedAt: cycleKey,
            cycleEndedAt: latest?.endAt?.toISOString() ?? null,
            status: latest?.status ?? "closed",
            book: segment.book,
            bucket,
            premiumGross: 0, stockGross: 0, commissions: 0, total: 0, unrealizedChange: 0, capitalDays: 0, flaggedChange: 0,
            flagReasons: [],
          };
          row.premiumGross += change((attribution) => attribution.premiumGross);
          row.stockGross += change((attribution) => attribution.stockGross);
          row.commissions += change((attribution) => attribution.commissions);
          row.total += change((attribution) => attribution.total);
          row.unrealizedChange += change((attribution) => attribution.unrealized);
          row.flaggedChange += change((attribution) => attribution.flaggedTotal);
          row.capitalDays += (segment.from?.capital ?? 0) * daysHeld * segment.timeShare;
          row.flagReasons = [...new Set([...row.flagReasons, ...(segment.to?.flagReasons ?? [])])];
          totals.set(key, row);
        }
      }
    }
  }
  const rows = [...totals.values()].filter((row) => row.total !== 0 || row.capitalDays !== 0 || row.flaggedChange !== 0 || row.unrealizedChange !== 0);
  return { symbol, range: { baselineNight, lastNight: range.lastNight }, rows: rows.sort((first, second) => second.cycleStartedAt.localeCompare(first.cycleStartedAt)) };
}
