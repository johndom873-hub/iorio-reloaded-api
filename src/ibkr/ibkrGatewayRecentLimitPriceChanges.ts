import { limitPriceChangeRefusalWindowSeconds } from "../lib/orderLimitPriceChanges.js";

// The worker's memory of the limit changes it just sent (follow the mid, lib/orderLimitPriceChanges.ts), by IBKR order id:
// an IBKR error on one of those orders inside the refusal window is that change refused, not the order failing
// (handleOrderErrorEvent). In memory on purpose: a restart forgets them, and an error after a restart is read as before.

export interface RecentLimitPriceChange {
  orderRequestId: string;
  from: number;
  to: number;
  sentAtMs: number;
}

export class RecentLimitPriceChanges {
  private readonly byIbkrOrderId = new Map<number, RecentLimitPriceChange>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  remember(ibkrOrderId: number, change: Omit<RecentLimitPriceChange, "sentAtMs">): void {
    const nowMs = this.now();
    for (const [orderId, earlier] of this.byIbkrOrderId) if (nowMs - earlier.sentAtMs > limitPriceChangeRefusalWindowSeconds * 1000) this.byIbkrOrderId.delete(orderId);
    this.byIbkrOrderId.set(ibkrOrderId, { ...change, sentAtMs: nowMs });
  }

  /** The change sent on this order inside the refusal window, forgotten as it is taken; null when there is none. */
  take(ibkrOrderId: number): RecentLimitPriceChange | null {
    const change = this.byIbkrOrderId.get(ibkrOrderId);
    if (!change) return null;
    this.byIbkrOrderId.delete(ibkrOrderId);
    return this.now() - change.sentAtMs <= limitPriceChangeRefusalWindowSeconds * 1000 ? change : null;
  }

  /** Drops a change sent but never confirmed, e.g. when sending it threw. */
  forget(ibkrOrderId: number): void {
    this.byIbkrOrderId.delete(ibkrOrderId);
  }
}
