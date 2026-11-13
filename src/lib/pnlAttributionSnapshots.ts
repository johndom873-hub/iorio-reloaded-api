import { db } from "../db/connection.js";
import { bookOfTickerAt, loadTickerBookPeriods, type TickerBookPeriod } from "../books/tickerBookPeriods.js";
import { loadCycleInputsForTickers, type SymbolCycleInput, type SymbolCycles } from "./cycleQueries.js";
import { loadSnapshotMarksBetween, openingFillsAfter, truncateCycleInputAt, type SnapshotMarks } from "./cyclePeriodPnl.js";
import { deriveCycles, type CycleBucket, type CycleInput } from "./cycles.js";
import { easternInstant, easternIsoDate } from "./easternIsoDate.js";
import { closedShortOptionResults, type StoredClosedShortOption } from "./shortOptionTradeStats.js";
import { attributeTickerCycles, attributionBuckets, bucketBookAtNight, emptyBucketAttribution, isEmptyBucketAttribution, type BucketAttribution } from "./pnlAttribution.js";
import type { BookKey } from "../books/bookKeys.js";

// Writes pnl_attribution_snapshots (see pnlAttribution.ts) for the nightly P&L snapshot's nights. Every run recomputes the
// nights that were never computed (the first run on an environment fills its whole history) and the most recent ones, which
// a late fill, a corrected leg or a statement can still change.

export const recentNightsRecomputed = 10;

export interface AttributionRow extends BucketAttribution {
  snapshotDate: string;
  tickerId: string;
  symbol: string;
  bucket: CycleBucket;
  bookKey: BookKey;
}

/** A ticker's attribution at a move between the books during a night (pnl_attribution_move_snapshots). */
export interface AttributionMoveRow extends BucketAttribution {
  snapshotDate: string;
  tickerId: string;
  symbol: string;
  bucket: CycleBucket;
  movedAt: Date;
  fromBook: BookKey;
  toBook: BookKey;
}

/** One switch of a ticker between the books (book_leg_transfers, one group): its open legs and their marks. */
export interface BookMove {
  tickerId: string;
  movedAt: Date;
  fromBook: BookKey;
  toBook: BookKey;
  legs: { legId: string; legType: "stock" | "option"; quantity: number; markPrice: number }[];
}

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The moment a night ends (midnight New York), when its book is read, as bookOfPositionAtNightSql does. */
export function nightEndsAt(snapshotDate: string): Date {
  return easternInstant(addDays(snapshotDate, 1), 0, 0);
}

/**
 * The stock price the nightly P&L snapshot valued each ticker's shares at, by night then ticker id: `exact` from its legs'
 * price snapshots (from 2026-11-02), `implied` before those existed from the position snapshot, (Σ entry × shares + stock
 * P&L) ÷ shares with today's legs, so only usable while the ticker's legs have not grown since (see openingFillsAfter).
 */
export async function loadSnapshotStockPricesBetween(firstNight: string, lastNight: string): Promise<Map<string, { exact: Map<string, number>; implied: Map<string, number> }>> {
  const nightEnd = `((ps.snapshot_date + 1)::timestamp AT TIME ZONE 'America/New_York')`;
  const [fromLegs, fromPositions] = await Promise.all([
    db.raw(
      `SELECT s.snapshot_date::text AS night, p.ticker_id AS "tickerId", (SUM(s.price * pl.quantity) / NULLIF(SUM(pl.quantity), 0))::float AS price
       FROM position_leg_price_snapshots s JOIN position_legs pl ON pl.id = s.position_leg_id AND pl.leg_type = 'stock' JOIN positions p ON p.id = pl.position_id
       WHERE s.snapshot_date BETWEEN ?::date AND ?::date AND s.price IS NOT NULL GROUP BY s.snapshot_date, p.ticker_id`,
      [firstNight, lastNight],
    ),
    db.raw(
      `SELECT ps.snapshot_date::text AS night, p.ticker_id AS "tickerId", ((SUM(held.cost) + SUM(ps.stock_pnl)) / NULLIF(SUM(held.shares), 0))::float AS price
       FROM position_pnl_snapshots ps JOIN positions p ON p.id = ps.position_id
       CROSS JOIN LATERAL (
         SELECT SUM(pl.entry_price * pl.quantity) AS cost, SUM(pl.quantity) AS shares FROM position_legs pl
         WHERE pl.position_id = p.id AND pl.leg_type = 'stock' AND pl.side = 'long' AND pl.entry_at < ${nightEnd} AND (pl.exit_at IS NULL OR pl.exit_at >= ${nightEnd})
       ) held
       WHERE ps.snapshot_date BETWEEN ?::date AND ?::date AND ps.stock_pnl IS NOT NULL AND held.shares > 0 GROUP BY ps.snapshot_date, p.ticker_id`,
      [firstNight, lastNight],
    ),
  ]);
  const pricesByNight = new Map<string, { exact: Map<string, number>; implied: Map<string, number> }>();
  const night = (key: string) => pricesByNight.get(key) ?? pricesByNight.set(key, { exact: new Map(), implied: new Map() }).get(key)!;
  for (const row of fromPositions.rows as { night: string; tickerId: string; price: number | null }[]) if (row.price !== null) night(row.night).implied.set(row.tickerId, row.price);
  for (const row of fromLegs.rows as { night: string; tickerId: string; price: number | null }[]) if (row.price !== null) night(row.night).exact.set(row.tickerId, row.price);
  return pricesByNight;
}

