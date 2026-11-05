import { randomUUID } from "node:crypto";
import { OptionType } from "@stoqey/ib";
import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { daysToExpiry, describeOptionContract } from "../lib/optionContractLabel.js";
import type { BookKey } from "./bookKeys.js";
import { loadBooksCutover } from "./bookLedger.js";
import { strategiesAlwaysInManualBook } from "./tickerBookPeriods.js";

// A ticker switched between the books (Marcelo 2026-11-05, D4): its open legs move at their mark, the live mid (else the
// last close, else the entry price). Per leg:
//   value     = mark × quantity × multiplier, a short leg negative
//   realised  = (mark − the source's cost) × quantity × multiplier, a short leg the other way round; the source's cost is
//               the leg's entry price, or its mark when it last moved into that book
// The receiving book pays the source the legs' total value, so neither book's value changes at the switch.
// Example: 200 AMD shares bought at $150.00, mid $162.40 → value $32,480, Manual realises +$2,480; −2 AMD $170 Calls sold
// at $1.80, mid $0.95 → value −$190, Manual realises +$170; Pluto pays Manual $32,290.
// Hedges stay in Manual and do not move. Before the books are started a switch moves nothing.

export interface TickerSwitchLeg {
  legId: string;
  label: string;
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  costBasisPrice: number;
  markPrice: number;
  markSource: "live" | "close" | "entry";
  valueDollars: number;
  realizedDollars: number;
}

export interface TickerSwitchPlan {
  symbol: string;
  fromBook: BookKey;
  toBook: BookKey;
  legs: TickerSwitchLeg[];
  /** What the receiving book pays the source: the legs' total value (negative: the source pays). */
  totalValueDollars: number;
  realizedDollars: number;
}

interface SwitchLegRow {
  id: string;
  leg_type: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  entry_price: string;
  option_type: "call" | "put" | null;
  strike_price: string | null;
  expiry_date: string | null;
  last_closing_price: string | null;
  last_transfer_mark: string | null;
}

/** Pure: a leg's value and realised P&L at `markPrice` against `costBasisPrice`. */
export function legTransferFigures(leg: { side: "long" | "short"; quantity: number; multiplier: number }, costBasisPrice: number, markPrice: number): { valueDollars: number; realizedDollars: number } {
  const sign = leg.side === "short" ? -1 : 1;
  return { valueDollars: sign * markPrice * leg.quantity * leg.multiplier, realizedDollars: sign * (markPrice - costBasisPrice) * leg.quantity * leg.multiplier };
}

