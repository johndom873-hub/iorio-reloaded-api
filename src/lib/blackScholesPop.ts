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
// pessimistic number some platforms show instead). Uses the same FRED
// risk-free rate as computeSuccessProbability below (approved 2026-09-24 so
// the two probabilities share one convention; the rate moves the result by
// under one percentage point at 45 DTE). No rate available -> null, never a
// silent 0%.

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

export function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export interface ProbabilityOfProfitInput {
  spotPrice: number;
  strike: number;
  premium: number;
  impliedVolatility: number;
  daysToExpiry: number;
  right: "call" | "put";
  /** Annual risk-free rate as a decimal (0.04 = 4%); null when none is available. */
  riskFreeRate: number | null;
}

/**
 * Probability the short option finishes at or beyond its breakeven price
 * (i.e. the position is profitable at expiration, ignoring early
 * assignment/close). Null when an input is missing or non-physical
 * (zero/negative IV, spot, or time, or a put breakeven that's gone
 * negative under an unrealistically large premium).
 */
export function computeProbabilityOfProfit(input: ProbabilityOfProfitInput): number | null {
  const { spotPrice, strike, premium, impliedVolatility, daysToExpiry, right, riskFreeRate } = input;
  if (riskFreeRate === null || !Number.isFinite(riskFreeRate)) return null;
  if (spotPrice <= 0 || strike <= 0 || impliedVolatility <= 0 || daysToExpiry <= 0) return null;

  const breakeven = right === "call" ? strike + premium : strike - premium;
  if (breakeven <= 0) return null;

  const t = daysToExpiry / 365;
  const d2 = (Math.log(spotPrice / breakeven) + (riskFreeRate - 0.5 * impliedVolatility * impliedVolatility) * t) / (impliedVolatility * Math.sqrt(t));

  // Short call profits if S_T < breakeven: P(S_T < breakeven) = N(-d2).
  // Short put profits if S_T > breakeven: P(S_T > breakeven) = N(d2).
  return right === "call" ? standardNormalCdf(-d2) : standardNormalCdf(d2);
}

export interface SuccessProbabilityInput {
  spotPrice: number;
  /** Threshold the stock must finish above: the strike (CSP) or max(strike, cost basis) (CC). */
  thresholdPrice: number;
  impliedVolatility: number;
  daysToExpiry: number;
  /** Annual risk-free rate as a decimal (0.04 = 4%). */
  riskFreeRate: number;
}

/**
 * Approved 2026-09-19 for the Positions "P(d2)" column: N(d2), the
 * probability the stock finishes ABOVE thresholdPrice at expiry. That is
 * "success" for both strategies — a cash-secured put is not assigned, and a
 * covered call is assigned (at a profit when the threshold is cost basis).
 * Unlike computeProbabilityOfProfit above, this uses a real risk-free rate
 * and the strike/cost-basis threshold, not the premium-adjusted breakeven.
 * Null when an input is missing or non-physical.
 */
export function computeSuccessProbability(input: SuccessProbabilityInput): number | null {
  const { spotPrice, thresholdPrice, impliedVolatility, daysToExpiry, riskFreeRate } = input;
  if (spotPrice <= 0 || thresholdPrice <= 0 || impliedVolatility <= 0 || daysToExpiry <= 0) return null;
  const t = daysToExpiry / 365;
  const d2 =
    (Math.log(spotPrice / thresholdPrice) + (riskFreeRate - 0.5 * impliedVolatility * impliedVolatility) * t) /
    (impliedVolatility * Math.sqrt(t));
  return standardNormalCdf(d2);
}
