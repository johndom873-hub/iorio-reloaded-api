import { blackScholesDelta, impliedVolatilityFromPrice } from "./impliedVolatilitySurface.js";
import { easternMinutesOfDay } from "./easternIsoDate.js";

// A contract's delta from its own live quote (Marcelo 2026-10-15: one source for IV and delta, the quote's own, as the
// CC + Put Ladder's engine computes it): the IV of the mid, then Black-76 at that IV on the forward. Used where the
// surface gives no delta, e.g. a held leg on its expiry day (no slice is fitted for a same-day expiry).
//
//   forward = spot × e^{rT};  IV = implied volatility of the mid;  delta = Black-76 delta(forward, strike, T, r, IV)
//   T for a same-day expiry = hours from now to today's close ÷ 8,760 (the backtest's convention, approved 2026-10-15)
//
// A mid at or below the intrinsic value has no IV: in the money it counts as fully so (|delta| 1, the assignment case),
// out of the money as unknown.

/** Years from `now` to today's close at `closeMinutesEt` (minutes after midnight, Eastern), never below 0. */
export function yearsToSessionClose(now: Date, closeMinutesEt: number): number {
  return Math.max(0, closeMinutesEt - easternMinutesOfDay(now)) / 60 / 8760;
}

export function deltaFromQuoteMid(input: { bid: number | null; ask: number | null; spotPrice: number; strike: number; isCall: boolean; yearsToExpiry: number; riskFreeRate: number }): number | null {
  const { bid, ask, spotPrice, strike, isCall, yearsToExpiry, riskFreeRate } = input;
  if (bid === null || ask === null || !(bid > 0) || !(ask > bid) || !(spotPrice > 0)) return null;
  const intrinsic = isCall ? Math.max(spotPrice - strike, 0) : Math.max(strike - spotPrice, 0);
  if (!(yearsToExpiry > 0)) return intrinsic > 0 ? (isCall ? 1 : -1) : null;
  const forward = spotPrice * Math.exp(riskFreeRate * yearsToExpiry);
  const impliedVolatility = impliedVolatilityFromPrice((bid + ask) / 2, forward, strike, yearsToExpiry, riskFreeRate, isCall);
  if (impliedVolatility === null) return intrinsic > 0 ? (isCall ? 1 : -1) : null;
  return blackScholesDelta(forward, strike, yearsToExpiry, riskFreeRate, impliedVolatility, isCall);
}
