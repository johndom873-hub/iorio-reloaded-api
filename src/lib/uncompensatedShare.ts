import { standardNormalCdf } from "./blackScholesPop.js";

// UncompensatedShare for the IORIO Signal Engine (approved 2026-09-22; a separate
// display column, never blended into the rank score).
//
// The share of a covered call's P&L variance that comes from delta drift, i.e. the
// accidental, unpaid directional-timing bet (Israelov & Nielsen, "Covered Calls
// Uncovered", Financial Analysts Journal 71(6), 2015). Each simulated day the option
// leg's change dC is split, exactly, into:
//
//   equity  = (1 − Δ₀) · dS              static exposure at entry
//   timing  = −(Δ_{t−1} − Δ₀) · dS       delta drift since entry (the uncompensated bet)
//   vol     = −(dC − Δ_{t−1} · dS)       gamma/theta: the short-volatility leg
//
// so that (dS − dC) = equity + timing + vol on every path, and the reported shares
// are Cov(component, total) / Var(total), which sum to 1. A cash-secured put is the same
// number by put-call parity (short put + cash ≈ covered call at the same strike), so one
// function serves both strategies.
//
// Paths are geometric Brownian motion with volatility σ = the SVI-fitted implied
// volatility at the strike (approved), zero drift and zero rate (an implementation
// detail: over ≤ 90 days it moves the shares by well under a point), one step per
// calendar day to expiry (yearsToExpiry throughout this codebase is calendar-day based,
// see yearsBetweenIsoDates -- steps must use the same 365-day convention or a short-dated
// option rounds to a single step, which is structurally always 0% timing share), antithetic
// pairs, and a fixed seed so the same inputs always give the same answer. Sanity-checked
// against the paper: an ATM monthly call at 16% volatility gives ≈ 25% timing (paper: ≈ 25%),
// and against an independent Python simulation.

export const simulationPathCount = 4000; // even, for antithetic pairs
export const simulationSeed = 20_260_922;
const calendarDaysPerYear = 365;
const minimumTotalVarianceFraction = 1e-10;

/** mulberry32: a small, well-behaved seeded generator. */
function createRandomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function callPriceAndDelta(spot: number, strike: number, yearsToExpiry: number, volatility: number): { price: number; delta: number } {
  if (yearsToExpiry <= 1e-12) return { price: Math.max(spot - strike, 0), delta: spot > strike ? 1 : 0 };
  const totalStandardDeviation = volatility * Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(spot / strike) + 0.5 * totalStandardDeviation * totalStandardDeviation) / totalStandardDeviation;
  const d2 = d1 - totalStandardDeviation;
  return { price: spot * standardNormalCdf(d1) - strike * standardNormalCdf(d2), delta: standardNormalCdf(d1) };
}

export interface UncompensatedShareInput {
  spotPrice: number;
  strike: number;
  yearsToExpiry: number;
  /** SVI-fitted implied volatility at the strike (annualized decimal). */
  volatility: number;
}

export interface RiskShares {
  /** Share of P&L variance from delta drift: the uncompensated directional-timing bet. */
  timingShare: number;
  equityShare: number;
  volatilityShare: number;
  /** Call delta at entry. */
  entryDelta: number;
}

export interface UncompensatedShareOptions {
  pathCount?: number;
  seed?: number;
}

/** Null for unusable inputs, or when the position has essentially no variance to apportion (e.g. a deep in-the-money call). */
export function computeUncompensatedShare(input: UncompensatedShareInput, options: UncompensatedShareOptions = {}): RiskShares | null {
  const { spotPrice, strike, yearsToExpiry, volatility } = input;
  if (![spotPrice, strike, yearsToExpiry, volatility].every((value) => Number.isFinite(value) && value > 0)) return null;
  const pathCount = options.pathCount ?? simulationPathCount;

  const steps = Math.max(1, Math.round(yearsToExpiry * calendarDaysPerYear));
  const dt = yearsToExpiry / steps;
  const drift = -0.5 * volatility * volatility * dt;
  const diffusion = volatility * Math.sqrt(dt);
  const entry = callPriceAndDelta(spotPrice, strike, yearsToExpiry, volatility);
  const entryDelta = entry.delta;
  const random = createRandomGenerator(options.seed ?? simulationSeed);

  const equity: number[] = [];
  const timing: number[] = [];
  const total: number[] = [];
  const draws = new Array<number>(steps);
  for (let pair = 0; pair < pathCount / 2; pair++) {
    for (let step = 0; step < steps; step++) draws[step] = Math.sqrt(-2 * Math.log(random() + 1e-300)) * Math.cos(2 * Math.PI * random());
    for (const sign of [1, -1]) {
      let spot = spotPrice;
      let equityPnl = 0;
      let timingPnl = 0;
      let totalPnl = 0;
      let before = entry;
      for (let step = 0; step < steps; step++) {
        const nextSpot = spot * Math.exp(drift + diffusion * sign * draws[step]!);
        const spotChange = nextSpot - spot;
        const after = callPriceAndDelta(nextSpot, strike, yearsToExpiry - (step + 1) * dt, volatility);
        equityPnl += (1 - entryDelta) * spotChange;
        timingPnl += -(before.delta - entryDelta) * spotChange;
        totalPnl += spotChange - (after.price - before.price);
        spot = nextSpot;
        before = after;
      }
      equity.push(equityPnl);
      timing.push(timingPnl);
      total.push(totalPnl);
    }
  }

  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const covariance = (first: number[], second: number[]) => {
    const firstMean = mean(first);
    const secondMean = mean(second);
    return first.reduce((sum, value, index) => sum + (value - firstMean) * (second[index]! - secondMean), 0) / first.length;
  };
  const totalVariance = covariance(total, total);
  if (!(totalVariance > minimumTotalVarianceFraction * spotPrice * spotPrice)) return null;
  const equityShare = covariance(equity, total) / totalVariance;
  const timingShare = covariance(timing, total) / totalVariance;
  return { timingShare, equityShare, volatilityShare: 1 - equityShare - timingShare, entryDelta };
}
