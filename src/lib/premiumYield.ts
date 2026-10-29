import { commissionPerContractDollars, frictionDollarsPerContract, sharesPerContract } from "./optionFriction.js";
import { tradingSessionsPerYear } from "./tradingSessionsHeld.js";

// The Volatility screen's Call yield (approved by Marcelo 2026-10-27), the same formula as the app's chain and order
// form (iorio-reloaded-app src/lib/payoff.ts computeAnnualizedYield for a covered call):
//
//   friction per contract = λ × (ask − bid) ÷ 2 × 100 + $0.68
//   yield a year          = (mid − friction ÷ 100) ÷ (spot − mid) × 252 ÷ sessions held
//
// λ = the Risk & Limits spread cost share; sessions held = the trading sessions from the one an order fills in to the
// expiry's, both counted in full (tradingSessionsHeld.ts, Marcelo 2026-10-29). Example: spot $142.10, $143 Call bid
// 4.10 / ask 4.30 sold on a Monday for the Friday after next (10 sessions), λ 50%: friction $5.68,
// (4.20 − 0.0568) ÷ (142.10 − 4.20) × 252 ÷ 10 = 75.7%.

export interface CallYieldInput {
  bid: number;
  ask: number;
  spotPrice: number;
  sessionsHeld: number;
  /** λ, 0..1. */
  spreadShareCharged: number;
}

/** The yield a year after costs as a fraction (0.757 = 75.7%); null when the quote or the exposure cannot support one. */
export function coveredCallYieldAfterCosts(input: CallYieldInput): number | null {
  const { bid, ask, spotPrice, sessionsHeld, spreadShareCharged } = input;
  if (!(bid > 0) || !(ask >= bid) || !(spotPrice > 0)) return null;
  const mid = (bid + ask) / 2;
  const exposurePerShare = spotPrice - mid;
  if (!(exposurePerShare > 0)) return null;
  const friction = frictionDollarsPerContract(bid, ask, spreadShareCharged, commissionPerContractDollars);
  return ((mid - friction / sharesPerContract) / exposurePerShare) * (tradingSessionsPerYear / Math.max(sessionsHeld, 1));
}
