import type { VolatilityEdge } from "./volatilityEdge.js";

// Friction cost for the IORIO Signal Engine (approved 2026-09-22):
//
//   FrictionCost(K,T) = [ λ · (ask − bid)/2 + c/100 ] / Vega(K,T)
//   Vega = e^(−rT) · F · φ(d1) · √T          (price per share per 1.00 of volatility)
//   NetEdge = Edge − FrictionCost
//
// Expressed in the same annualized-volatility units as Edge, so 0.05 = 5 volatility
// points of edge given up to trade this contract. Entry cost only (sold and held to
// expiry); closing early and rolling carry their own costs, handled in the roll logic.
//
// λ = 1.0 (Marcelo's choice, against the 0.5 recommendation): the whole half-spread
// is charged, i.e. a fill at the bid. c = $0.68 per contract, the mean of the 94 option
// trades stored in `trades` (0.07 volatility points in the typical alert region).
// Measured on the real AAOI chain, 21 Sep 2026, the half-spread alone is ~5 volatility
// points for |delta| 0.15–0.30 at 20–60 days.

export const spreadShareCharged = 1.0;
export const commissionPerContractDollars = 0.68;
export const sharesPerContract = 100;

const standardNormalDensity = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** dPrice/dSigma for an option on the forward, per share and per 1.00 of volatility. */
export function blackScholesVega(forward: number, strike: number, yearsToExpiry: number, riskFreeRate: number, volatility: number): number {
  const totalStandardDeviation = volatility * Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(forward / strike) + 0.5 * totalStandardDeviation * totalStandardDeviation) / totalStandardDeviation;
  return Math.exp(-riskFreeRate * yearsToExpiry) * forward * standardNormalDensity(d1) * Math.sqrt(yearsToExpiry);
}

export interface FrictionInput {
  bid: number | null;
  ask: number | null;
  forward: number;
  strike: number;
  yearsToExpiry: number;
  riskFreeRate: number;
  /** Fitted implied volatility at the strike (annualized decimal). */
  impliedVolatility: number;
}

export interface FrictionCost {
  /** Total friction in annualized volatility (0.05 = 5 volatility points). */
  frictionVolatility: number;
  spreadVolatility: number;
  commissionVolatility: number;
}

/** Null when the contract has no two-sided quote (bid > 0, ask > bid) or the inputs are not usable: it cannot be traded at a known cost. */
export function computeFrictionCost(input: FrictionInput): FrictionCost | null {
  const { bid, ask } = input;
  if (bid === null || ask === null || !(bid > 0) || !(ask > bid)) return null;
  if (!(input.forward > 0) || !(input.strike > 0) || !(input.yearsToExpiry > 0) || !(input.impliedVolatility > 0)) return null;
  const vega = blackScholesVega(input.forward, input.strike, input.yearsToExpiry, input.riskFreeRate, input.impliedVolatility);
  if (!(vega > 0) || !Number.isFinite(vega)) return null;
  const spreadVolatility = (spreadShareCharged * (ask - bid)) / 2 / vega;
  const commissionVolatility = commissionPerContractDollars / sharesPerContract / vega;
  return { frictionVolatility: spreadVolatility + commissionVolatility, spreadVolatility, commissionVolatility };
}

/** NetEdge = Edge − FrictionCost, in annualized volatility. */
export function computeNetEdge(edge: VolatilityEdge, friction: FrictionCost): number {
  return edge.edge - friction.frictionVolatility;
}