/** Each option leg's price in the nightly snapshot (from 2026-11-02), by night then leg id. */
export async function loadSnapshotOptionPricesBetween(firstNight: string, lastNight: string): Promise<Map<string, Map<string, number>>> {
  const result = await db.raw(
    `SELECT s.snapshot_date::text AS night, s.position_leg_id AS "legId", s.price::float AS price FROM position_leg_price_snapshots s JOIN position_legs pl ON pl.id = s.position_leg_id AND pl.leg_type = 'option'
     WHERE s.snapshot_date BETWEEN ?::date AND ?::date AND s.price IS NOT NULL`,
    [firstNight, lastNight],
  );
  const pricesByNight = new Map<string, Map<string, number>>();
  for (const row of result.rows as { night: string; legId: string; price: number }[]) (pricesByNight.get(row.night) ?? pricesByNight.set(row.night, new Map()).get(row.night)!).set(row.legId, row.price);
  return pricesByNight;
}

/** Everything a run of nights reads besides the ledger, loaded with one query per kind for the whole span. */
export interface NightlyMarks {
  snapshotMarksByNight: Map<string, Map<string, SnapshotMarks>>;
  snapshotPricesByNight: Map<string, NightlySnapshotPrices> | null;
}

export async function loadNightlyMarks(nights: readonly string[], stockMark: "dailyClose" | "nightlySnapshot"): Promise<NightlyMarks> {
  const sorted = [...nights].sort();
  const [first, last] = [sorted[0]!, sorted.at(-1)!];
  const [snapshotMarksByNight, stockPrices, optionPrices] = await Promise.all([
    loadSnapshotMarksBetween(first, last),
    stockMark === "nightlySnapshot" ? loadSnapshotStockPricesBetween(first, last) : Promise.resolve(null),
    stockMark === "nightlySnapshot" ? loadSnapshotOptionPricesBetween(first, last) : Promise.resolve(null),
  ]);
  if (stockPrices === null || optionPrices === null) return { snapshotMarksByNight, snapshotPricesByNight: null };
  const snapshotPricesByNight = new Map<string, NightlySnapshotPrices>();
  for (const night of sorted) snapshotPricesByNight.set(night, { stockPriceByTickerId: stockPrices.get(night) ?? { exact: new Map(), implied: new Map() }, optionPriceByLegId: optionPrices.get(night) ?? new Map() });
  return { snapshotMarksByNight, snapshotPricesByNight };
}

/**
 * The nightly snapshot's prices, which replace the cycles' own marks (Marcelo 2026-11-13): the books and IBKR's account
 * value are taken at about 17:30 ET, after-hours included, while the cycles mark shares at the 16:00 close (NVDA 11 Nov:
 * $173.73 at the close, $160.50 at the snapshot, $12,087 on 900 shares, back the next day). Options are marked at their leg
 * price against the leg as it stood that night: position_pnl_snapshots.premium_pnl was computed against that night's entry
 * price, which a leg opened that day still had as its fill, before the worker rewrote it to IBKR's average cost.
 */
export interface NightlySnapshotPrices {
  stockPriceByTickerId: { exact: ReadonlyMap<string, number>; implied: ReadonlyMap<string, number> };
  optionPriceByLegId: ReadonlyMap<string, number>;
}

