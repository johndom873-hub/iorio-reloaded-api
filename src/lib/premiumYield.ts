import { commissionPerContractDollars, sharesPerContract } from "./optionFriction.js";

// The Volatility screen's Call yield (approved by Marcelo 2026-10-27), the same formula as the app's chain and order
// form (iorio-reloaded-app src/lib/payoff.ts computeAnnualizedYield for a covered call):
//
//   friction per contract = λ × (ask − bid) ÷ 2 × 100 + $0.68
//   yield a year          = (mid − friction ÷ 100) ÷ (spot − mid) × 365 ÷ max(DTE, 1)
//
// λ = the Risk & Limits spread cost share; DTE = calendar days to expiry, a same-day expiry counted as 1 day.
// Example: spot $142.10, $143 Call bid 4.10 / ask 4.30, 10 DTE, λ 50%: friction $5.68,
// (4.20 − 0.0568) ÷ (142.10 − 4.20) × 365 ÷ 10 = 110%.

export interface CallYieldInput {
  bid: number;
  ask: number;
  spotPrice: number;
  daysToExpiry: number;
  /** λ, 0..1. */
  spreadShareCharged: number;
}

/** The yield a year after costs as a fraction (1.10 = 110%); null when the quote or the exposure cannot support one. */
export function coveredCallYieldAfterCosts(input: CallYieldInput): number | null {
  const { bid, ask, spotPrice, daysToExpiry, spreadShareCharged } = input;
  if (!(bid > 0) || !(ask >= bid) || !(spotPrice > 0)) return null;
  const mid = (bid + ask) / 2;
  const exposurePerShare = spotPrice - mid;
  if (!(exposurePerShare > 0)) return null;
  const frictionDollarsPerContract = spreadShareCharged * ((ask - bid) / 2) * sharesPerContract + commissionPerContractDollars;
  return ((mid - frictionDollarsPerContract / sharesPerContract) / exposurePerShare) * (365 / Math.max(daysToExpiry, 1));
}
