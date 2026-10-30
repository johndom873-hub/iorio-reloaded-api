import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { VolFarmerV2LegStatus } from "../backtest/engine/volFarmerV2Steps.js";
import { settlesAssigned } from "../lib/cycleBreakEven.js";
import { previousOpenSessionDate } from "../lib/marketSessionStatus.js";
import { orderFillsPendingSql } from "../lib/orderFills.js";
import { activeOrderRequestStatuses } from "../lib/orderRequestStatuses.js";
import { volFarmerV2MemoryFromStored, type VolFarmerV2Memory, type VolFarmerV2OrderOutcome } from "./volFarmerV2LiveBook.js";

// What Vol Farmer v2's look at a ticker reads from the database (volFarmerV2LiveBook.ts): its memory, how the orders it
// sent ended, and the status of every leg its memory refers to.

export async function loadVolFarmerV2Memory(tickerId: string, connection: Knex = db): Promise<VolFarmerV2Memory | null> {
  const row: { memory: VolFarmerV2Memory | null } | undefined = await connection("pluto_vol_farmer_v2_cycles").where({ ticker_id: tickerId }).first("memory");
  return row?.memory ? volFarmerV2MemoryFromStored(row.memory) : null;
}

/** Saves the memory; the cash check the backtest's note reads is left out (it only grows). `adopted`: the first save of holdings v2 adopted. */
export async function saveVolFarmerV2Memory(tickerId: string, memory: VolFarmerV2Memory, adopted: boolean, connection: Knex = db): Promise<void> {
  const stored: VolFarmerV2Memory = { ...memory, state: { ...memory.state, cash: { cycles: 0, firstPositionCashLeft: [], putsCashLeft: [], leapsTriggers: [] }, leapsTrigger: null } };
  const row = { ticker_id: tickerId, memory: JSON.stringify(stored), updated_at: connection.fn.now(), ...(adopted ? { adopted_at: connection.fn.now() } : {}) };
  await connection("pluto_vol_farmer_v2_cycles").insert(row).onConflict("ticker_id").merge();
}

/** The figures a round read for a ticker, for the Pluto screen's warnings. */
export interface VolFarmerV2RoundFigures {
  /** The ticker's pot: its allocation of Pluto's budget, the cap the pot check holds its orders to. */
  potDollars: number;
  /** What the ticker commits as the pot check counts it: its exposure (Positions' EXP $) plus its orders still working. */
  committedDollars: number;
  /** The free cash v2's steps were given: Pluto's budget left, at most the account's free cash. */
  freeCashDollars: number;
  /** The most a LEAPS purchase spends: v2's LEAPS cap, % of the pot. */
  leapsCapDollars: number;
  /** What the Puts sell on: the pot less the First position's share (rounds before 2026-10-30 lack it: half the pot). */
  putsDollars?: number;
}

/** A round's notes on a ticker and its figures (null: it stopped before reading the book); a ticker not adopted yet gets a row with no memory. */
export async function saveVolFarmerV2LastRound(tickerId: string, lastRound: { at: Date; notes: string[]; figures: VolFarmerV2RoundFigures | null }, connection: Knex = db): Promise<void> {
  const row = { ticker_id: tickerId, last_round_at: lastRound.at, last_round_notes: JSON.stringify(lastRound.notes), last_round_figures: lastRound.figures === null ? null : JSON.stringify(lastRound.figures) };
  await connection("pluto_vol_farmer_v2_cycles").insert(row).onConflict("ticker_id").merge(["last_round_at", "last_round_notes", "last_round_figures"]);
}

/** Every ticker's memory forgotten, for a ticker whose strategy changes: v2 adopts its holdings afresh when it next runs it. */
export async function clearVolFarmerV2Memory(tickerId: string, connection: Knex = db): Promise<void> {
  await connection("pluto_vol_farmer_v2_cycles").where({ ticker_id: tickerId }).delete();
}

