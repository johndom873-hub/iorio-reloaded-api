import { db } from "../db/connection.js";
import { agentLeaseRefusal } from "../pluto/agentLease.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { limitChangeableOrderStatuses } from "./orderRequestStatuses.js";
import { fetchTradingHalt } from "./platformControls.js";
import { maxLimitPriceChangesPerOrder, type LimitPriceChangeRequest } from "./orderLimitPriceChanges.js";

const orderRequestsChannel = "order_requests_channel";

export type LimitPriceChangeRequestResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

/**
 * Asks for a working single-leg option order's limit to change (follow the mid, orderLimitPriceChanges.ts): records the
 * request on the payload and NOTIFYs the worker, which runs the live limit-price check and sends the same IBKR order again
 * at the new limit (changeSubmittedOrderLimit), or drops the change with its reason. Refused when the order is not working,
 * not a single option leg, already changed maxLimitPriceChangesPerOrder times, while trading is halted, and for a Pluto order
 * from anyone but the agent holding Pluto's lease (`agentHolder`). Used by POST /positions/orders/:id/reprice (Pluto) and the
 * web process's follower of manual orders (manualOrderFollowTheMid.ts).
 */
export async function requestOrderLimitPriceChange(orderRequestId: string, limitPrice: number, agentHolder: string | undefined): Promise<LimitPriceChangeRequestResult> {
  const orderRequest = await db("order_requests").where({ id: orderRequestId }).first();
  if (!orderRequest) return { ok: false, status: 404, error: "Order not found." };
  const payload = orderRequest.payload as OrderRequestPayload;
  const refusal = !(limitChangeableOrderStatuses as readonly string[]).includes(orderRequest.status)
    ? "Only an order working at IBKR can have its limit changed."
    : payload.legs.length !== 1 || payload.legs[0]!.role !== "option"
      ? "Only a single-leg option order can have its limit changed."
      : (payload.limitPriceChanges?.length ?? 0) >= maxLimitPriceChangesPerOrder
        ? `This order's limit has already been changed ${maxLimitPriceChangesPerOrder} times.`
        : (await fetchTradingHalt()).enabled
          ? "Trading is halted."
          : orderRequest.pluto_action_id
            ? await db.transaction((transaction) => agentLeaseRefusal(transaction, agentHolder))
            : null;
  if (refusal) return { ok: false, status: 409, error: refusal };
  const changeRequest: LimitPriceChangeRequest = { limitPrice, requestedAt: new Date().toISOString() };
  const updatedRows = await db("order_requests")
    .where({ id: orderRequest.id })
    .whereIn("status", limitChangeableOrderStatuses)
    .update({ payload: db.raw("jsonb_set(payload, '{limitPriceChangeRequest}', ?::jsonb)", [JSON.stringify(changeRequest)]), updated_at: db.fn.now() })
    .returning("id");
  if (updatedRows.length === 0) return { ok: false, status: 409, error: "Only an order working at IBKR can have its limit changed." };
  await db.raw("SELECT pg_notify(?, ?)", [orderRequestsChannel, orderRequest.id]);
  return { ok: true };
}
