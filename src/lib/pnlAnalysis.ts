import { db } from "../db/connection.js";
import type { BookKey } from "../books/bookKeys.js";
import { bookPerformanceRows, loadBookDailySeries } from "../books/bookDashboard.js";
import type { CycleBucket } from "./cycles.js";
import { fetchCyclesForTickers } from "./cycleQueries.js";
import { easternInstant } from "./easternIsoDate.js";
import { attributionBuckets, splitNightAtMoves } from "./pnlAttribution.js";
import { computeDailyPerformancePoints, type DailyPerformancePoint } from "./performanceReturns.js";
import { computeBookRiskFigures, type BookRiskFigures } from "./performanceRisk.js";
import { loadRiskFreeRateLookup } from "./riskFreeRate.js";
import { summarizeTradeStats, type StoredClosedShortOption, type TradeStats } from "./shortOptionTradeStats.js";

// The P&L Analyser's figures over a range of nights (Marcelo 2026-11-13), from the stored attribution (pnlAttribution.ts),
// the books' and the account's nightly values, and the cash items that are no strategy's (interest, dividends, fees).
//
// For every night and book: book P&L = Σ strategy buckets' change + cash items + change of cycles left out for their data
// + Unexplained. Unexplained is what nothing explains, shown so a gap is visible, never spread over the rest.
//   All books     the account's nightly P&L (performanceReturns.ts); every bucket; cash items by when IBKR booked them
//   Pluto, Manual each book's nightly P&L (bookDashboard.ts), from the books' first night; the buckets the book held that
//                 night; cash items from the night they entered the book's ledger (posted from the next statement)
// A range runs from a baseline night (exclusive: the last night before its first day) to its last night (inclusive).

export type AnalysisBook = "all" | BookKey;
export const analysisBooks: readonly AnalysisBook[] = ["all", "pluto", "manual"];

export type CashComponent = "dividends" | "interest" | "fees" | "otherCash";
export const cashComponents: readonly CashComponent[] = ["dividends", "interest", "fees", "otherCash"];
const cashItemKinds = ["dividend", "withholding_tax", "interest", "fee", "sales_tax", "commission_adjustment", "corporate_action", "other_statement_row"];

/** Pure: which component a ledger or statement kind counts in (withholding follows a dividend when it names a symbol, else interest). */
export function cashComponentOfKind(kind: string, symbol: string | null): CashComponent {
  if (kind === "dividend") return "dividends";
  if (kind === "withholding_tax") return symbol ? "dividends" : "interest";
  if (kind === "interest") return "interest";
  if (kind === "fee" || kind === "sales_tax" || kind === "commission_adjustment") return "fees";
  return "otherCash";
}

export interface BucketChange {
  premiumGross: number;
  stockGross: number;
  commissions: number;
  total: number;
  unrealizedChange: number;
  /** Σ capital in use × calendar days it was held (the RoC base: P&L ÷ (capitalDays ÷ 365)). */
  capitalDays: number;
  /** Change of the bucket's cycles left out for their data flags. */
  flaggedChange: number;
}

export interface NightFigures {
  night: string;
  /** The book's P&L that night from its value; null when it has no value that night or the night before. */
  bookPnl: number | null;
  /** Null when the night's attribution was not computed (pnl_attribution_nights). */
  buckets: Record<CycleBucket, BucketChange> | null;
  cash: Record<CashComponent, number>;
  /**
   * All books only, from the books' first night: the account's P&L less Pluto's and Manual's, i.e. IBKR's own valuation of
   * the account (its marks, accrued interest) against the books' snapshot prices. Null before the books and for a book.
   */
  ibkrValuationDifference: number | null;
  unexplained: number | null;
}

export interface TickerRangeRow extends BucketChange {
  tickerId: string;
  symbol: string;
  /** The book the ticker's bucket was in on the nights counted (a ticker that changed book has a row per book). */
  book: BookKey;
  bucket: CycleBucket;
  flagReasons: string[];
}

