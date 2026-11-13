import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { closingTradeOtherThanSettlementSql } from "../lib/settlementExecution.js";
import type { BookKey, LedgerBookKey } from "./bookKeys.js";
import { bookOfLegAt, type TickerBookPeriod } from "./tickerBookPeriods.js";

// The books' cash (Marcelo 2026-11-05). A book's cash is its confirmed ledger (book_cash_entries: IBKR's statement rows,
// admin splits and moves, ticker transfers, the opening balance) plus what moved since the last statement and is not in
// it yet, worked out from the app's own records each time and never stored, so the next statement simply takes its place:
//   a fill:                ± quantity × price × multiplier − commission (a sale +, a purchase −)
//   an assigned option leg (no closing trade): a short Put −strike × multiplier × quantity (shares bought), a short Call
//                          + (shares sold); a long option exercised the other way round. Only when the app holds no IBKR
//                          stock fill at the strike for that ticker within a day of the leg's exit: the worker saves the
//                          shares' fill (a Put's on the new shares' position), which already counts as a fill.
// Example: 2 AMD $150 Puts sold at $1.20 with $1.30 commission → +$238.70; one of them assigned → −$15,000.

export interface BooksCutover {
  cutOverAt: Date;
  statementToDate: string | null;
  ibkrCash: number;
  plutoStartingValue: number;
  plutoPositionsValue: number;
}

export async function loadBooksCutover(connection: Knex = db): Promise<BooksCutover | null> {
  const row = await connection("books_cutover").first("cut_over_at", db.raw("statement_to_date::text as statement_to_date"), "ibkr_cash", "pluto_starting_value", "pluto_positions_value");
  if (!row) return null;
  return {
    cutOverAt: new Date(row.cut_over_at),
    statementToDate: row.statement_to_date ?? null,
    ibkrCash: Number(row.ibkr_cash),
    plutoStartingValue: Number(row.pluto_starting_value),
    plutoPositionsValue: Number(row.pluto_positions_value),
  };
}

/** Where the confirmed ledger stops: the latest statement read since the cut-over, else the cut-over itself. */
export async function loadConfirmedLedgerCutOffAt(cutover: BooksCutover, connection: Knex = db): Promise<Date> {
  const row = await connection("book_statement_imports").where("cut_off_at", ">=", cutover.cutOverAt).max("cut_off_at as latest").first();
  return row?.latest ? new Date(row.latest) : cutover.cutOverAt;
}

/** Each ledger bucket's confirmed cash, from entries before `before` (every entry when null). */
export async function loadLedgerCashByBook(before: Date | null, connection: Knex = db): Promise<Record<LedgerBookKey, number>> {
  let query = connection("book_cash_entries").groupBy("book_key").select("book_key", connection.raw("SUM(amount)::text AS total"));
  if (before !== null) query = query.where("effective_at", "<", before);
  const rows: { book_key: LedgerBookKey; total: string }[] = await query;
  const totals: Record<LedgerBookKey, number> = { pluto: 0, manual: 0, unallocated: 0 };
  for (const row of rows) totals[row.book_key] = Number(row.total);
  return totals;
}

export interface ProvisionalCashMovement {
  book: BookKey;
  amount: number;
  at: Date;
  kind: "fill" | "assignment";
}

interface ProvisionalFillRow {
  side: "buy" | "sell";
  quantity: number;
  price: string;
  commission: string | null;
  executed_at: Date;
  multiplier: number;
  strategy_key: string;
  ticker_id: string;
}

interface ProvisionalAssignmentRow {
  quantity: number;
  multiplier: number;
  strike_price: string;
  option_type: "call" | "put";
  side: "long" | "short";
  exit_at: Date;
  strategy_key: string;
  ticker_id: string;
}

/** Pure: a fill's cash. Example: sell 2 contracts at $1.20, multiplier 100, commission $1.30 → +$238.70. */
export function fillCash(fill: { side: "buy" | "sell"; quantity: number; price: number; multiplier: number; commission: number | null }): number {
  const gross = fill.quantity * fill.price * fill.multiplier;
  return (fill.side === "sell" ? gross : -gross) - Math.abs(fill.commission ?? 0);
}

/** Pure: an assigned or exercised option's cash. A short Put assigned buys the shares at the strike (−), a short Call sells them (+). */
export function assignmentCash(leg: { side: "long" | "short"; optionType: "call" | "put"; strike: number; multiplier: number; quantity: number }): number {
  const shares = leg.strike * leg.multiplier * leg.quantity;
  const sharesBought = (leg.side === "short" && leg.optionType === "put") || (leg.side === "long" && leg.optionType === "call");
  return sharesBought ? -shares : shares;
}

