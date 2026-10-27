// Option trading costs. A sale is charged λ × the half-spread × 100 plus the commission per contract
// (frictionDollarsPerContract): the premium yields, the backtests and the valuation model all use it.
//
// λ = the Risk & Limits spread cost, default 0.5 (Marcelo 2026-10-05). Orders go out as limits at the mid, which never
// fill worse than the mid, but a fill tends to come once the price has moved toward the limit, up to half a spread below
// the fair price at that moment: λ is the expected share of that half-spread. c = the estimated commission per contract
// (commissionEstimate.ts, trailing fills by side and size); the flat $0.68 below, the mean of the first 94 option trades
// stored in `trades`, is the fallback.

export const commissionPerContractDollars = 0.68;
export const sharesPerContract = 100;

export function frictionDollarsPerContract(bid: number, ask: number, spreadShareCharged: number, commissionPerContract: number): number {
  return (spreadShareCharged * (ask - bid)) / 2 * 100 + commissionPerContract;
}

const standardNormalDensity = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** dPrice/dSigma for an option on the forward, per share and per 1.00 of volatility. */
export function blackScholesVega(forward: number, strike: number, yearsToExpiry: number, riskFreeRate: number, volatility: number): number {
  const totalStandardDeviation = volatility * Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(forward / strike) + 0.5 * totalStandardDeviation * totalStandardDeviation) / totalStandardDeviation;
  return Math.exp(-riskFreeRate * yearsToExpiry) * forward * standardNormalDensity(d1) * Math.sqrt(yearsToExpiry);
}