export interface TickerCashRow {
  symbol: string;
  book: BookKey | null;
  component: CashComponent;
  amount: number;
}

export interface BookAnalysis {
  /** Null when the book has no nights in the range (the books started after it). */
  risk: BookRiskFigures | null;
  /** Closed short options of the range (shortOptionTradeStats.ts): puts, calls and both; null with the risk figures. */
  tradeStats: { csp: TradeStats; cc: TradeStats; both: TradeStats } | null;
  nights: NightFigures[];
  tickers: TickerRangeRow[];
  tickerCash: TickerCashRow[];
  missingAttributionNights: string[];
}

export interface PnlAnalysis {
  firstNight: string | null;
  lastNight: string | null;
  booksFirstNight: string | null;
  range: { baselineNight: string; lastNight: string } | null;
  books: Record<AnalysisBook, BookAnalysis>;
  /** Per symbol: the cycles that overlap the range (the drill-down's rows) and whether one is open now. Filled by loadPnlAnalysis. */
  cyclesBySymbol: Record<string, TickerCycleSummary>;
}

export interface TickerCycleSummary {
  inRange: number;
  hasOpenCycle: boolean;
}

/** Pure: each symbol's cycles that were held during the range (started by its last night, not ended by its baseline night's end). */
export function summarizeTickerCycles(symbolCycles: readonly { symbol: string; cycles: readonly { startAt: Date; endAt: Date | null; status: "open" | "closed" }[] }[], range: { baselineNight: string; lastNight: string }): Record<string, TickerCycleSummary> {
  const rangeStartsAt = easternInstant(addDaysIso(range.baselineNight, 1), 0, 0).getTime();
  const rangeEndsAt = easternInstant(addDaysIso(range.lastNight, 1), 0, 0).getTime();
  const summary: Record<string, TickerCycleSummary> = {};
  for (const { symbol, cycles } of symbolCycles) {
    const inRange = cycles.filter((cycle) => cycle.startAt.getTime() < rangeEndsAt && (cycle.endAt === null || cycle.endAt.getTime() >= rangeStartsAt)).length;
    summary[symbol] = { inRange, hasOpenCycle: cycles.some((cycle) => cycle.status === "open") };
  }
  return summary;
}

