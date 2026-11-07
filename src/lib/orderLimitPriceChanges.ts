// Following the mid (Marcelo 2026-11-07): a working single-leg option order's limit is changed to the price the strategy
// would send now, instead of resting at a price the market has left. The route (POST /positions/orders/:id/reprice) records
// the request on the order's payload, the worker changes the order at IBKR (the same IBKR order, so it is not a new order
// under any cap), and the order's payload keeps every change.

/** How often Pluto re-reads the live quote of a working order it follows. */
export const followTheMidCheckIntervalSeconds = 30;

/** At most this many limit changes per order: IBKR watches each account's ratio of orders, changes and cancels to fills. */
export const maxLimitPriceChangesPerOrder = 10;

/**
 * IBKR answers a refused change with an error keyed by the order id. For this long after the worker sends a change, an
 * error on that order is the change refused (the order keeps working at its previous limit), never the order failing.
 */
export const limitPriceChangeRefusalWindowSeconds = 15;

/** A change asked for and not yet sent to IBKR. */
export interface LimitPriceChangeRequest {
  limitPrice: number;
  requestedAt: string;
}

/** A change sent to IBKR: `refused` holds IBKR's reason when it refused it (the order then kept `from`). */
export interface LimitPriceChange {
  at: string;
  from: number;
  to: number;
  refused?: string;
}

/** A limit price IBKR accepts for a US option: positive, on the cent (a third decimal is refused, error 110). */
export function isOptionLimitPriceOnTheCent(price: unknown): price is number {
  return typeof price === "number" && Number.isFinite(price) && price > 0 && Math.abs(price * 100 - Math.round(price * 100)) < 1e-6;
}