/** The plan for switching Pluto on (`enabling`) or off for a ticker; null before the books are started. */
export async function planTickerSwitch(tickerId: string, enabling: boolean, now: Date = new Date()): Promise<TickerSwitchPlan | null> {
  if (!(await loadBooksCutover())) return null;
  const ticker: { symbol: string } = await db("tickers").where({ id: tickerId }).first("symbol");
  const fromBook: BookKey = enabling ? "manual" : "pluto";
  const legs: SwitchLegRow[] = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.ticker_id": tickerId, "p.status": "open" })
    .whereNull("pl.exit_at")
    .whereNotIn("p.strategy_key", strategiesAlwaysInManualBook)
    .select(
      "pl.id",
      "pl.leg_type",
      "pl.side",
      "pl.quantity",
      "pl.multiplier",
      "pl.entry_price",
      "pl.option_type",
      "pl.strike_price",
      db.raw("to_char(pl.expiry_date, 'YYYY-MM-DD') AS expiry_date"),
      db.raw(`(SELECT lps.price::text FROM position_leg_price_snapshots lps WHERE lps.position_leg_id = pl.id ORDER BY lps.snapshot_date DESC LIMIT 1) AS last_closing_price`),
      db.raw(`(SELECT blt.mark_price::text FROM book_leg_transfers blt WHERE blt.position_leg_id = pl.id ORDER BY blt.transferred_at DESC LIMIT 1) AS last_transfer_mark`),
    );
  let prices: Record<string, number | null> = {};
  if (legs.length > 0) {
    try {
      prices = await fetchPricesPoolFirst(
        legs.map((leg) => ({
          key: leg.id,
          legType: leg.leg_type,
          symbol: ticker.symbol,
          expiry: leg.expiry_date?.replace(/-/g, ""),
          strike: leg.strike_price === null ? undefined : Number(leg.strike_price),
          right: leg.option_type === "call" ? OptionType.Call : leg.option_type === "put" ? OptionType.Put : undefined,
        })),
        { settleGraceMs: 1_000 },
      );
    } catch {
      // Every leg falls back to its last close, else its entry price.
    }
  }
  const todayIso = easternIsoDate(now);
  const planLegs = legs.map((leg): TickerSwitchLeg => {
    const live = prices[leg.id] ?? null;
    const markSource = live !== null ? "live" : leg.last_closing_price !== null ? "close" : "entry";
    const markPrice = live ?? Number(leg.last_closing_price ?? leg.entry_price);
    const costBasisPrice = Number(leg.last_transfer_mark ?? leg.entry_price);
    const label =
      leg.leg_type === "stock"
        ? `${leg.quantity} ${ticker.symbol} shares`
        : `${leg.side === "short" ? "−" : ""}${leg.quantity} ${describeOptionContract({ symbol: ticker.symbol, strike: Number(leg.strike_price), right: leg.option_type ?? "call", expiry: leg.expiry_date ?? todayIso, dte: leg.expiry_date ? daysToExpiry(leg.expiry_date, todayIso) : null })}`;
    return { legId: leg.id, label, side: leg.side, quantity: leg.quantity, multiplier: leg.multiplier, costBasisPrice, markPrice, markSource, ...legTransferFigures(leg, costBasisPrice, markPrice) };
  });
  return {
    symbol: ticker.symbol,
    fromBook,
    toBook: enabling ? "pluto" : "manual",
    legs: planLegs,
    totalValueDollars: planLegs.reduce((sum, leg) => sum + leg.valueDollars, 0),
    realizedDollars: planLegs.reduce((sum, leg) => sum + leg.realizedDollars, 0),
  };
}

/** Writes a switch in the caller's transaction: Pluto's ticker period, each leg's transfer and the cash between the books. */
export async function applyTickerSwitch(trx: Knex.Transaction, tickerId: string, plan: TickerSwitchPlan, userId: string | null, now: Date = new Date()): Promise<void> {
  if (plan.toBook === "pluto") await trx("ticker_book_periods").insert({ ticker_id: tickerId, book_key: "pluto", started_at: now, created_by_user_id: userId });
  else await trx("ticker_book_periods").where({ ticker_id: tickerId }).whereNull("ended_at").update({ ended_at: now });
  if (plan.legs.length === 0) return;
  const groupId = randomUUID();
  await trx("book_leg_transfers").insert(
    plan.legs.map((leg) => ({
      position_leg_id: leg.legId,
      from_book: plan.fromBook,
      to_book: plan.toBook,
      transferred_at: now,
      quantity: leg.quantity,
      mark_price: leg.markPrice,
      cost_basis_price: leg.costBasisPrice,
      value_dollars: leg.valueDollars,
      realized_dollars: leg.realizedDollars,
      mark_source: leg.markSource,
      group_id: groupId,
      created_by_user_id: userId,
    })),
  );
  if (plan.totalValueDollars === 0) return;
  const description = `${plan.symbol} moved from ${plan.fromBook === "pluto" ? "Pluto" : "Manual"} to ${plan.toBook === "pluto" ? "Pluto" : "Manual"} at the mark`;
  await trx("book_cash_entries").insert([
    { book_key: plan.toBook, amount: -plan.totalValueDollars, effective_at: now, kind: "ticker_transfer", group_id: groupId, symbol: plan.symbol, description, created_by_user_id: userId },
    { book_key: plan.fromBook, amount: plan.totalValueDollars, effective_at: now, kind: "ticker_transfer", group_id: groupId, symbol: plan.symbol, description, created_by_user_id: userId },
  ]);
}
