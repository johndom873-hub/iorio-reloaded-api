import { EventName } from "@stoqey/ib";
import type { IBApi, Order, OrderState } from "@stoqey/ib";

export interface IbkrCompletedOrder {
  /** IBKR's session-independent order id — the only key safe to match order_requests on (see ibkr_perm_id). */
  permId: number | undefined;
  /** "Filled", "Cancelled", "ApiCancelled", "Inactive", ... — orderState.status as IBKR reports it. */
  status: string;
}

const completedOrdersTimeoutMs = 15_000;

/**
 * Pulls the orders IBKR has already completed in the current Gateway session
 * via reqCompletedOrders(apiOnly=false) — the counterpart of
 * fetchIbkrOpenOrders for reconcileStaleOrderRequests (ibkrGatewayWorker.ts):
 * an order_requests row still "submitted" locally but absent from the open
 * orders may simply have filled or been cancelled while the worker was down,
 * and this says which, instead of guessing "error".
 *
 * Same reject-on-timeout shape as fetchIbkrOpenOrders: a stalled
 * completedOrdersEnd must not read as "nothing completed".
 */
export function fetchIbkrCompletedOrders(ib: IBApi): Promise<IbkrCompletedOrder[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const rows: IbkrCompletedOrder[] = [];

    function cleanup() {
      clearTimeout(timer);
      ib.off(EventName.completedOrder, onCompletedOrder);
      ib.off(EventName.completedOrdersEnd, onEnd);
    }

    const onCompletedOrder = (_contract: unknown, order: Order, orderState: OrderState) => {
      rows.push({ permId: order.permId, status: String(orderState.status ?? "") });
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(rows);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("reqCompletedOrders timed out waiting for completedOrdersEnd."));
    }, completedOrdersTimeoutMs);

    ib.on(EventName.completedOrder, onCompletedOrder);
    ib.once(EventName.completedOrdersEnd, onEnd);
    ib.reqCompletedOrders(false);
  });
}