/**
 * Pure, given the loaded ledger: every ticker's attribution rows for one night. Shares still held are marked at
 * `stockPrices` (the nightly snapshot's price) where one is given, else at the day's close. The night's book is the ticker's
 * at `capturedAt`, when the books' values were taken (Marcelo 2026-11-13), else at the night's end.
 */
export function attributionRowsForNight(snapshotDate: string, symbolInputs: readonly SymbolCycleInput[], snapshotMarks: Map<string, SnapshotMarks>, periods: readonly TickerBookPeriod[], snapshotPrices: NightlySnapshotPrices | null = null, capturedAt: Date | null = null): AttributionRow[] {
  const rows: AttributionRow[] = [];
  const tickerBookAt = capturedAt ?? nightEndsAt(snapshotDate);
  for (const { symbol, tickerId, input } of symbolInputs) {
    const asOfNight = cycleInputAsOfNight(input, tickerId, snapshotDate, snapshotMarks, snapshotPrices, capturedAt);
    if (asOfNight === null) continue;
    const buckets = attributeTickerCycles(deriveCycles(asOfNight), asOfNight);
    const tickerBook = bookOfTickerAt(periods, tickerId, tickerBookAt);
    for (const bucket of attributionBuckets) {
      if (isEmptyBucketAttribution(buckets[bucket])) continue;
      rows.push({ snapshotDate, tickerId, symbol, bucket, bookKey: bucketBookAtNight(bucket, tickerBook), ...buckets[bucket], flagReasons: [...new Set(buckets[bucket].flagReasons)] });
    }
  }
  return rows;
}

/**
 * When a night's ledger is cut (Marcelo 2026-11-13): when its values were taken, the books' and the snapshot prices', so
 * an event after them (IBKR's expiry and assignment records, about 20:45-22:40 ET) counts the next night, as in the books;
 * never after the night's own midnight, else the end of its day. Example: captured 17:30:25 ET → DRAM's 21:46 ET call-away
 * counts the next night.
 */
export function nightLedgerCutoffMs(snapshotDate: string, capturedAt: Date | null): number {
  const endOfDayMs = easternInstant(snapshotDate, 23, 59).getTime() + 59_999;
  return capturedAt === null ? endOfDayMs : Math.min(capturedAt.getTime(), endOfDayMs);
}

/**
 * Pure: one ticker's ledger as it stood at the end of a night (cut at nightLedgerCutoffMs), with the nightly snapshot's prices
 * in place of the cycles' own marks when given (see NightlySnapshotPrices); null when the ticker held nothing yet.
 */
export function cycleInputAsOfNight(input: CycleInput, tickerId: string, snapshotDate: string, snapshotMarks: Map<string, SnapshotMarks>, snapshotPrices: NightlySnapshotPrices | null, capturedAt: Date | null = null): CycleInput | null {
  const cutoffMs = nightLedgerCutoffMs(snapshotDate, capturedAt);
  const truncated = truncateCycleInputAt(input, cutoffMs, snapshotDate, snapshotMarks);
  if (truncated.optionLegs.length === 0 && truncated.stockLegs.length === 0 && truncated.stockTrades.length === 0) return null;
  if (snapshotPrices === null) return truncated;
  return withNightlySnapshotPrices(truncated, input, tickerId, snapshotDate, snapshotPrices, cutoffMs);
}

/**
 * Pure: `ledger` with one night's snapshot prices in place of the cycles' own marks (see NightlySnapshotPrices): the shares
 * still held at the ticker's snapshot stock price (the implied one only while `fullInput`'s legs have not grown since
 * `cutoffMs`), each open option position at its legs' snapshot prices when every one of them has one. Marks it cannot
 * replace stay as they were.
 */
