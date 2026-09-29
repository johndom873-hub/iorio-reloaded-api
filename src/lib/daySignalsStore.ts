import { db } from "../db/connection.js";
import type { SignalGrade } from "./signalCandidates.js";

// DB side of Day Signals (design agreed 2026-09-24, PROGRESS.md "DAY
// SIGNALS"): the day's pooled expiries per ticker and the refresh loop's
// latest bid/ask per pooled contract. Current trading day only — the seed
// replaces both tables wholesale; quotes only, scores are re-derived at
// read time.

export interface DaySignalExpirySeed {
  expiry: string; // ISO date
  rank: number;
  seedBestEdgeDollars: number;
  seedBestNetEdge: number;
}

export interface DaySignalTickerSeed {
  tickerId: string;
  snapshotId: string;
  expiries: DaySignalExpirySeed[];
}

export interface DaySignalExpiryRow {
  tickerId: string;
  symbol: string;
  expiry: string; // ISO date
  tradingDateIso: string;
  snapshotId: string;
  rank: number;
}

export interface DayQuoteContractRef {
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

export interface DayQuoteContract {
  tickerId: string;
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
}

export interface DayQuoteWrite extends DayQuoteContract {
  tradingDateIso: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  errorCode: number | null;
  quotedAt: Date;
  cycleNumber: number;
}

export interface DayQuoteRow extends DayQuoteContract {
  tradingDateIso: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  errorCode: number | null;
  quotedAt: string;
  cycleNumber: number;
  lastGrade: SignalGrade | null;
}

export interface DayRollGradeRow {
  legId: string;
  expiry: string; // replacement's ISO expiry
  strike: number;
  right: "C" | "P";
  lastGrade: SignalGrade;
}

export interface DayQuotesStatus {
  tradingDateIso: string | null;
  quoteCount: number;
  oldestQuotedAt: string | null;
  newestQuotedAt: string | null;
  expiryCount: number;
  tickerCount: number;
}

/** Wipes both day tables and writes the new pool in one transaction (the seed step). */
export async function replaceDaySignalPool(tradingDateIso: string, seeds: DaySignalTickerSeed[], seededAt: Date): Promise<void> {
  await db.transaction(async (trx) => {
    await trx("day_signal_rerank_state").del();
    await trx("day_signal_roll_grades").del();
    await trx("day_signal_quotes").del();
    await trx("day_signal_expiries").del();
    const rows = seeds.flatMap((seed) =>
      seed.expiries.map((expiry) => ({
        ticker_id: seed.tickerId,
        expiry: expiry.expiry,
        trading_date: tradingDateIso,
        snapshot_id: seed.snapshotId,
        rank: expiry.rank,
        seed_best_edge_dollars: expiry.seedBestEdgeDollars,
        seed_best_net_edge: expiry.seedBestNetEdge,
        seeded_at: seededAt,
      })),
    );
    if (rows.length > 0) await trx("day_signal_expiries").insert(rows);
  });
}

/**
 * A mid-day re-rank (daySignalsLoop.ts): sets ONE ticker's pooled expiries, creating its pool when the 9:30 seed left it out
 * (a ticker that only became interesting after a move) or replacing it, always on the given snapshot. Deletes the ticker's
 * day quotes of expiries that are not pooled, so they can never be scored as fresh. False for an empty expiry list.
 */
export async function replaceTickerPoolExpiries(tickerId: string, tradingDateIso: string, snapshotId: string, expiries: DaySignalExpirySeed[], seededAt: Date): Promise<boolean> {
  if (expiries.length === 0) return false;
  await db.transaction(async (trx) => {
    await trx("day_signal_expiries").where({ ticker_id: tickerId }).del();
    await trx("day_signal_expiries").insert(
      expiries.map((expiry) => ({
        ticker_id: tickerId,
        expiry: expiry.expiry,
        trading_date: tradingDateIso,
        snapshot_id: snapshotId,
        rank: expiry.rank,
        seed_best_edge_dollars: expiry.seedBestEdgeDollars,
        seed_best_net_edge: expiry.seedBestNetEdge,
        seeded_at: seededAt,
      })),
    );
    await trx("day_signal_quotes").where({ ticker_id: tickerId }).whereNotIn("expiry", expiries.map((expiry) => expiry.expiry)).del();
  });
  return true;
}

export interface DayRerankState {
  /** Spot at the ticker's last expiry re-rank. */
  referenceSpotPrice: number;
  /** Re-ranks run for the ticker today. */
  reranks: number;
}

/** Today's re-rank bookkeeping per ticker; a ticker with no row has not re-ranked today (its reference is the 9:30 capture spot). */
export async function loadDayRerankStates(tradingDateIso: string): Promise<Map<string, DayRerankState>> {
  const rows = await db("day_signal_rerank_state").whereRaw("trading_date::text = ?", [tradingDateIso]).select("ticker_id as tickerId", "reference_spot_price as referenceSpotPrice", "rerank_count as reranks");
  return new Map(rows.map((row) => [row.tickerId, { referenceSpotPrice: Number(row.referenceSpotPrice), reranks: Number(row.reranks) }]));
}

export async function saveDayRerankState(tickerId: string, tradingDateIso: string, state: DayRerankState): Promise<void> {
  await db("day_signal_rerank_state")
    .insert({ ticker_id: tickerId, trading_date: tradingDateIso, reference_spot_price: state.referenceSpotPrice, rerank_count: state.reranks, updated_at: db.fn.now() })
    .onConflict("ticker_id")
    .merge(["trading_date", "reference_spot_price", "rerank_count", "updated_at"]);
}

/** Deletes a ticker's day quotes for every contract not in `keep`: contracts the loop stopped quoting must not linger as "fresh" quotes. No-op for an empty list (an empty set is a bug, never a reason to wipe). */
export async function pruneDayQuotesOutsideSet(tickerId: string, keep: DayQuoteContractRef[]): Promise<void> {
  if (keep.length === 0) return;
  await db("day_signal_quotes")
    .where({ ticker_id: tickerId })
    .whereNotIn(["expiry", "strike", "option_right"], keep.map((contract) => [contract.expiry, contract.strike, contract.right]))
    .del();
}

export async function loadDaySignalExpiries(tradingDateIso: string): Promise<DaySignalExpiryRow[]> {
  const rows = await db("day_signal_expiries as e")
    .join("tickers as t", "t.id", "e.ticker_id")
    .whereRaw("e.trading_date::text = ?", [tradingDateIso])
    .select("e.ticker_id as tickerId", "t.symbol", db.raw('e.expiry::text as expiry'), db.raw('e.trading_date::text as "tradingDateIso"'), "e.snapshot_id as snapshotId", "e.rank")
    .orderBy(["t.symbol", "e.rank"]);
  return rows.map((row) => ({ ...row, rank: Number(row.rank) }));
}

/** Every captured contract of the pooled expiries — the loop's universe, in cycle order (ticker, expiry, strike, right). */
export async function loadDaySignalUniverse(tradingDateIso: string): Promise<(DayQuoteContract & { symbol: string })[]> {
  const rows = await db("day_signal_expiries as e")
    .join("tickers as t", "t.id", "e.ticker_id")
    .join("option_quote_snapshots as q", function () {
      this.on("q.snapshot_id", "e.snapshot_id").andOn("q.expiry", "e.expiry");
    })
    .whereRaw("e.trading_date::text = ?", [tradingDateIso])
    .select("e.ticker_id as tickerId", "t.symbol", db.raw('q.expiry::text as expiry'), "q.strike", db.raw('q.option_right as "right"'))
    .orderBy([
      { column: "t.symbol" },
      { column: "q.expiry" },
      { column: "q.strike" },
      { column: "q.option_right" },
    ]);
  return rows.map((row) => ({ tickerId: row.tickerId, symbol: row.symbol, expiry: row.expiry, strike: Number(row.strike), right: row.right }));
}

function mapQuoteRow(row: Record<string, unknown>): DayQuoteRow {
  return {
    tickerId: row.tickerId as string,
    expiry: row.expiry as string,
    strike: Number(row.strike),
    right: row.right as "C" | "P",
    tradingDateIso: row.tradingDateIso as string,
    bid: row.bid === null ? null : Number(row.bid),
    ask: row.ask === null ? null : Number(row.ask),
    last: row.last === null ? null : Number(row.last),
    errorCode: row.errorCode === null ? null : Number(row.errorCode),
    quotedAt: new Date(row.quotedAt as string).toISOString(),
    cycleNumber: Number(row.cycleNumber),
    lastGrade: (row.lastGrade as SignalGrade | null) ?? null,
  };
}

const quoteSelect = [
  "ticker_id as tickerId",
  db.raw('expiry::text as expiry'),
  "strike",
  db.raw('option_right as "right"'),
  db.raw('trading_date::text as "tradingDateIso"'),
  "bid",
  "ask",
  "last",
  "error_code as errorCode",
  "quoted_at as quotedAt",
  "cycle_number as cycleNumber",
  "last_grade as lastGrade",
];

/** The day quotes scoring merges for one ticker — only those from the given snapshot date. */
export async function loadDayQuotesForTicker(tickerId: string, tradingDateIso: string): Promise<DayQuoteRow[]> {
  const rows = await db("day_signal_quotes").where({ ticker_id: tickerId }).whereRaw("trading_date::text = ?", [tradingDateIso]).select(quoteSelect);
  return rows.map(mapQuoteRow);
}

export async function upsertDayQuotes(writes: DayQuoteWrite[]): Promise<void> {
  if (writes.length === 0) return;
  await db("day_signal_quotes")
    .insert(
      writes.map((write) => ({
        ticker_id: write.tickerId,
        expiry: write.expiry,
        strike: write.strike,
        option_right: write.right,
        trading_date: write.tradingDateIso,
        bid: write.bid,
        ask: write.ask,
        last: write.last,
        error_code: write.errorCode,
        quoted_at: write.quotedAt,
        cycle_number: write.cycleNumber,
      })),
    )
    .onConflict(["ticker_id", "expiry", "strike", "option_right"])
    .merge(["trading_date", "bid", "ask", "last", "error_code", "quoted_at", "cycle_number"]);
}

export async function updateDayQuoteGrades(tickerId: string, grades: { expiry: string; strike: number; right: "C" | "P"; grade: SignalGrade }[]): Promise<void> {
  if (grades.length === 0) return;
  await db.transaction(async (trx) => {
    for (const entry of grades) {
      await trx("day_signal_quotes").where({ ticker_id: tickerId, expiry: entry.expiry, strike: entry.strike, option_right: entry.right }).update({ last_grade: entry.grade });
    }
  });
}

export async function loadDayQuotesStatus(): Promise<DayQuotesStatus> {
  const [quotes, expiries] = await Promise.all([
    db("day_signal_quotes")
      .select(db.raw('max(trading_date)::text as "tradingDateIso"'), db.raw('count(*)::int as "quoteCount"'), db.raw('min(quoted_at) as "oldestQuotedAt"'), db.raw('max(quoted_at) as "newestQuotedAt"'))
      .first(),
    db("day_signal_expiries").select(db.raw('count(*)::int as "expiryCount"'), db.raw('count(distinct ticker_id)::int as "tickerCount"'), db.raw('max(trading_date)::text as "tradingDateIso"')).first(),
  ]);
  return {
    tradingDateIso: expiries?.tradingDateIso ?? quotes?.tradingDateIso ?? null,
    quoteCount: Number(quotes?.quoteCount ?? 0),
    oldestQuotedAt: quotes?.oldestQuotedAt ? new Date(quotes.oldestQuotedAt).toISOString() : null,
    newestQuotedAt: quotes?.newestQuotedAt ? new Date(quotes.newestQuotedAt).toISOString() : null,
    expiryCount: Number(expiries?.expiryCount ?? 0),
    tickerCount: Number(expiries?.tickerCount ?? 0),
  };
}

/** Roll Signals: the grade each (held leg, replacement) roll had at the loop's last re-score of that ticker; upgrades against it are notified. */
export async function loadDayRollGrades(tickerId: string, tradingDateIso: string): Promise<DayRollGradeRow[]> {
  const rows = await db("day_signal_roll_grades").where({ ticker_id: tickerId }).whereRaw("trading_date::text = ?", [tradingDateIso]).select("leg_id as legId", db.raw('expiry::text as expiry'), "strike", db.raw('option_right as "right"'), "last_grade as lastGrade");
  return rows.map((row) => ({ legId: row.legId, expiry: row.expiry, strike: Number(row.strike), right: row.right, lastGrade: row.lastGrade }));
}

export async function upsertDayRollGrades(tickerId: string, tradingDateIso: string, grades: { legId: string; expiry: string; strike: number; right: "C" | "P"; grade: SignalGrade }[]): Promise<void> {
  if (grades.length === 0) return;
  await db("day_signal_roll_grades")
    .insert(grades.map((entry) => ({ ticker_id: tickerId, leg_id: entry.legId, expiry: entry.expiry, strike: entry.strike, option_right: entry.right, trading_date: tradingDateIso, last_grade: entry.grade, updated_at: db.fn.now() })))
    .onConflict(["leg_id", "expiry", "strike", "option_right"])
    .merge(["trading_date", "last_grade", "updated_at"]);
}

/** Assignment-risk alert state of one held short leg — see decideAssignmentRiskAlert (daySignalsNotifications.ts). */
export interface AssignmentRiskAlertState {
  /** Set while the leg is flagged (alerted and not yet re-armed); null = armed. */
  notifiedAt: string | null;
  /** Eastern trading date (YYYY-MM-DD) of the last alert, for the once-per-day rule. */
  lastAlertTradingDateIso: string | null;
}

export async function loadAssignmentRiskAlertStates(legIds: string[]): Promise<Map<string, AssignmentRiskAlertState>> {
  if (legIds.length === 0) return new Map();
  const rows: { id: string; notifiedAt: Date | null; lastAlertTradingDateIso: string | null }[] = await db("position_legs")
    .whereIn("id", legIds)
    .select("id", "assignment_risk_notified_at as notifiedAt", db.raw('assignment_risk_last_alert_trading_date::text as "lastAlertTradingDateIso"'));
  return new Map(rows.map((row) => [row.id, { notifiedAt: row.notifiedAt ? new Date(row.notifiedAt).toISOString() : null, lastAlertTradingDateIso: row.lastAlertTradingDateIso }]));
}

export async function recordAssignmentRiskAlert(legId: string, tradingDateIso: string): Promise<void> {
  await db("position_legs").where({ id: legId }).update({ assignment_risk_notified_at: db.fn.now(), assignment_risk_last_alert_trading_date: tradingDateIso });
}

export async function rearmAssignmentRiskAlert(legId: string): Promise<void> {
  await db("position_legs").where({ id: legId }).update({ assignment_risk_notified_at: null });
}
