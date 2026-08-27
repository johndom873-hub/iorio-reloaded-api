import { EventName } from "@stoqey/ib";
import type { IBApi, Order } from "@stoqey/ib";

export interface IbkrOpenOrder {
  orderId: number;
  permId: number | undefined;
}

const openOrdersTimeoutMs = 15_000;

/**
 * Pulls IBKR's actual currently-open orders via reqAllOpenOrders() — used at
 * worker startup to reconcile away order_requests rows left stuck
 * non-terminal (submitted/confirmed) by a prior Gateway session that IBKR
 * itself no longer knows about. Left alone, a stuck row's ibkr_order_id can
 * later collide with a genuinely different order once a new session's order
 * id counter wraps back around to the same number (see
 * reconcileStaleOrderRequests in ibkrGatewayWorker.ts).
 *
 * Same reject-on-timeout shape as fetchIbkrHeldPositions — an empty/partial
 * result from a stalled openOrderEnd would otherwise read as "IBKR has no
 * open orders" and incorrectly flag every genuinely-still-open local row.
 */
export function fetchIbkrOpenOrders(ib: IBApi): Promise<IbkrOpenOrder[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const rows: IbkrOpenOrder[] = [];

    function cleanup() {
      clearTimeout(timer);
      ib.off(EventName.openOrder, onOpenOrder);
      ib.off(EventName.openOrderEnd, onEnd);
    }

    const onOpenOrder = (orderId: number, _contract: unknown, order: Order) => {
      rows.push({ orderId, permId: order.permId });
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
      reject(new Error("reqAllOpenOrders timed out waiting for openOrderEnd."));
    }, openOrdersTimeoutMs);

    ib.on(EventName.openOrder, onOpenOrder);
    ib.once(EventName.openOrderEnd, onEnd);
    ib.reqAllOpenOrders();
  });
}