export function withNightlySnapshotPrices(ledger: CycleInput, fullInput: CycleInput, tickerId: string, snapshotDate: string, snapshotPrices: NightlySnapshotPrices, cutoffMs: number): CycleInput {
  const legsGrewSince = fullInput.stockLegs.some((leg) => leg.entryAt.getTime() <= cutoffMs && openingFillsAfter(leg, cutoffMs).length > 0);
  const stockPrice = snapshotPrices.stockPriceByTickerId.exact.get(tickerId) ?? (legsGrewSince ? undefined : snapshotPrices.stockPriceByTickerId.implied.get(tickerId));
  const openPositionPremiumPnl = new Map(ledger.openPositionPremiumPnl);
  const openPositionMarkDate = new Map(ledger.openPositionMarkDate ?? []);
  const openPositionPremiumPnlUnavailable = new Set(ledger.openPositionPremiumPnlUnavailable ?? []);
  const openLegsByPosition = new Map<string, CycleInput["optionLegs"]>();
  for (const leg of ledger.optionLegs) if (leg.exitAt === null) openLegsByPosition.set(leg.positionId, [...(openLegsByPosition.get(leg.positionId) ?? []), leg]);
  for (const [positionId, legs] of openLegsByPosition) {
    const prices = legs.map((leg) => snapshotPrices.optionPriceByLegId.get(leg.id));
    if (prices.some((price) => price === undefined)) continue;
    openPositionPremiumPnl.set(positionId, legs.reduce((sum, leg, index) => sum + (leg.side === "short" ? 1 : -1) * (leg.entryPrice - prices[index]!) * leg.quantity * leg.multiplier, 0));
    openPositionMarkDate.set(positionId, snapshotDate);
    openPositionPremiumPnlUnavailable.delete(positionId);
  }
  return { ...ledger, openPositionPremiumPnl, openPositionMarkDate, openPositionPremiumPnlUnavailable, ...(stockPrice === undefined ? {} : { lastPrice: { date: snapshotDate, price: stockPrice, source: "snapshot" as const } }) };
}

/**
 * The given tickers' ledgers as they stand now, open legs marked at the latest nightly snapshot's prices (Marcelo
 * 2026-11-13): the Ticker modal's Wheel cycle card, so it agrees with the P&L Analyser. A ticker whose daily close is newer
 * than that snapshot keeps the close.
 */
export async function loadCycleInputsAtLatestNightlySnapshot(tickerIds: string[]): Promise<SymbolCycleInput[]> {
  const [symbolInputs, latestNight] = await Promise.all([
    loadCycleInputsForTickers(tickerIds),
    db("account_pnl_snapshots").orderBy("snapshot_date", "desc").first(db.raw("snapshot_date::text AS night"), "captured_at"),
  ]);
  if (!latestNight) return symbolInputs;
  const night: string = latestNight.night;
  const { snapshotPricesByNight } = await loadNightlyMarks([night], "nightlySnapshot");
  const snapshotPrices = snapshotPricesByNight?.get(night);
  if (snapshotPrices === undefined) return symbolInputs;
  const cutoffMs = nightLedgerCutoffMs(night, latestNight.captured_at === null ? null : new Date(latestNight.captured_at));
  return symbolInputs.map((symbolInput) =>
    symbolInput.input.lastPrice !== null && symbolInput.input.lastPrice.date > night ? symbolInput : { ...symbolInput, input: withNightlySnapshotPrices(symbolInput.input, symbolInput.input, symbolInput.tickerId, night, snapshotPrices, cutoffMs) },
  );
}

/** The given tickers' cycles (oldest first) at the latest nightly snapshot's prices (loadCycleInputsAtLatestNightlySnapshot). */
export async function fetchCyclesAtLatestNightlySnapshot(tickerIds: string[]): Promise<SymbolCycles[]> {
  return (await loadCycleInputsAtLatestNightlySnapshot(tickerIds))
    .map(({ symbol, tickerId, input }) => ({ symbol, tickerId, cycles: deriveCycles(input) }))
    .filter((symbolCycles) => symbolCycles.cycles.length > 0);
}

/**
 * Pure: one ticker's ledger as it stood at a move between the books (Marcelo 2026-11-13): cut at the move's instant, its
 * open legs at their move marks (the moved shares' average mark for the shares still held), the options of positions that
 * did not move (hedges) at `previousNightMarks`. Null when the ticker held nothing yet.
 */