/** How each action's order ended: still working (or its fills still arriving), else its fills. An action that built no order did not fill. */
export async function loadVolFarmerV2OrderOutcomes(actionIds: readonly string[], connection: Knex = db): Promise<Map<string, VolFarmerV2OrderOutcome>> {
  const outcomes = new Map<string, VolFarmerV2OrderOutcome>();
  if (actionIds.length === 0) return outcomes;
  const orders: { action_id: string; order_id: string | null; status: string | null; fills_pending: boolean | null }[] = await connection("pluto_actions as pa")
    .leftJoin("order_requests as orq", "orq.id", "pa.order_request_id")
    .whereIn("pa.id", actionIds)
    .select("pa.id as action_id", "orq.id as order_id", "orq.status", connection.raw(`${orderFillsPendingSql("orq")} as fills_pending`));
  const orderIds = orders.map((order) => order.order_id).filter((id): id is string => id !== null);
  const fills: { order_id: string; leg_id: string; leg_type: "stock" | "option"; multiplier: number; side: "buy" | "sell"; quantity: number; price: string; commission: string | null }[] =
    orderIds.length === 0
      ? []
      : await connection("trades as tr").join("position_legs as pl", "pl.id", "tr.position_leg_id").whereIn("tr.source_order_request_id", orderIds).select("tr.source_order_request_id as order_id", "pl.id as leg_id", "pl.leg_type", "pl.multiplier", "tr.side", "tr.quantity", "tr.price", "tr.commission");
  for (const order of orders) {
    const working = order.order_id !== null && ((activeOrderRequestStatuses as readonly string[]).includes(order.status ?? "") || order.fills_pending === true);
    const own = fills.filter((fill) => fill.order_id === order.order_id);
    const optionFills = own.filter((fill) => fill.leg_type === "option");
    const stockFills = own.filter((fill) => fill.leg_type === "stock" && fill.side === "buy");
    // A sale's premium is what it brought in less commission; a purchase's what it cost with commission.
    const optionNetDollars = optionFills.reduce((sum, fill) => {
      const gross = Number(fill.price) * fill.quantity * Number(fill.multiplier);
      const commission = Number(fill.commission ?? 0);
      return sum + (fill.side === "sell" ? gross - commission : gross + commission);
    }, 0);
    outcomes.set(order.action_id, {
      working,
      filledContracts: optionFills.reduce((sum, fill) => sum + fill.quantity, 0),
      optionLegIds: [...new Set(optionFills.map((fill) => fill.leg_id))],
      optionNetDollars,
      sharesBought: stockFills.reduce((sum, fill) => sum + fill.quantity, 0),
      sharesCostDollars: stockFills.reduce((sum, fill) => sum + Number(fill.price) * fill.quantity + Number(fill.commission ?? 0), 0),
    });
  }
  return outcomes;
}

/**
 * Each leg's status: closed once it has left the book, assigned as the cycle ledger books a short option (settled
 * without a trade and in the money by the threshold at its expiry's close: cycleBreakEven.ts settlesAssigned).
 */
export async function loadVolFarmerV2LegStatuses(legIds: readonly string[], connection: Knex = db): Promise<Map<string, VolFarmerV2LegStatus>> {
  const statuses = new Map<string, VolFarmerV2LegStatus>();
  if (legIds.length === 0) return statuses;
  const rows: { id: string; position_id: string; leg_type: string; side: "long" | "short"; option_type: "call" | "put" | null; strike_price: string | null; expiry_date: string | null; quantity: number; multiplier: number; entry_price: string; entry_at: Date; exit_price: string | null; exit_at: Date | null; has_closing_trade: boolean; expiry_close: string | null }[] = await connection("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .whereIn("pl.id", legIds)
    .select(
      "pl.id",
      "pl.position_id",
      "pl.leg_type",
      "pl.side",
      "pl.option_type",
      "pl.strike_price",
      connection.raw("pl.expiry_date::text as expiry_date"),
      "pl.quantity",
      "pl.multiplier",
      "pl.entry_price",
      "pl.entry_at",
      "pl.exit_price",
      "pl.exit_at",
      connection.raw("exists (select 1 from trades tr where tr.position_leg_id = pl.id and tr.is_closing_trade) as has_closing_trade"),
      connection.raw("(select b.close_price from daily_price_bars b where b.ticker_id = p.ticker_id and b.trading_date = pl.expiry_date) as expiry_close"),
    );
  for (const row of rows) {
    const strike = row.strike_price === null ? null : Number(row.strike_price);
    const assigned =
      row.leg_type === "option" &&
      row.option_type !== null &&
      strike !== null &&
      row.expiry_date !== null &&
      settlesAssigned({
        id: row.id,
        positionId: row.position_id,
        side: row.side,
        optionType: row.option_type,
        strike,
        quantity: row.quantity,
        multiplier: Number(row.multiplier),
        entryPrice: Number(row.entry_price),
        entryAt: new Date(row.entry_at),
        exitPrice: row.exit_price === null ? null : Number(row.exit_price),
        exitAt: row.exit_at === null ? null : new Date(row.exit_at),
        closingCommission: 0,
        hasClosingTrade: row.has_closing_trade,
        expiryDate: row.expiry_date,
        expiryClose: row.expiry_close === null ? null : Number(row.expiry_close),
        positionCloseReason: null,
      });
    statuses.set(row.id, { closed: row.exit_at !== null, assigned, strike, contracts: row.quantity });
  }
  return statuses;
}

/** IBKR's 30-day implied volatility stored for the session before today (market calendar); null when its bar has none. */
export async function loadVolFarmerV2StepImpliedVolatility(tickerId: string, todayIso: string, connection: Knex = db): Promise<number | null> {
  const previousSessionIso = await previousOpenSessionDate(todayIso);
  const row: { implied_volatility: string | null } | undefined = await connection("daily_price_bars").where({ ticker_id: tickerId, trading_date: previousSessionIso }).first("implied_volatility");
  const stored = row?.implied_volatility ?? null;
  const impliedVolatility = stored === null ? null : Number(stored);
  return impliedVolatility !== null && impliedVolatility > 0 ? impliedVolatility : null;
}
