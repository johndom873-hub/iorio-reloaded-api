// Black-Scholes probabilities for the Positions screen (computeSuccessProbability).

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
 * Uses the strike/cost-basis threshold, not a premium-adjusted breakeven.
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
