import { limitPriceChangeRefusalWindowSeconds } from "../lib/orderLimitPriceChanges.js";

// The worker's memory of the limit changes it sent (follow the mid, lib/orderLimitPriceChanges.ts), by IBKR order id:
// an IBKR error on one of those orders inside the refusal window is that change refused, not the order failing, however
// many errors IBKR sends (handleOrderErrorEvent); a later error that only a change can cause (isLimitChangeRefusalError)
// on an order changed since the Gateway connected is a refusal too. In memory on purpose: a restart forgets them, and the
// stale-order reconciliation then reads each changed order's limit back from IBKR (syncFollowedOrderLimitsWithIbkr).

export interface RecentLimitPriceChange {
  orderRequestId: string;
  from: number;
  to: number;
  sentAtMs: number;
}

export class RecentLimitPriceChanges {
  private readonly byIbkrOrderId = new Map<number, RecentLimitPriceChange>();
  /** Every order changed since the Gateway connected, by IBKR order id (ids are only unique within one connection). */
  private readonly changedSinceConnect = new Map<number, string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  remember(ibkrOrderId: number, change: Omit<RecentLimitPriceChange, "sentAtMs">): void {
    const nowMs = this.now();
    for (const [orderId, earlier] of this.byIbkrOrderId) if (nowMs - earlier.sentAtMs > limitPriceChangeRefusalWindowSeconds * 1000) this.byIbkrOrderId.delete(orderId);
    this.byIbkrOrderId.set(ibkrOrderId, { ...change, sentAtMs: nowMs });
    this.changedSinceConnect.set(ibkrOrderId, change.orderRequestId);
  }

  /** The change sent on this order inside the refusal window, kept for every error the window holds; null when there is none. */
  withinRefusalWindow(ibkrOrderId: number): RecentLimitPriceChange | null {
    const change = this.byIbkrOrderId.get(ibkrOrderId);
    if (!change) return null;
    return this.now() - change.sentAtMs <= limitPriceChangeRefusalWindowSeconds * 1000 ? change : null;
  }

  /** The order request whose limit was changed since the Gateway connected, or null. */
  changedOrderRequestId(ibkrOrderId: number): string | null {
    return this.changedSinceConnect.get(ibkrOrderId) ?? null;
  }

  /** Drops a change sent but never confirmed, e.g. when sending it threw. */
  forget(ibkrOrderId: number): void {
    this.byIbkrOrderId.delete(ibkrOrderId);
  }

  /** A new Gateway connection: its order ids are new, so nothing remembered applies to them. */
  clear(): void {
    this.byIbkrOrderId.clear();
    this.changedSinceConnect.clear();
  }
}
