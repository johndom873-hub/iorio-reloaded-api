import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { computeInFlightOrderNotional } from "../lib/orderLimits.js";

// EXP $ per Pluto order, the way Positions counts exposure (mockup approved 2026-10-06): an open or a roll adds
// what the order gate counts for it (orderLimits.computeInFlightOrderNotional); a close releases exposure, shown
// negative — a put buyback frees strike × 100 per contract, selling shares frees shares × price; buying back a
// call frees nothing (the shares stay). Nothing is shown for an action that never became an order.

export interface PlutoActionExposureInput {
  kind: string;
  contract: Record<string, unknown> | null;
  quantity: number | null;
  limitPrice: number | null;
  fillPrice: number | null;
}

export interface PlutoActionOrderRequest {
  requestType: string;
  payload: OrderRequestPayload;
}

export function computePlutoActionExposure(action: PlutoActionExposureInput, order: PlutoActionOrderRequest | null): number | null {
  if (order === null) return null;
  const quantity = action.quantity ?? 0;
  if (action.kind === "close_leg") {
    const strike = Number(action.contract?.strike ?? 0);
    return action.contract?.right === "P" && strike > 0 ? -strike * 100 * quantity : 0;
  }
  if (action.kind === "close_shares") {
    const price = action.fillPrice ?? action.limitPrice ?? 0;
    return -quantity * price;
  }
  return computeInFlightOrderNotional(order.requestType, order.payload);
}

/** The order request each action produced, keyed by action id; actions without one are absent. */
export async function loadPlutoOrderRequestsByActionId(actionIds: string[], connection: Knex = db): Promise<Map<string, PlutoActionOrderRequest>> {
  if (actionIds.length === 0) return new Map();
  const rows: { pluto_action_id: string; request_type: string; payload: OrderRequestPayload }[] = await connection("order_requests").whereIn("pluto_action_id", actionIds).select("pluto_action_id", "request_type", "payload");
  return new Map(rows.map((row) => [row.pluto_action_id, { requestType: row.request_type, payload: row.payload }]));
}
