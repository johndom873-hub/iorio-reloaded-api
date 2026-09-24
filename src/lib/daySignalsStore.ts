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
