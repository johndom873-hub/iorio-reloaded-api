import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { computeInFlightOrderNotional } from "../lib/orderLimits.js";

// EXP $ per Pluto order, the way Positions counts exposure (mockup approved 2026-10-06): an open or a roll adds
// what the order gate counts for it (orderLimits.computeInFlightOrderNotional); a close releases exposure, shown
// negative — a put buyback frees strike × 100 per contract, selling shares frees shares × price; buying back a
// call frees nothing (the shares stay). A working order counts its ordered quantity, a filled one what filled
// (a partial fill scales the order's figure by the filled share); an order that never filled, was blocked or
// rejected shows nothing.

export interface PlutoActionExposureInput {
  kind: string;
  outcome: string;
  contract: Record<string, unknown> | null;
  quantity: number | null;
  limitPrice: number | null;
  fillPrice: number | null;
}

export interface PlutoActionOrderRequest {
  requestType: string;
  payload: OrderRequestPayload;
  /** Contracts (or shares, for a share sale) the order's trades filled so far; null before any fill. */
  filledQuantity: number | null;
}

const outcomesWithExposure = new Set(["order_built", "confirmed", "filled", "partially_filled", "cancelled_partially_filled"]);

export function computePlutoActionExposure(action: PlutoActionExposureInput, order: PlutoActionOrderRequest | null): number | null {
  if (order === null || !outcomesWithExposure.has(action.outcome)) return null;
  const ordered = action.quantity ?? 0;
  const quantity = order.filledQuantity ?? ordered;
  if (action.kind === "close_leg") {
    const strike = Number(action.contract?.strike ?? 0);
    return action.contract?.right === "P" && strike > 0 ? -strike * 100 * quantity : 0;
  }
  if (action.kind === "close_shares") {
    const price = action.fillPrice ?? action.limitPrice ?? 0;
    return -quantity * price;
  }
  const full = computeInFlightOrderNotional(order.requestType, order.payload);
  return ordered > 0 ? (full * quantity) / ordered : full;
}

/**
 * The order request each action produced, keyed by action id, with how much of it has filled: option contracts
 * for an open, a roll (its new leg) or a buyback, shares for a share sale. Actions without an order are absent.
 */
export async function loadPlutoOrderRequestsByActionId(actionIds: string[], connection: Knex = db): Promise<Map<string, PlutoActionOrderRequest>> {
  if (actionIds.length === 0) return new Map();
  const rows: { pluto_action_id: string; kind: string; request_type: string; payload: OrderRequestPayload }[] = await connection("order_requests as orq")
    .join("pluto_actions as pa", "pa.id", "orq.pluto_action_id")
    .whereIn("orq.pluto_action_id", actionIds)
    .select("orq.pluto_action_id", "pa.kind", "orq.request_type", "orq.payload");
  const fills: { pluto_action_id: string; leg_type: string; is_closing_trade: boolean; quantity: string }[] = await connection("order_requests as orq")
    .join("trades as tr", "tr.source_order_request_id", "orq.id")
    .join("position_legs as pl", "pl.id", "tr.position_leg_id")
    .whereIn("orq.pluto_action_id", actionIds)
    .groupBy("orq.pluto_action_id", "pl.leg_type", "tr.is_closing_trade")
    .select("orq.pluto_action_id", "pl.leg_type", "tr.is_closing_trade")
    .sum("tr.quantity as quantity");
  const filledQuantity = new Map<string, number>();
  const kindByAction = new Map(rows.map((row) => [row.pluto_action_id, row.kind]));
  for (const fill of fills) {
    const kind = kindByAction.get(fill.pluto_action_id);
    const counts = kind === "close_shares" ? fill.leg_type === "stock" && fill.is_closing_trade : kind === "close_leg" ? fill.leg_type === "option" && fill.is_closing_trade : fill.leg_type === "option" && !fill.is_closing_trade;
    if (counts) filledQuantity.set(fill.pluto_action_id, (filledQuantity.get(fill.pluto_action_id) ?? 0) + Number(fill.quantity));
  }
  return new Map(rows.map((row) => [row.pluto_action_id, { requestType: row.request_type, payload: row.payload, filledQuantity: filledQuantity.get(row.pluto_action_id) ?? null }]));
}