/** Cash moved since `since` that no statement holds yet, from the app's fills and assigned option legs. */
export async function loadProvisionalCashMovements(since: Date, periods: readonly TickerBookPeriod[], connection: Knex = db): Promise<ProvisionalCashMovement[]> {
  const [fills, assignments]: [ProvisionalFillRow[], ProvisionalAssignmentRow[]] = await Promise.all([
    connection("trades as tr")
      .join("position_legs as pl", "pl.id", "tr.position_leg_id")
      .join("positions as p", "p.id", "pl.position_id")
      .where("tr.executed_at", ">=", since)
      .select("tr.side", "tr.quantity", "tr.price", "tr.commission", "tr.executed_at", "pl.multiplier", "p.strategy_key", "p.ticker_id"),
    connection("position_legs as pl")
      .join("positions as p", "p.id", "pl.position_id")
      .where("pl.leg_type", "option")
      .where("pl.exit_at", ">=", since)
      .where("p.close_reason", "assigned")
      .whereNotNull("pl.strike_price")
      .whereNotExists(connection("trades").whereRaw("trades.position_leg_id = pl.id").whereRaw(closingTradeOtherThanSettlementSql("trades")))
      .whereNotExists(
        connection("trades as stock_fill")
          .join("position_legs as stock_leg", "stock_leg.id", "stock_fill.position_leg_id")
          .join("positions as stock_position", "stock_position.id", "stock_leg.position_id")
          .whereRaw("stock_position.ticker_id = p.ticker_id")
          .where("stock_leg.leg_type", "stock")
          .whereRaw("coalesce(stock_fill.ibkr_order_id, '') = '0'")
          .whereNull("stock_fill.source_order_request_id")
          .whereRaw("stock_fill.price = pl.strike_price")
          .whereRaw("stock_fill.executed_at BETWEEN pl.exit_at - interval '1 day' AND pl.exit_at + interval '1 day'"),
      )
      .select("pl.quantity", "pl.multiplier", "pl.strike_price", "pl.option_type", "pl.side", "pl.exit_at", "p.strategy_key", "p.ticker_id"),
  ]);
  const movements: ProvisionalCashMovement[] = [];
  for (const fill of fills) {
    const at = new Date(fill.executed_at);
    movements.push({ book: bookOfLegAt(periods, fill.ticker_id, fill.strategy_key, at), at, kind: "fill", amount: fillCash({ side: fill.side, quantity: fill.quantity, price: Number(fill.price), multiplier: fill.multiplier, commission: fill.commission === null ? null : Number(fill.commission) }) });
  }
  for (const leg of assignments) {
    const at = new Date(leg.exit_at);
    movements.push({ book: bookOfLegAt(periods, leg.ticker_id, leg.strategy_key, at), at, kind: "assignment", amount: assignmentCash({ side: leg.side, optionType: leg.option_type, strike: Number(leg.strike_price), multiplier: leg.multiplier, quantity: leg.quantity }) });
  }
  return movements;
}

/**
 * Sale proceeds not settled yet (T+1), per book: today's provisional sales (New York date), and confirmed statement
 * trades whose settle date is after today. A cash account buys only with settled cash.
 */
export async function loadUnsettledSaleProceedsByBook(provisional: readonly ProvisionalCashMovement[], now: Date, connection: Knex = db): Promise<Record<BookKey, number>> {
  const todayIso = easternIsoDate(now);
  const todayFlex = todayIso.replace(/-/g, "");
  const totals: Record<BookKey, number> = { pluto: 0, manual: 0 };
  for (const movement of provisional) {
    if (movement.kind === "fill" && movement.amount > 0 && easternIsoDate(movement.at) === todayIso) totals[movement.book] += movement.amount;
  }
  const confirmed: { book_key: BookKey; total: string }[] = await connection("book_cash_entries")
    .where({ kind: "trade" })
    .whereIn("book_key", ["pluto", "manual"])
    .where("amount", ">", 0)
    .whereRaw("statement_row->>'settleDateTarget' > ?", [todayFlex])
    .groupBy("book_key")
    .select("book_key", connection.raw("SUM(amount)::text AS total"));
  for (const row of confirmed) totals[row.book_key] += Number(row.total);
  return totals;
}
