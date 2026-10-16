import { db } from "../db/connection.js";
import type { OrderLegPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
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

/** One order's fills of one contract: trades grouped by leg type, side, strike and expiry. */
export interface OrderLegFillRow {
  orderRequestId: string;
  legType: "stock" | "option";
  side: "buy" | "sell";
  strike: string | number | null;
  /** YYYYMMDD. */
  expiry: string | null;
  quantity: string | number;
  notional: string | number;
  commission: string | number | null;
}

/** What has filled of one order leg: the quantity and its quantity-weighted average fill price (null with nothing filled). */
export interface OrderLegFill {
  filledQuantity: number;
  averageFillPrice: number | null;
}

/** A payload leg's expiry as YYYYMMDD: opening legs store IBKR's YYYYMMDD, close and roll legs copied from a position store its ISO date or timestamp ("2026-10-02T00:00:00.000Z"). */
export function normalizeOrderLegExpiryToYyyymmdd(expiry: string | undefined): string | null {
  if (!expiry) return null;
  const isoDatePrefix = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry);
  if (isoDatePrefix) return `${isoDatePrefix[1]}${isoDatePrefix[2]}${isoDatePrefix[3]}`;
  return /^\d{8}$/.test(expiry) ? expiry : null;
}

function orderLegFillKey(role: string, side: string, strike: string | number | null | undefined, expiry: string | null | undefined): string {
  return [role, side.toLowerCase(), strike === null || strike === undefined || strike === "" ? "" : Number(strike), expiry ?? ""].join("|");
}

/**
 * Each payload leg's fills, in the payload's order: matched on leg type, side, strike and expiry, so a roll's close and
 * open legs stay apart. averageFillPrice = Σ(price × quantity) ÷ Σ quantity over the leg's trades.
 */
export function matchOrderLegFills(legs: OrderLegPayload[], fills: OrderLegFillRow[]): OrderLegFill[] {
  const fillByLegKey = new Map(fills.map((fill) => [orderLegFillKey(fill.legType, fill.side, fill.strike, fill.expiry), fill]));
  return legs.map((leg) => {
    const fill = fillByLegKey.get(orderLegFillKey(leg.role, leg.action, leg.strike, normalizeOrderLegExpiryToYyyymmdd(leg.expiry)));
    const filledQuantity = fill ? Number(fill.quantity) : 0;
    return { filledQuantity, averageFillPrice: fill && filledQuantity > 0 ? Number(fill.notional) / filledQuantity : null };
  });
}

/** The orders' fills (trades.source_order_request_id), summed per order and contract. */
export async function fetchOrderLegFillRows(orderRequestIds: string[]): Promise<OrderLegFillRow[]> {
  if (orderRequestIds.length === 0) return [];
  return db("trades as tr")
    .join("position_legs as pl", "pl.id", "tr.position_leg_id")
    .whereIn("tr.source_order_request_id", orderRequestIds)
    .groupBy("tr.source_order_request_id", "pl.leg_type", "tr.side", "pl.strike_price", "pl.expiry_date")
    .select(
      "tr.source_order_request_id as orderRequestId",
      "pl.leg_type as legType",
      "tr.side as side",
      "pl.strike_price as strike",
      db.raw("to_char(pl.expiry_date, 'YYYYMMDD') as expiry"),
      db.raw("SUM(tr.quantity) as quantity"),
      db.raw("SUM(tr.price * tr.quantity) as notional"),
      db.raw("SUM(tr.commission) as commission"),
    );
}

/** Each order's payload legs' fills (matchOrderLegFills), keyed by order id; an order whose payload has no legs gets none. */
export async function fetchOrderLegFillsByOrderId(orders: { id: string; payload: unknown }[]): Promise<Map<string, OrderLegFill[]>> {
  const fillRows = await fetchOrderLegFillRows(orders.map((order) => order.id));
  const fillRowsByOrderId = new Map<string, OrderLegFillRow[]>();
  for (const fillRow of fillRows) fillRowsByOrderId.set(fillRow.orderRequestId, [...(fillRowsByOrderId.get(fillRow.orderRequestId) ?? []), fillRow]);
  return new Map(
    orders.map((order) => {
      const legs = (order.payload as { legs?: unknown } | null)?.legs;
      return [order.id, Array.isArray(legs) ? matchOrderLegFills(legs as OrderLegPayload[], fillRowsByOrderId.get(order.id) ?? []) : []];
    }),
  );
}
