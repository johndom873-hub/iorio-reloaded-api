// Black-Scholes-based "probability of profit" for a short option — proposed
// 2026-08-30 in the "P/L Split & Roll Intelligence" plan, pending a
// week-long manual comparison against IBKR's own TWS-displayed POP (no API
// field exists for that number, so it can't be automated — see
// docs/pop-validation-instructions.html handed to Juan). Not yet
// "approved" in the same sense as the yield formula below it in
// PROGRESS.md; wired into trade-alert candidates now specifically so
// there's a live number to compare against during that validation.
//
// Uses the breakeven price (strike adjusted by premium collected), not the
// raw strike -- this is "probability of profit" (accounts for the credit
// received), not "probability of expiring OTM" (a different, more
// pessimistic number some platforms show instead). Risk-free rate assumed
// 0: every candidate here is single-digit-to-low-double-digit DTE, where a
// realistic ~4-5% annual rate moves d2 by a negligible amount -- not worth
// the complexity of threading a rate through every caller.

// Abramowitz & Stegun 7.1.26 approximation of the error function, accurate
// to ~1.5e-7 -- standard-normal CDF then follows directly from erf.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export interface ProbabilityOfProfitInput {
  spotPrice: number;
  strike: number;
  premium: number;
  impliedVolatility: number;
  daysToExpiry: number;
  right: "call" | "put";
}

/**
 * Probability the short option finishes at or beyond its breakeven price
 * (i.e. the position is profitable at expiration, ignoring early
 * assignment/close). Null when an input is missing or non-physical
 * (zero/negative IV, spot, or time, or a put breakeven that's gone
 * negative under an unrealistically large premium).
 */
export function computeProbabilityOfProfit(input: ProbabilityOfProfitInput): number | null {
  const { spotPrice, strike, premium, impliedVolatility, daysToExpiry, right } = input;
  if (spotPrice <= 0 || strike <= 0 || impliedVolatility <= 0 || daysToExpiry <= 0) return null;

  const breakeven = right === "call" ? strike + premium : strike - premium;
  if (breakeven <= 0) return null;

  const t = daysToExpiry / 365;
  const d2 = (Math.log(spotPrice / breakeven) - 0.5 * impliedVolatility * impliedVolatility * t) / (impliedVolatility * Math.sqrt(t));

  // Short call profits if S_T < breakeven: P(S_T < breakeven) = N(-d2).
  // Short put profits if S_T > breakeven: P(S_T > breakeven) = N(d2).
  return right === "call" ? standardNormalCdf(-d2) : standardNormalCdf(d2);
}
