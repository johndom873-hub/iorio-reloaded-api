import { db } from "../db/connection.js";
import { easternIsoDate } from "./easternIsoDate.js";
import { activeOrderRequestStatuses } from "./orderRequestStatuses.js";
import { computeNetLimitPrice, type OrderLegPayload, type OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

export interface TodaysOrderLeg {
  role: "stock" | "option";
  action: string;
  quantity: number;
  unitPrice: number;
  strike: number | null;
  /** YYYYMMDD, as stored in the order payload. */
  expiry: string | null;
  right: "C" | "P" | null;
  filledQuantity: number;
  averageFillPrice: number | null;
}

export interface TodaysOrder {
  id: string;
  requestType: string;
  status: string;
  symbol: string;
  strategyKey: string;
  createdAt: string;
  updatedAt: string;
  requestedByDisplayName: string | null;
  cancelledByDisplayName: string | null;
  /** Why it ended cancelled when no user cancelled it: expired_at_close, cancelled_by_ibkr or not_confirmed_in_time. */
  cancellationReason: string | null;
  errorMessage: string | null;
  ibkrOrderId: number | null;
  ibkrPermId: number | null;
  adaptivePriority: string | null;
  /** Per-share net of the legs' limit prices: positive is a net debit, negative a net credit (the worker's own combo limit). */
  netLimitPrice: number;
  /** Total commission over this order's fills; null when no fill has a commission yet. */
  commission: number | null;
  legs: TodaysOrderLeg[];
}

export interface TodaysOrderRow {
  id: string;
  request_type: string;
  status: string;
  payload: OrderRequestPayload;
  created_at: Date;
  updated_at: Date;
  requested_by_display_name: string | null;
  cancelled_by_display_name: string | null;
  cancellation_reason: string | null;
  error_message: string | null;
  ibkr_order_id: number | null;
  ibkr_perm_id: number | null;
}

/** One order's fills of one contract: trades grouped by leg type, side, strike and expiry. */
export interface TodaysOrderFillRow {
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

/** A payload leg's expiry as YYYYMMDD: opening legs store IBKR's YYYYMMDD, close and roll legs copied from a position store its ISO date or timestamp ("2026-10-02T00:00:00.000Z"). */
function normalizeExpiryToYyyymmdd(expiry: string | undefined): string | null {
  if (!expiry) return null;
  const isoDatePrefix = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry);
  if (isoDatePrefix) return `${isoDatePrefix[1]}${isoDatePrefix[2]}${isoDatePrefix[3]}`;
  return /^\d{8}$/.test(expiry) ? expiry : null;
}

function legFillKey(role: string, side: string, strike: string | number | null | undefined, expiry: string | null | undefined): string {
  return [role, side.toLowerCase(), strike === null || strike === undefined || strike === "" ? "" : Number(strike), expiry ?? ""].join("|");
}

/** Pairs each order with its legs' fills (matched on leg type, side, strike and expiry, so a roll's close and open legs stay apart). */
export function buildTodaysOrders(orderRows: TodaysOrderRow[], fillRows: TodaysOrderFillRow[]): TodaysOrder[] {
  const fillsByOrderId = new Map<string, TodaysOrderFillRow[]>();
  for (const fill of fillRows) {
    const fills = fillsByOrderId.get(fill.orderRequestId) ?? [];
    fills.push(fill);
    fillsByOrderId.set(fill.orderRequestId, fills);
  }

  return orderRows.map((row) => {
    const fills = fillsByOrderId.get(row.id) ?? [];
    const fillByLegKey = new Map(fills.map((fill) => [legFillKey(fill.legType, fill.side, fill.strike, fill.expiry), fill]));
    const legs = row.payload.legs.map((leg: OrderLegPayload): TodaysOrderLeg => {
      const expiry = normalizeExpiryToYyyymmdd(leg.expiry);
      const fill = fillByLegKey.get(legFillKey(leg.role, leg.action, leg.strike, expiry));
      const filledQuantity = fill ? Number(fill.quantity) : 0;
      return {
        role: leg.role,
        action: leg.action,
        quantity: leg.quantity,
        unitPrice: leg.unitPrice,
        strike: leg.strike ?? null,
        expiry,
        right: leg.right ?? null,
        filledQuantity,
        averageFillPrice: fill && filledQuantity > 0 ? Number(fill.notional) / filledQuantity : null,
      };
    });
    const commissions = fills.filter((fill) => fill.commission !== null).map((fill) => Number(fill.commission));
    return {
      id: row.id,
      requestType: row.request_type,
      status: row.status,
      symbol: row.payload.symbol,
      strategyKey: row.payload.strategyKey,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      requestedByDisplayName: row.requested_by_display_name,
      cancelledByDisplayName: row.cancelled_by_display_name,
      cancellationReason: row.cancellation_reason,
      errorMessage: row.error_message,
      ibkrOrderId: row.ibkr_order_id,
      ibkrPermId: row.ibkr_perm_id,
      adaptivePriority: row.payload.adaptivePriority ?? null,
      netLimitPrice: computeNetLimitPrice(row.payload.legs),
      commission: commissions.length > 0 ? commissions.reduce((sum, commission) => sum + commission, 0) : null,
      legs,
    };
  });
}

/**
 * Orders whose last status update falls on `now`'s America/New_York calendar date, plus every order still
 * active (pending, working or cancelling) whatever its date: a DAY order placed after hours is held by IBKR
 * until the next session while its updated_at stays on the earlier date. Newest update first.
 */
export async function fetchTodaysOrders(now: Date = new Date()): Promise<TodaysOrder[]> {
  const orderRows: TodaysOrderRow[] = await db("order_requests as orq")
    .leftJoin("users as ru", "ru.id", "orq.requested_by_user_id")
    .leftJoin("users as cu", "cu.id", "orq.cancelled_by_user_id")
    .where((builder) =>
      builder.whereRaw("(orq.updated_at AT TIME ZONE 'America/New_York')::date = ?::date", [easternIsoDate(now)]).orWhereIn("orq.status", [...activeOrderRequestStatuses]),
    )
    .orderBy("orq.updated_at", "desc")
    .select(
      "orq.id",
      "orq.request_type",
      "orq.status",
      "orq.payload",
      "orq.created_at",
      "orq.updated_at",
      "orq.error_message",
      "orq.cancellation_reason",
      "orq.ibkr_order_id",
      "orq.ibkr_perm_id",
      "ru.display_name as requested_by_display_name",
      "cu.display_name as cancelled_by_display_name",
    );
  if (orderRows.length === 0) return [];

  const fillRows: TodaysOrderFillRow[] = await db("trades as tr")
    .join("position_legs as pl", "pl.id", "tr.position_leg_id")
    .whereIn(
      "tr.source_order_request_id",
      orderRows.map((row) => row.id),
    )
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

  return buildTodaysOrders(orderRows, fillRows);
}
