import { db } from "../db/connection.js";
import { describeTradeLine } from "./tradeMessageFormatting.js";

export interface OrderFill {
  side: string;
  quantity: number;
  price: number;
  optionType: "call" | "put" | null;
  strikePrice: number | null;
  expiryDate: string | null;
}

/** The fills the worker recorded for an order (trades.source_order_request_id), oldest first. */
export async function loadOrderFills(orderId: string): Promise<OrderFill[]> {
  const rows = await db("trades as t")
    .leftJoin("position_legs as pl", "pl.id", "t.position_leg_id")
    .where("t.source_order_request_id", orderId)
    .orderBy("t.executed_at")
    .select("t.side", "t.quantity", "t.price", "pl.option_type as optionType", "pl.strike_price as strikePrice", db.raw("to_char(pl.expiry_date, 'YYYY-MM-DD') as \"expiryDate\""));
  return rows.map((row) => ({ ...row, price: Number(row.price), strikePrice: row.strikePrice === null ? null : Number(row.strikePrice) }));
}

/** "• SELL 2 put $50 exp 2026-10-16 at 1.35" */
export function describeOrderFillLine(fill: OrderFill): string {
  return describeTradeLine(fill.side, { legType: fill.optionType ? "option" : "stock", ...fill }, fill.price);
}

/** Statuses whose message lists fills. */
export const fillBearingOrderStatuses = ["partially_filled", "filled", "cancelled_partially_filled"];

/**
 * A new contract's opening fill is written only when the next reconciliation pass creates its leg
 * (ibkrGatewayOrderTracking.ts buffers it until then), so an order can read "filled" before its fills,
 * or with only a roll's closing leg. A message waits for them this long after the status changed.
 */
const fillWaitMs = 5 * 60_000;

/** Whether the fills a message needs are all recorded: every ordered unit for "filled", at least one otherwise. */
export function fillsAreComplete(status: string, legs: { quantity: number }[], fills: Pick<OrderFill, "quantity">[]): boolean {
  if (status !== "filled") return fills.length > 0;
  const orderedQuantity = legs.reduce((sum, leg) => sum + Number(leg.quantity), 0);
  const filledQuantity = fills.reduce((sum, fill) => sum + Number(fill.quantity), 0);
  return filledQuantity >= orderedQuantity;
}

/** Whether a fill-bearing message should wait for a later pass: its fills are incomplete and the wait is not over. */
export function shouldWaitForFills(status: string, legs: { quantity: number }[], fills: Pick<OrderFill, "quantity">[], statusChangedAt: Date, now: number): boolean {
  return !fillsAreComplete(status, legs, fills) && now - statusChangedAt.getTime() < fillWaitMs;
}

/**
 * SQL condition (on order_requests aliased `alias`) for an order IBKR has reported filled, or partly filled then cancelled, within
 * the fill wait, whose fills are not all recorded yet (fillsAreComplete in SQL). A new contract's fills wait for the
 * reconciliation that creates its position, so until then the order is neither working nor a position: whatever counts
 * working orders (in-flight notional, taken contracts) must count it too.
 */
export function orderFillsPendingSql(alias: string): string {
  const recordedQuantity = `coalesce((select sum(tr.quantity) from trades tr where tr.source_order_request_id = ${alias}.id), 0)`;
  const orderedQuantity = `coalesce((select sum((leg->>'quantity')::numeric) from jsonb_array_elements(coalesce(${alias}.payload->'legs', '[]'::jsonb)) leg), 0)`;
  return `(${alias}.updated_at > now() - interval '${fillWaitMs / 1000} seconds' and (
    (${alias}.status = 'filled' and ${recordedQuantity} < ${orderedQuantity})
    or (${alias}.status = 'cancelled_partially_filled' and ${recordedQuantity} = 0)))`;
}

/**
 * SQL condition (on order_requests aliased `alias`) for an order cancelled before it was ever sent to IBKR: a review panel
 * closed without Confirm, or a gate-blocked Genosuke or Pluto order. Not news for a follow-up message. One left unconfirmed
 * until the stale sweep cancelled it (not_confirmed_in_time) is not included: that one is still told.
 */
export function orderCancelledBeforeSentSql(alias: string): string {
  return `(${alias}.status = 'cancelled' and ${alias}.ibkr_order_id is null and ${alias}.cancellation_reason is distinct from 'not_confirmed_in_time')`;
}