export function cycleInputAtMove(input: CycleInput, move: BookMove, previousNightMarks: Map<string, SnapshotMarks>): CycleInput | null {
  const truncated = truncateCycleInputAt(input, move.movedAt.getTime(), easternIsoDate(move.movedAt), previousNightMarks);
  if (truncated.optionLegs.length === 0 && truncated.stockLegs.length === 0 && truncated.stockTrades.length === 0) return null;
  const optionMarkByLegId = new Map(move.legs.filter((leg) => leg.legType === "option").map((leg) => [leg.legId, leg.markPrice]));
  const openPositionPremiumPnl = new Map(truncated.openPositionPremiumPnl);
  const openPositionPremiumPnlUnavailable = new Set(truncated.openPositionPremiumPnlUnavailable ?? []);
  const openLegsByPosition = new Map<string, CycleInput["optionLegs"]>();
  for (const leg of truncated.optionLegs) if (leg.exitAt === null) openLegsByPosition.set(leg.positionId, [...(openLegsByPosition.get(leg.positionId) ?? []), leg]);
  for (const [positionId, legs] of openLegsByPosition) {
    const marks = legs.map((leg) => optionMarkByLegId.get(leg.id));
    if (marks.some((mark) => mark === undefined)) continue;
    openPositionPremiumPnl.set(positionId, legs.reduce((sum, leg, index) => sum + (leg.side === "short" ? 1 : -1) * (leg.entryPrice - marks[index]!) * leg.quantity * leg.multiplier, 0));
    openPositionPremiumPnlUnavailable.delete(positionId);
  }
  const movedShares = move.legs.filter((leg) => leg.legType === "stock");
  const shareCount = movedShares.reduce((sum, leg) => sum + leg.quantity, 0);
  const stockMark = shareCount > 0 ? movedShares.reduce((sum, leg) => sum + leg.markPrice * leg.quantity, 0) / shareCount : null;
  return { ...truncated, openPositionPremiumPnl, openPositionPremiumPnlUnavailable, ...(stockMark === null ? {} : { lastPrice: { date: easternIsoDate(move.movedAt), price: stockMark } }) };
}

/** The night a moment falls in: the first night captured at or after it (nights in order), or null when none is yet. */
export function nightCapturedAtOrAfter(nights: readonly string[], capturedAtByNight: ReadonlyMap<string, Date>, at: Date): string | null {
  return nights.find((night) => (capturedAtByNight.get(night)?.getTime() ?? Number.NEGATIVE_INFINITY) >= at.getTime()) ?? null;
}

/**
 * Pure: the attribution at each move that falls in `snapshotDate` (captured after the previous night, by this one), every
 * bucket but the hedge (always Manual's), stored even when empty so the night always splits at the move.
 */
export function attributionMoveRowsForNight(snapshotDate: string, moves: readonly BookMove[], symbolInputs: readonly SymbolCycleInput[], previousNightMarks: Map<string, SnapshotMarks>): AttributionMoveRow[] {
  const rows: AttributionMoveRow[] = [];
  const inputByTickerId = new Map(symbolInputs.map((symbolInput) => [symbolInput.tickerId, symbolInput]));
  for (const move of moves) {
    const symbolInput = inputByTickerId.get(move.tickerId);
    if (!symbolInput) continue;
    const atMove = cycleInputAtMove(symbolInput.input, move, previousNightMarks);
    const buckets = atMove === null ? null : attributeTickerCycles(deriveCycles(atMove), atMove);
    for (const bucket of attributionBuckets) {
      if (bucket === "hedge") continue;
      const attribution = buckets?.[bucket] ?? emptyBucketAttribution();
      rows.push({ snapshotDate, tickerId: move.tickerId, symbol: symbolInput.symbol, bucket, movedAt: move.movedAt, fromBook: move.fromBook, toBook: move.toBook, ...attribution, flagReasons: [...new Set(attribution.flagReasons)] });
    }
  }
  return rows;
}

/** Read-only: the move rows of the given nights, by night (nights with no move are left out). */
export async function computeAttributionMoveNights(nights: readonly string[], ledger: AttributionLedger): Promise<Map<string, AttributionMoveRow[]>> {
  const rowsByNight = new Map<string, AttributionMoveRow[]>();
  const movesByNight = new Map<string, BookMove[]>();
  for (const move of ledger.moves) {
    const night = nightCapturedAtOrAfter(ledger.nights, ledger.capturedAtByNight, move.movedAt);
    if (night !== null && nights.includes(night)) movesByNight.set(night, [...(movesByNight.get(night) ?? []), move]);
  }
  for (const [night, moves] of movesByNight) {
    const previousNight = ledger.nights[ledger.nights.indexOf(night) - 1];
    if (previousNight === undefined) continue;
    const previousNightMarks = (await loadSnapshotMarksBetween(previousNight, previousNight)).get(previousNight) ?? new Map();
    rowsByNight.set(night, attributionMoveRowsForNight(night, moves, ledger.symbolInputs, previousNightMarks));
  }
  return rowsByNight;
}