function addDaysIso(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface StoredRow {
  snapshotDate: string;
  tickerId: string;
  symbol: string;
  bucket: CycleBucket;
  bookKey: BookKey;
  premiumGross: number;
  stockGross: number;
  commissions: number;
  total: number;
  unrealized: number;
  capital: number;
  flaggedTotal: number;
  flagReasons: string[];
}

/** A ticker's stored attribution at a move between the books during a night (pnl_attribution_move_snapshots). */
export interface StoredMoveRow extends Omit<StoredRow, "bookKey"> {
  movedAt: Date;
  fromBook: BookKey;
  toBook: BookKey;
}

interface CashItem {
  /** The night the item counts on for this book. */
  night: string;
  book: AnalysisBook;
  component: CashComponent;
  symbol: string | null;
  amount: number;
}

function emptyBucketChange(): BucketChange {
  return { premiumGross: 0, stockGross: 0, commissions: 0, total: 0, unrealizedChange: 0, capitalDays: 0, flaggedChange: 0 };
}

function emptyCash(): Record<CashComponent, number> {
  return { dividends: 0, interest: 0, fees: 0, otherCash: 0 };
}

function calendarDaysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

/** The first night captured at or after `at` (nights ordered by capture), or null when none is yet. */
function nightCapturedAtOrAfter(nights: readonly { night: string; capturedAt: number }[], at: number): string | null {
  return nights.find((night) => night.capturedAt >= at)?.night ?? null;
}

/**
 * Pure: a night's change per ticker and bucket against the previous night's rows, with the book of the night; a ticker
 * moved between the books during the night (`moves`, that night's) gives one change per book, split at the move
 * (splitNightAtMoves), its capital-days by the share of the night each book held it. `night` is when the previous night's
 * values and this night's were taken.
 */
export function nightChanges(current: readonly StoredRow[], previous: readonly StoredRow[], daysHeld: number, moves: readonly StoredMoveRow[] = [], night: { startsAt: Date; endsAt: Date } | null = null): (BucketChange & { tickerId: string; symbol: string; bucket: CycleBucket; book: BookKey; flagReasons: string[] })[] {
  const key = (row: { tickerId: string; bucket: CycleBucket }) => `${row.tickerId}|${row.bucket}`;
  const previousByKey = new Map(previous.map((row) => [key(row), row]));
  const currentByKey = new Map(current.map((row) => [key(row), row]));
  const movesByKey = new Map<string, StoredMoveRow[]>();
  for (const move of moves) movesByKey.set(key(move), [...(movesByKey.get(key(move)) ?? []), move]);
  const changes = [];
  for (const rowKey of new Set([...previousByKey.keys(), ...currentByKey.keys(), ...(night === null ? [] : movesByKey.keys())])) {
    const now = currentByKey.get(rowKey);
    const before = previousByKey.get(rowKey);
    const keyMoves = night === null ? [] : (movesByKey.get(rowKey) ?? []);
    const reference = (now ?? before ?? keyMoves[0])!;
    const nightBook = now?.bookKey ?? keyMoves.at(-1)?.toBook ?? before!.bookKey;
    const segments = splitNightAtMoves<Omit<StoredRow, "bookKey">>(reference.bucket, before, now, nightBook, keyMoves.map((move) => ({ atMove: move, movedAt: new Date(move.movedAt), fromBook: move.fromBook })), night ?? { startsAt: new Date(0), endsAt: new Date(0) });
    for (const segment of segments) {
      const value = (pick: (row: Omit<StoredRow, "bookKey">) => number) => (segment.to ? pick(segment.to) : 0) - (segment.from ? pick(segment.from) : 0);
      changes.push({
        tickerId: reference.tickerId,
        symbol: reference.symbol,
        bucket: reference.bucket,
        book: segment.book,
        premiumGross: value((row) => row.premiumGross),
        stockGross: value((row) => row.stockGross),
        commissions: value((row) => row.commissions),
        total: value((row) => row.total),
        unrealizedChange: value((row) => row.unrealized),
        capitalDays: (segment.from?.capital ?? 0) * daysHeld * segment.timeShare,
        flaggedChange: value((row) => row.flaggedTotal),
        flagReasons: segment.to?.flagReasons ?? [],
      });
    }
  }
  return changes;
}

/** The baseline night of a range starting on `firstDay`: the last night before it, else the first night. */
export function baselineNightFor(nights: readonly string[], firstDay: string): string | null {
  const before = nights.filter((night) => night < firstDay);
  return before.at(-1) ?? nights[0] ?? null;
}

export interface AccountNightRow {
  night: string;
  capturedAt: Date;
  nav: number | null;
  flow: number | null;
}

export interface LedgerCashItemRow {
  book: BookKey;
  kind: string;
  symbol: string | null;
  amount: number;
  effectiveAt: Date;
  createdAt: Date;
}

export interface AccountCashItemRow {
  kind: string;
  symbol: string | null;
  amount: number;
  effectiveAt: Date;
}

/** Everything the analysis reads; the attribution rows need only cover the range's baseline night to its last. */
export interface PnlAnalysisInputs {
  accountRows: readonly AccountNightRow[];
  plutoSeries: Awaited<ReturnType<typeof loadBookDailySeries>>;
  manualSeries: Awaited<ReturnType<typeof loadBookDailySeries>>;
  bookCaptures: readonly { book: BookKey; night: string; capturedAt: Date }[];
  attributionNights: ReadonlySet<string>;
  storedRows: readonly StoredRow[];
  /** The moves between the books inside the range's nights (the baseline night's own are not needed). */
  moveRows: readonly StoredMoveRow[];
  ledgerItems: readonly LedgerCashItemRow[];
  accountItems: readonly AccountCashItemRow[];
  closedShortOptions: readonly StoredClosedShortOption[];
  riskFreeAt: (night: string) => number | null;
}

/** A book's baseline night in a range: Pluto's and Manual's history starts at the books' first night. */
export function bookBaselineNight(book: AnalysisBook, baselineNight: string, booksFirstNight: string | null): string {
  return book === "all" || booksFirstNight === null || baselineNight >= booksFirstNight ? baselineNight : booksFirstNight;
}

/** The range's baseline and last nights for `firstDay` to `lastDay` (YYYY-MM-DD, inclusive; null = the whole history), or null. */
export function resolveRange(nights: readonly string[], firstDay: string | null, lastDay: string | null): { baselineNight: string; lastNight: string } | null {
  if (nights.length < 2) return null;
  const lastNight = [...nights].reverse().find((night) => lastDay === null || night <= lastDay) ?? null;
  const baselineNight = firstDay === null ? nights[0]! : baselineNightFor(nights, firstDay);
  if (lastNight === null || baselineNight === null || baselineNight >= lastNight) return null;
  return { baselineNight, lastNight };
}

/** The figures of the range from `firstDay` to `lastDay` (YYYY-MM-DD, inclusive); either null = the whole history. */
export async function loadPnlAnalysis(firstDay: string | null, lastDay: string | null): Promise<PnlAnalysis> {
  const [accountRows, plutoSeries, manualSeries, bookCaptures, attributionNights, riskFreeAt, ledgerItems, accountItems, closedShortOptions] = await Promise.all([
    db.raw(`SELECT snapshot_date::text AS night, captured_at AS "capturedAt", net_liquidation_value::float AS nav, net_cash_flow::float AS flow FROM account_pnl_snapshots ORDER BY snapshot_date`).then((result) => result.rows as AccountNightRow[]),
    loadBookDailySeries("pluto"),
    loadBookDailySeries("manual"),
    db.raw(`SELECT book_key AS book, snapshot_date::text AS night, captured_at AS "capturedAt" FROM book_value_snapshots WHERE book_key IN ('pluto', 'manual') ORDER BY captured_at`).then((result) => result.rows as { book: BookKey; night: string; capturedAt: Date }[]),
    db.raw(`SELECT snapshot_date::text AS night FROM pnl_attribution_nights`).then((result) => new Set((result.rows as { night: string }[]).map((row) => row.night))),
    loadRiskFreeRateLookup(),
    loadLedgerCashItems(),
    db.raw(`SELECT kind, symbol, amount::float AS amount, effective_at AS "effectiveAt" FROM account_cash_items`).then((result) => result.rows as AccountCashItemRow[]),
    loadClosedShortOptions(),
  ]);
  const range = resolveRange(accountRows.map((row) => row.night), firstDay, lastDay);
  const storedRows: StoredRow[] =
    range === null
      ? []
      : (
          await db.raw(
            `SELECT a.snapshot_date::text AS "snapshotDate", a.ticker_id AS "tickerId", t.symbol, a.bucket, a.book_key AS "bookKey",
                    a.premium_gross::float AS "premiumGross", a.stock_gross::float AS "stockGross", a.commissions::float AS commissions,
                    a.total::float AS total, a.unrealized::float AS unrealized, a.capital::float AS capital,
                    a.flagged_total::float AS "flaggedTotal", a.flag_reasons AS "flagReasons"
             FROM pnl_attribution_snapshots a JOIN tickers t ON t.id = a.ticker_id
             WHERE a.snapshot_date BETWEEN ?::date AND ?::date`,
            [range.baselineNight, range.lastNight],
          )
        ).rows;
  const moveRows = range === null ? [] : await loadMoveRows(range.baselineNight, range.lastNight);
  const analysis = buildPnlAnalysis({ accountRows, plutoSeries, manualSeries, bookCaptures, attributionNights, storedRows, moveRows, ledgerItems, accountItems, closedShortOptions, riskFreeAt }, firstDay, lastDay);
  if (analysis.range !== null) analysis.cyclesBySymbol = summarizeTickerCycles(await fetchCyclesForTickers("all"), analysis.range);
  return analysis;
}

/** The stored attribution at moves between the books, for the nights after `baselineNight` through `lastNight`. */
export async function loadMoveRows(baselineNight: string, lastNight: string): Promise<StoredMoveRow[]> {
  const result = await db.raw(
    `SELECT m.snapshot_date::text AS "snapshotDate", m.ticker_id AS "tickerId", t.symbol, m.bucket, m.moved_at AS "movedAt", m.from_book AS "fromBook", m.to_book AS "toBook",
            m.premium_gross::float AS "premiumGross", m.stock_gross::float AS "stockGross", m.commissions::float AS commissions,
            m.total::float AS total, m.unrealized::float AS unrealized, m.capital::float AS capital,
            m.flagged_total::float AS "flaggedTotal", m.flag_reasons AS "flagReasons"
     FROM pnl_attribution_move_snapshots m JOIN tickers t ON t.id = m.ticker_id
     WHERE m.snapshot_date > ?::date AND m.snapshot_date <= ?::date`,
    [baselineNight, lastNight],
  );
  return result.rows as StoredMoveRow[];
}

/** The stored closed short options (written by the nightly attribution step). */
export function loadClosedShortOptions(): Promise<StoredClosedShortOption[]> {
  return db
    .raw(
      `SELECT position_leg_id AS "legId", ticker_id AS "tickerId", bucket, book_key AS "bookKey", closed_night::text AS "closedNight",
              result::float AS result, gross_credit::float AS "grossCredit", gross_buyback::float AS "grossBuyback",
              assigned, held_to_expiry AS "heldToExpiry", days_held::float AS "daysHeld"
       FROM pnl_closed_short_options`,
    )
    .then((result) => result.rows as StoredClosedShortOption[]);
}

/** The books' ledger entries that are no strategy's (interest, dividends, fees). */
export function loadLedgerCashItems(): Promise<LedgerCashItemRow[]> {
  return db
    .raw(
      `SELECT book_key AS book, kind, symbol, amount::float AS amount, effective_at AS "effectiveAt", created_at AS "createdAt"
       FROM book_cash_entries WHERE book_key IN ('pluto', 'manual') AND kind = ANY(?)`,
      [cashItemKinds],
    )
    .then((result) => result.rows as LedgerCashItemRow[]);
}

/** Pure: the analysis of the range from the loaded inputs. */
export function buildPnlAnalysis(inputs: PnlAnalysisInputs, firstDay: string | null, lastDay: string | null): PnlAnalysis {
  const { accountRows, plutoSeries, manualSeries, bookCaptures, attributionNights, storedRows, moveRows, ledgerItems, accountItems, closedShortOptions, riskFreeAt } = inputs;
  const nights = accountRows.map((row) => row.night);
  const booksFirstNight = plutoSeries[0]?.snapshotDate ?? manualSeries[0]?.snapshotDate ?? null;
  const emptyBook = (): BookAnalysis => ({ risk: null, tradeStats: null, nights: [], tickers: [], tickerCash: [], missingAttributionNights: [] });
  const empty: PnlAnalysis = { firstNight: nights[0] ?? null, lastNight: nights.at(-1) ?? null, booksFirstNight, range: null, books: { all: emptyBook(), pluto: emptyBook(), manual: emptyBook() }, cyclesBySymbol: {} };
  const range = resolveRange(nights, firstDay, lastDay);
  if (range === null) return empty;
  const { baselineNight, lastNight } = range;
  const rowsByNight = new Map<string, StoredRow[]>();
  for (const row of storedRows) rowsByNight.set(row.snapshotDate, [...(rowsByNight.get(row.snapshotDate) ?? []), row]);
  const moveRowsByNight = new Map<string, StoredMoveRow[]>();
  for (const row of moveRows) moveRowsByNight.set(row.snapshotDate, [...(moveRowsByNight.get(row.snapshotDate) ?? []), row]);
  const capturedAtByNight = new Map(accountRows.map((row) => [row.night, new Date(row.capturedAt)]));

  // Cash items: the books' from their ledger (by the night they entered it), the account's by when IBKR booked them, with
  // the statement rows from before the books' ledger began.
  const accountCaptures = accountRows.map((row) => ({ night: row.night, capturedAt: new Date(row.capturedAt).getTime() }));
  const bookCaptureList = (book: BookKey) => bookCaptures.filter((row) => row.book === book).map((row) => ({ night: row.night, capturedAt: new Date(row.capturedAt).getTime() }));
  const cashItems: CashItem[] = [];
  for (const item of ledgerItems) {
    const component = cashComponentOfKind(item.kind, item.symbol);
    const enteredAt = Math.max(new Date(item.effectiveAt).getTime(), new Date(item.createdAt).getTime());
    const bookNight = nightCapturedAtOrAfter(bookCaptureList(item.book), enteredAt);
    if (bookNight !== null) cashItems.push({ night: bookNight, book: item.book, component, symbol: item.symbol, amount: item.amount });
    const accountNight = nightCapturedAtOrAfter(accountCaptures, new Date(item.effectiveAt).getTime());
    if (accountNight !== null) cashItems.push({ night: accountNight, book: "all", component, symbol: item.symbol, amount: item.amount });
  }
  for (const item of accountItems) {
    const accountNight = nightCapturedAtOrAfter(accountCaptures, new Date(item.effectiveAt).getTime());
    if (accountNight !== null) cashItems.push({ night: accountNight, book: "all", component: cashComponentOfKind(item.kind, item.symbol), symbol: item.symbol, amount: item.amount });
  }

  // Each book's daily P&L and returns.
  const accountPoints = computeDailyPerformancePoints(accountRows.map((row) => ({ snapshotDate: row.night, netLiquidationValue: row.nav, netCashFlow: row.flow })));
  const bookPoints: Record<AnalysisBook, DailyPerformancePoint[]> = {
    all: accountPoints,
    pluto: computeDailyPerformancePoints(bookPerformanceRows(plutoSeries)),
    manual: computeDailyPerformancePoints(bookPerformanceRows(manualSeries)),
  };
  const bookPnlByNight: Record<AnalysisBook, Map<string, number>> = {
    all: new Map(accountPoints.map((point) => [point.snapshotDate, point.profitDollars])),
    pluto: new Map(plutoSeries.filter((row) => row.dailyPnl !== null).map((row) => [row.snapshotDate, row.dailyPnl!])),
    manual: new Map(manualSeries.filter((row) => row.dailyPnl !== null).map((row) => [row.snapshotDate, row.dailyPnl!])),
  };

  const books = {} as Record<AnalysisBook, BookAnalysis>;
  for (const book of analysisBooks) {
    const bookBaseline = bookBaselineNight(book, baselineNight, booksFirstNight);
    if (book !== "all" && (booksFirstNight === null || bookBaseline >= lastNight)) {
      books[book] = emptyBook();
      continue;
    }
    const rangeNights = nights.filter((night) => night > bookBaseline && night <= lastNight);
    const nightFigures: NightFigures[] = [];
    const tickerTotals = new Map<string, TickerRangeRow>();
    const missingAttributionNights: string[] = [];
    for (const night of rangeNights) {
      const previousNight = nights[nights.indexOf(night) - 1]!;
      const cash = emptyCash();
      for (const item of cashItems) if (item.book === book && item.night === night) cash[item.component] += item.amount;
      const bookPnl = bookPnlByNight[book].get(night) ?? null;
      if (!attributionNights.has(night) || !attributionNights.has(previousNight)) {
        missingAttributionNights.push(night);
        nightFigures.push({ night, bookPnl, buckets: null, cash, ibkrValuationDifference: null, unexplained: null });
        continue;
      }
      const changes = nightChanges(rowsByNight.get(night) ?? [], rowsByNight.get(previousNight) ?? [], calendarDaysBetween(previousNight, night), moveRowsByNight.get(night) ?? [], { startsAt: capturedAtByNight.get(previousNight)!, endsAt: capturedAtByNight.get(night)! }).filter((change) => book === "all" || change.book === book);
      const buckets = Object.fromEntries(attributionBuckets.map((bucket) => [bucket, emptyBucketChange()])) as Record<CycleBucket, BucketChange>;
      for (const change of changes) {
        const target = buckets[change.bucket];
        for (const field of ["premiumGross", "stockGross", "commissions", "total", "unrealizedChange", "capitalDays", "flaggedChange"] as const) target[field] += change[field];
        const tickerKey = `${change.tickerId}|${change.book}|${change.bucket}`;
        const total = tickerTotals.get(tickerKey) ?? { ...emptyBucketChange(), tickerId: change.tickerId, symbol: change.symbol, book: change.book, bucket: change.bucket, flagReasons: [] };
        for (const field of ["premiumGross", "stockGross", "commissions", "total", "unrealizedChange", "capitalDays", "flaggedChange"] as const) total[field] += change[field];
        total.flagReasons = [...new Set([...total.flagReasons, ...change.flagReasons])];
        tickerTotals.set(tickerKey, total);
      }
      const explained = attributionBuckets.reduce((sum, bucket) => sum + buckets[bucket].total + buckets[bucket].flaggedChange, 0) + cashComponents.reduce((sum, component) => sum + cash[component], 0);
      const plutoPnl = bookPnlByNight.pluto.get(night);
      const manualPnl = bookPnlByNight.manual.get(night);
      const ibkrValuationDifference = book === "all" && bookPnl !== null && plutoPnl !== undefined && manualPnl !== undefined ? bookPnl - plutoPnl - manualPnl : null;
      nightFigures.push({ night, bookPnl, buckets, cash, ibkrValuationDifference, unexplained: bookPnl === null ? null : bookPnl - explained - (ibkrValuationDifference ?? 0) });
    }
    const tickerCash = new Map<string, TickerCashRow>();
    for (const item of cashItems) {
      if (item.book !== book || item.symbol === null || item.night <= bookBaseline || item.night > lastNight) continue;
      const key = `${item.symbol}|${item.component}`;
      const row = tickerCash.get(key) ?? { symbol: item.symbol, book: book === "all" ? null : book, component: item.component, amount: 0 };
      row.amount += item.amount;
      tickerCash.set(key, row);
    }
    const points = bookPoints[book].filter((point) => point.snapshotDate > bookBaseline && point.snapshotDate <= lastNight);
    const closedInRange = closedShortOptions.filter((leg) => leg.closedNight > bookBaseline && leg.closedNight <= lastNight && (book === "all" || leg.bookKey === book));
    books[book] = {
      risk: computeBookRiskFigures(bookBaseline, points, riskFreeAt),
      tradeStats: {
        csp: summarizeTradeStats(closedInRange.filter((leg) => leg.bucket === "csp"), "csp"),
        cc: summarizeTradeStats(closedInRange.filter((leg) => leg.bucket === "cc"), "cc"),
        both: summarizeTradeStats(closedInRange, "both"),
      },
      nights: nightFigures,
      tickers: [...tickerTotals.values()].filter((row) => row.total !== 0 || row.capitalDays !== 0 || row.flaggedChange !== 0 || row.unrealizedChange !== 0),
      tickerCash: [...tickerCash.values()],
      missingAttributionNights,
    };
  }
  return { firstNight: nights[0]!, lastNight: nights.at(-1)!, booksFirstNight, range: { baselineNight, lastNight }, books, cyclesBySymbol: {} };
}
