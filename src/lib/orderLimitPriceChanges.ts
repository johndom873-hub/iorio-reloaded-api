// Following the mid (Marcelo 2026-11-07): a working single-leg option order's limit is changed to the price the strategy
// would send now, instead of resting at a price the market has left. The route (POST /positions/orders/:id/reprice) records
// the request on the order's payload, the worker changes the order at IBKR (the same IBKR order, so it is not a new order
// under any cap), and the order's payload keeps every change.

/**
 * Whether Pluto follows the mid in this environment (Marcelo 2026-11-09): off on production until it has run against
 * IBKR on staging's paper account and the review's findings are fixed; a working order keeps the price it was sent at.
 */
export function followTheMidIsOn(environment: "development" | "staging" | "production"): boolean {
  return environment !== "production";
}

/** How often Pluto re-reads the live quote of a working order it follows. */
export const followTheMidCheckIntervalSeconds = 30;

/**
 * At most this many limit changes per order (Marcelo 2026-11-09: 20, about 10 of an order's 15 minutes at one change per
 * check): IBKR scores each account's daily (orders + changes + cancels) / (fills + 1), above 20 excessive.
 */
export const maxLimitPriceChangesPerOrder = 20;

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

/**
 * Whether an IBKR error is one only a limit change can cause: 104 (a filled order cannot be modified), 105 (the change
 * does not match the order), 2102 (still being processed, in IBKR's informational range), or a refusal whose text says the
 * order cannot be replaced or modified (201 "too late to replace").
 */
export function isLimitChangeRefusalError(code: number, message: string): boolean {
  return code === 104 || code === 105 || code === 2102 || /too late to (replace|modify)|unable to modify|can(no|')t (be )?modif/i.test(message);
}
