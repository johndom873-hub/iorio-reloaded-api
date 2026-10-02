import type { Knex } from "knex";
import { db } from "../db/connection.js";

// A leg's `quantity` is overwritten with IBKR's current holding on every reconcile pass, and realized
// P&L is (exit - entry) x quantity. Shares sold in several fills therefore used to vanish from P&L: the
// leg ended up closed with only the last remaining quantity (COHR: 200 sold, 40 recorded) and the exit
// price of the last fill. Approved 2026-10-01: shares that leave while others remain are carved into
// their own closed leg (the sold quantity, the parent's entry price and time, the fills' weighted
// average as exit price, and the closing trades moved onto it), so every closed row carries the
// quantity it was actually closed over and the P&L formula stays untouched.

export interface ClosingFill {
  id: string;
  quantity: number;
  price: number;
  executedAt: Date;
}

const exitPriceDecimals = 4;

/** Quantity-weighted average of the fills' prices, rounded to the precision of trades.price. */
export function weightedAverageFillPrice(fills: ClosingFill[]): number {
  const totalQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  const totalValue = fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
  return Number((totalValue / totalQuantity).toFixed(exitPriceDecimals));
}

/**
 * The whole fills, oldest first, that fit inside the quantity IBKR's holding actually dropped by.
 * A fill that does not fit (or any after it) waits for a later pass once the holding confirms it, so
 * a closing trade is never attributed to shares the held report still shows.
 */
export function chooseFillsForPartialClose(fillsOldestFirst: ClosingFill[], droppedQuantity: number): ClosingFill[] {
  const chosen: ClosingFill[] = [];
  let cumulativeQuantity = 0;
  for (const fill of fillsOldestFirst) {
    if (cumulativeQuantity + fill.quantity > droppedQuantity) break;
    chosen.push(fill);
    cumulativeQuantity += fill.quantity;
  }
  return chosen;
}

async function loadClosingFills(legId: string, database: Knex): Promise<ClosingFill[]> {
  const rows = await database("trades").where({ position_leg_id: legId, is_closing_trade: true }).orderBy("executed_at", "asc").orderBy("id", "asc");
  return rows.map((row) => ({ id: row.id, quantity: Number(row.quantity), price: Number(row.price), executedAt: new Date(row.executed_at) }));
}

/**
 * The exit a fully closed leg gets from its closing fills: their weighted average price and the time of
 * the last one. null when it has no fills (an expiry, an assignment, or a close made outside the app).
 */
export async function exitFromClosingFills(legId: string, database: Knex = db): Promise<{ exitPrice: number; exitAt: Date } | null> {
  const fills = await loadClosingFills(legId, database);
  if (fills.length === 0) return null;
  return { exitPrice: weightedAverageFillPrice(fills), exitAt: fills[fills.length - 1]!.executedAt };
}

/** The cost per share of the shares these fills sold, when it differs from the parent leg's entry; null keeps the parent's. */
export type SoldSharesEntryPriceLookup = (soldFills: ClosingFill[], database: Knex) => Promise<number | null>;

/**
 * Call BEFORE overwriting an open leg's quantity with IBKR's new holding. When the holding dropped and
 * closing fills explain (some of) the drop, the closed shares become their own closed leg. Returns the
 * new leg's id, or null when nothing was carved (no drop, or no closing fill that fits yet). The slice
 * takes the parent's entry unless soldSharesEntryPrice knows the sold lot's own cost (FIFO sells the oldest lot).
 */
export async function carveClosedSliceFromPartialClose(
  leg: { id: string; quantity: number },
  heldQuantity: number,
  database: Knex = db,
  soldSharesEntryPrice?: SoldSharesEntryPriceLookup,
): Promise<string | null> {
  const droppedQuantity = Number(leg.quantity) - heldQuantity;
  if (droppedQuantity <= 0) return null;

  return database.transaction(async (transaction) => {
    const chosenFills = chooseFillsForPartialClose(await loadClosingFills(leg.id, transaction), droppedQuantity);
    if (chosenFills.length === 0) return null;

    const parentLeg = await transaction("position_legs").where({ id: leg.id }).first();
    const { id: _parentId, ...parentColumns } = parentLeg;
    const soldEntryPrice = soldSharesEntryPrice ? await soldSharesEntryPrice(chosenFills, transaction) : null;
    const [slice] = await transaction("position_legs")
      .insert({
        ...parentColumns,
        entry_price: soldEntryPrice ?? parentColumns.entry_price,
        quantity: chosenFills.reduce((sum, fill) => sum + fill.quantity, 0),
        exit_price: weightedAverageFillPrice(chosenFills),
        exit_at: chosenFills[chosenFills.length - 1]!.executedAt,
        assignment_risk_notified_at: null,
        assignment_risk_last_alert_trading_date: null,
      })
      .returning(["id"]);
    await transaction("trades")
      .whereIn(
        "id",
        chosenFills.map((fill) => fill.id),
      )
      .update({ position_leg_id: slice!.id });
    return slice!.id as string;
  });
}