/** The nights to compute now: every account snapshot night never computed, and the last `recentNightsRecomputed`. */
export async function nightsToCompute(): Promise<string[]> {
  const result = await db.raw(`
    SELECT s.snapshot_date::text AS night, n.snapshot_date IS NOT NULL AS computed,
           ROW_NUMBER() OVER (ORDER BY s.snapshot_date DESC) AS recency
    FROM account_pnl_snapshots s LEFT JOIN pnl_attribution_nights n ON n.snapshot_date = s.snapshot_date
    ORDER BY s.snapshot_date`);
  return (result.rows as { night: string; computed: boolean; recency: string }[]).filter((row) => !row.computed || Number(row.recency) <= recentNightsRecomputed).map((row) => row.night);
}

/** Computes the given nights (all of them, by default those of nightsToCompute) and replaces their stored rows. */
export async function writeAttributionSnapshots(nights?: readonly string[], now: Date = new Date()): Promise<{ nights: string[]; rowCount: number; moveRowCount: number; closedShortOptionCount: number }> {
  const nightsToWrite = nights ? [...nights] : await nightsToCompute();
  if (nightsToWrite.length === 0) return { nights: [], rowCount: 0, moveRowCount: 0, closedShortOptionCount: 0 };
  const ledger = await loadAttributionLedger();
  const [rowsByNight, moveRowsByNight] = await Promise.all([computeAttributionNights(nightsToWrite, "nightlySnapshot", ledger), computeAttributionMoveNights(nightsToWrite, ledger)]);
  const closedShortOptions = closedShortOptionRows(ledger, ledger.nights);
  let rowCount = 0;
  let moveRowCount = 0;
  await db.transaction(async (trx) => {
    await trx("pnl_closed_short_options").del();
    for (let start = 0; start < closedShortOptions.length; start += 500) {
      await trx("pnl_closed_short_options").insert(
        closedShortOptions.slice(start, start + 500).map((row) => ({
          position_leg_id: row.legId,
          ticker_id: row.tickerId,
          bucket: row.bucket,
          book_key: row.bookKey,
          closed_night: row.closedNight,
          result: row.result,
          gross_credit: row.grossCredit,
          gross_buyback: row.grossBuyback,
          assigned: row.assigned,
          held_to_expiry: row.heldToExpiry,
          days_held: row.daysHeld,
        })),
      );
    }
    for (const night of nightsToWrite) {
      const rows = rowsByNight.get(night) ?? [];
      await trx("pnl_attribution_snapshots").where({ snapshot_date: night }).del();
      for (let start = 0; start < rows.length; start += 500) {
        await trx("pnl_attribution_snapshots").insert(
          rows.slice(start, start + 500).map((row) => ({
            snapshot_date: row.snapshotDate,
            ticker_id: row.tickerId,
            bucket: row.bucket,
            book_key: row.bookKey,
            premium_gross: row.premiumGross,
            stock_gross: row.stockGross,
            commissions: row.commissions,
            total: row.total,
            unrealized: row.unrealized,
            capital: row.capital,
            flagged_total: row.flaggedTotal,
            flag_reasons: JSON.stringify(row.flagReasons),
          })),
        );
      }
      const moveRows = moveRowsByNight.get(night) ?? [];
      await trx("pnl_attribution_move_snapshots").where({ snapshot_date: night }).del();
      if (moveRows.length > 0)
        await trx("pnl_attribution_move_snapshots").insert(
          moveRows.map((row) => ({
            snapshot_date: row.snapshotDate,
            ticker_id: row.tickerId,
            bucket: row.bucket,
            moved_at: row.movedAt,
            from_book: row.fromBook,
            to_book: row.toBook,
            premium_gross: row.premiumGross,
            stock_gross: row.stockGross,
            commissions: row.commissions,
            total: row.total,
            unrealized: row.unrealized,
            capital: row.capital,
            flagged_total: row.flaggedTotal,
            flag_reasons: JSON.stringify(row.flagReasons),
          })),
        );
      await trx("pnl_attribution_nights").insert({ snapshot_date: night, ticker_count: new Set(rows.map((row) => row.tickerId)).size, computed_at: now }).onConflict("snapshot_date").merge();
      rowCount += rows.length;
      moveRowCount += moveRows.length;
    }
  });
  return { nights: nightsToWrite, rowCount, moveRowCount, closedShortOptionCount: closedShortOptions.length };
}

/** Every ticker's whole ledger, the Pluto periods, the nights with when each was captured, and the moves between the books. */
export interface AttributionLedger {
  symbolInputs: SymbolCycleInput[];
  periods: TickerBookPeriod[];
  nights: string[];
  capturedAtByNight: Map<string, Date>;
  moves: BookMove[];
}

export async function loadAttributionLedger(): Promise<AttributionLedger> {
  const [symbolInputs, periods, nightRows, moves] = await Promise.all([
    loadCycleInputsForTickers("all"),
    loadTickerBookPeriods(),
    db.raw(`SELECT snapshot_date::text AS night, captured_at AS "capturedAt" FROM account_pnl_snapshots ORDER BY snapshot_date`).then((result) => result.rows as { night: string; capturedAt: Date }[]),
    loadBookMoves(),
  ]);
  return { symbolInputs, periods, nights: nightRows.map((row) => row.night), capturedAtByNight: new Map(nightRows.map((row) => [row.night, new Date(row.capturedAt)])), moves };
}

/** Every switch of a ticker between the books that moved legs, with each leg's mark. */
export async function loadBookMoves(): Promise<BookMove[]> {
  const result = await db.raw(
    `SELECT blt.group_id AS "groupId", p.ticker_id AS "tickerId", blt.transferred_at AS "movedAt", blt.from_book AS "fromBook", blt.to_book AS "toBook",
            blt.position_leg_id AS "legId", pl.leg_type AS "legType", blt.quantity, blt.mark_price::float AS "markPrice"
     FROM book_leg_transfers blt JOIN position_legs pl ON pl.id = blt.position_leg_id JOIN positions p ON p.id = pl.position_id
     ORDER BY blt.transferred_at`,
  );
  const moveByGroup = new Map<string, BookMove>();
  for (const row of result.rows as { groupId: string; tickerId: string; movedAt: Date; fromBook: BookKey; toBook: BookKey; legId: string; legType: "stock" | "option"; quantity: number; markPrice: number }[]) {
    const move = moveByGroup.get(row.groupId) ?? moveByGroup.set(row.groupId, { tickerId: row.tickerId, movedAt: new Date(row.movedAt), fromBook: row.fromBook, toBook: row.toBook, legs: [] }).get(row.groupId)!;
    move.legs.push({ legId: row.legId, legType: row.legType, quantity: Number(row.quantity), markPrice: row.markPrice });
  }
  return [...moveByGroup.values()];
}

/**
 * Pure: every closed short option with its result (shortOptionTradeStats.ts), on the night it closed (the last night on or
 * before its New York date, so a Friday expiry IBKR settles after midnight counts on Friday), in the ticker's book when it
 * closed. A leg closed before the first night is left out: no range can hold it.
 */
export function closedShortOptionRows(ledger: AttributionLedger, nights: readonly string[]): StoredClosedShortOption[] {
  const rows: StoredClosedShortOption[] = [];
  for (const { tickerId, input } of ledger.symbolInputs) {
    for (const { closedAt, ...result } of closedShortOptionResults(input)) {
      const closedDate = easternIsoDate(closedAt);
      const closedNight = [...nights].reverse().find((night) => night <= closedDate);
      if (closedNight === undefined) continue;
      rows.push({ ...result, tickerId, closedNight, bookKey: bookOfTickerAt(ledger.periods, tickerId, closedAt) });
    }
  }
  return rows;
}

/** Read-only: the rows the given nights would get, by night (the backfill's dry run, and the writer's own computation). */
export async function computeAttributionNights(nights: readonly string[], stockMark: "dailyClose" | "nightlySnapshot" = "nightlySnapshot", ledger?: AttributionLedger): Promise<Map<string, AttributionRow[]>> {
  const { symbolInputs, periods, capturedAtByNight } = ledger ?? (await loadAttributionLedger());
  const rowsByNight = new Map<string, AttributionRow[]>();
  if (nights.length === 0) return rowsByNight;
  const { snapshotMarksByNight, snapshotPricesByNight } = await loadNightlyMarks(nights, stockMark);
  for (const night of nights) rowsByNight.set(night, attributionRowsForNight(night, symbolInputs, snapshotMarksByNight.get(night) ?? new Map(), periods, snapshotPricesByNight?.get(night) ?? null, stockMark === "nightlySnapshot" ? (capturedAtByNight.get(night) ?? null) : null));
  return rowsByNight;
}
