import { exactInputCachesAreEnabled } from "./exactInputCaches.js";
import { RecentEntriesCache } from "./recentEntriesCache.js";
import { tradingSessionsPerYear } from "./tradingSessionsHeld.js";
import { calibratedEdgeMargin, standardizedReturnBucketsFor, type ValuationGroup, type VolatilityModelTables } from "./volatilityModelTables.js";

// One contract's value to a seller (model review P2, P4, P5, approved by Marcelo 2026-10-10;
// docs/signal-engine-model-review/REPORT.md). Every figure comes from ONE distribution of the price at expiry, so they
// cannot contradict each other:
//
//   s   = √(forecast per-session variance × τ)                    τ = variance sessions from the quote to the expiry close
//   S_i = F · e^{s·z_i} ÷ mean_j e^{s·z_j}                         z_i = the group's standardized-return buckets (fat tails),
//                                                                  normalized so the mean is the forward (no drift view)
//   fair price      = e^{−rT} · mean_i payoff(S_i)                 T = calendar years (money accrues on calendar days)
//   seller P&L_i    = (mid − e^{−rT} · payoff(S_i)) × 100 − friction          per contract, held to expiry
//   expected P&L    = mean_i P&L_i  (the new Edge $)
//   edge margin     = 1 − fair ÷ mid                                (before friction; the grade and the calibration use it)
//   calibrated P&L  = calibrated margin(edge margin, τ) × mid × 100 − friction   (what history delivered, ATM proxy)
//   Edge Yield      = expected P&L ÷ capital at risk × 252 ÷ N      (a yearly rate on trading sessions, as every yield on
//                                                                  the platform, Marcelo 2026-10-29: N = the sessions from
//                                                                  the quote's to the expiry's, both in full,
//                                                                  tradingSessionsHeld.ts; capital = EXP $, net of the
//                                                                  premium (Marcelo 2026-10-12): (strike − mid)×100 for a
//                                                                  put, the cash reserved less the premium; (spot − mid)×100
//                                                                  for a call, the shares bought less the premium)
//   Hist Yield      = calibrated P&L ÷ capital at risk × 252 ÷ N
//   risk outcome_i  = P&L_i for a put; for a call, the shares and the call together (Marcelo 2026-10-10: the strategy holds
//                     shares only with the call, so a covered call is judged like a cash-secured put, the same payoff):
//                     P&L_i + (S_i − F) × 100, the shares' move from the forward (zero on average, so Edge $ is unchanged)
//   PoP = share of risk outcomes > 0; average win / loss; 5% expected shortfall = mean of the worst 5% of risk outcomes
//   (25 of the 500); 2σ stress = the risk outcome at S = F·e^{−2s} (the stock down two standard deviations by expiry).
//   premium after costs = mid × 100 − friction, and its premium yield on capital × 252 ÷ N (the sale's own income; a
//   covered call's shares can add the rise to the strike on top of it).
// The variance clock (τ) values the contract, calendar time (T) discounts it, and the sessions held (N) annualize what
// the capital earns.
// Grades on the edge margin (approved 2026-10-12): strong ≥ 20%, good ≥ 10%, weak ≥ 0%, else avoid (a negative margin).

/** The valuation model's grade of a contract, from its edge margin. */
export type ValuationGrade = "strong" | "good" | "weak" | "avoid";

export const gradeMarginCutPoints = { strong: 0.2, good: 0.1, weak: 0 } as const;
export const expectedShortfallTailShare = 0.05;
export const stressStandardDeviations = 2;

/** A per-contract dollar amount as a yearly rate on the contract's exposure over the trading sessions it is held, at least one (a yield; tradingSessionsHeld.ts). */
export function yieldOnExposure(dollars: number, exposureDollars: number, sessionsHeld: number): number {
  return (dollars / exposureDollars) * (tradingSessionsPerYear / Math.max(sessionsHeld, 1));
}

/** The edge margins the grades start at, as fractions. */
export interface GradeMarginCutPoints {
  strong: number;
  good: number;
  weak: number;
}

/** `cutPoints`: live always gradeMarginCutPoints; a backtest session may grade with its own. */
export function gradeForEdgeMargin(edgeMargin: number, cutPoints: GradeMarginCutPoints = gradeMarginCutPoints): ValuationGrade {
  if (edgeMargin >= cutPoints.strong) return "strong";
  if (edgeMargin >= cutPoints.good) return "good";
  if (edgeMargin >= cutPoints.weak) return "weak";
  return "avoid";
}

export interface ContractValuationInput {
  isCall: boolean;
  strike: number;
  /** The forward at the quote's moment. */
  forward: number;
  /** Bid/ask mid per share. */
  mid: number;
  /** Friction charged per contract: λ × half-spread × 100 + commission. */
  frictionDollars: number;
  /** Forecast per-session variance (YZ21). */
  perSessionVariance: number;
  /** τ: variance sessions from the quote to the expiry close. */
  varianceSessions: number;
  /** Calendar years to expiry, for discounting only. */
  calendarYears: number;
  /** The trading sessions from the quote's to the expiry's, both in full (tradingSessionsHeld.ts): what the yields are annualized over. */
  sessionsHeld: number;
  riskFreeRate: number;
  group: ValuationGroup;
  /** Spot at the quote (a covered call's shares, and its capital at risk with the premium taken off). */
  spot: number;
}

export interface ContractValuation {
  /** Fair price per share under the forecast distribution. */
  fairPrice: number;
  /** 1 − fair ÷ mid, before friction. */
  edgeMargin: number;
  /** Per contract, after friction: the new Edge $. */
  expectedPnlDollars: number;
  calibratedEdgeMargin: number;
  calibratedExpectedPnlDollars: number;
  /** Edge Yield: expected P&L ÷ capital at risk, annualized over the sessions held (0.25 = 25% a year). */
  expectedAnnualizedReturn: number;
  calibratedAnnualizedReturn: number;
  probabilityOfProfit: number;
  averageWinDollars: number;
  /** Mean P&L of the losing outcomes (≤ 0); 0 when there are none. */
  averageLossDollars: number;
  /** Mean P&L of the worst 5% of outcomes. */
  expectedShortfallDollars: number;
  /** P&L after a 2σ move against the position by expiry. */
  stressPnlDollars: number;
  /** The premium kept after friction, per contract: a put's best case; a covered call's shares can add the rise to the strike. */
  premiumAfterCostsDollars: number;
  /** Premium after costs ÷ capital at risk, annualized over the sessions held. */
  premiumYield: number;
  /** Variance of the per-contract P&L of the option alone (dollars²). */
  pnlVarianceDollars: number;
  /** A call only: variance of the per-contract P&L of 100 shares plus the short call (the risk outcomes). */
  coveredPositionPnlVarianceDollars: number | null;
  capitalAtRiskDollars: number;
  /** Forecast volatility per session, annualized ×252 (the forecast's own units). */
  forecastVolatility: number;
  /** τ the contract was valued over. */
  varianceSessions: number;
  /** The trading sessions the yields are annualized over. */
  sessionsHeld: number;
  grade: ValuationGrade;
}

/**
 * S_i = F · e^{s·z_i} ÷ mean_j e^{s·z_j} for every bucket. The strikes of one expiry share s and F, and a quote set is
 * valued strike after strike, so the last result is kept and returned again for the same buckets, s and F.
 */
let lastPricesAtExpiry: { buckets: readonly number[]; totalStandardDeviation: number; forward: number; prices: readonly number[] } | null = null;

function pricesAtExpiry(buckets: readonly number[], totalStandardDeviation: number, forward: number): readonly number[] {
  if (lastPricesAtExpiry && lastPricesAtExpiry.buckets === buckets && lastPricesAtExpiry.totalStandardDeviation === totalStandardDeviation && lastPricesAtExpiry.forward === forward) return lastPricesAtExpiry.prices;
  const growth: number[] = new Array(buckets.length);
  let normalizer = 0;
  for (let index = 0; index < buckets.length; index++) {
    growth[index] = Math.exp(totalStandardDeviation * buckets[index]!);
    normalizer += growth[index]!;
  }
  normalizer /= buckets.length;
  const prices = growth.map((factor) => (forward * factor) / normalizer);
  lastPricesAtExpiry = { buckets, totalStandardDeviation, forward, prices };
  return prices;
}

/**
 * Valuations already made, by their exact inputs and tables: a quote that has not moved is valued again with the same
 * figures (the next look scored ahead, then for real). Each answer is handed out as a copy (its fields are all plain
 * values). About the latest day's worth are kept. Only where the exact-input caches are on (exactInputCaches.ts): live
 * quotes move with every tick.
 */
const valuationsByKey = new RecentEntriesCache<string, ContractValuation | null>(50_000);
const tablesIds = new WeakMap<VolatilityModelTables, number>();
let nextTablesId = 1;

export function valueContract(tables: VolatilityModelTables, input: ContractValuationInput): ContractValuation | null {
  if (!exactInputCachesAreEnabled()) return computeContractValuation(tables, input);
  let tablesId = tablesIds.get(tables);
  if (tablesId === undefined) tablesIds.set(tables, (tablesId = nextTablesId++));
  const valuations = valuationsByKey;
  const key = `${tablesId}|${input.isCall ? "C" : "P"}|${input.strike}|${input.forward}|${input.mid}|${input.frictionDollars}|${input.perSessionVariance}|${input.varianceSessions}|${input.calendarYears}|${input.sessionsHeld}|${input.riskFreeRate}|${input.group}|${input.spot}`;
  if (valuations.has(key)) {
    const valued = valuations.get(key)!;
    return valued === null ? null : { ...valued };
  }
  const valued = computeContractValuation(tables, input);
  valuations.set(key, valued);
  return valued === null ? null : { ...valued };
}

function computeContractValuation(tables: VolatilityModelTables, input: ContractValuationInput): ContractValuation | null {
  if (!(input.mid > 0) || !(input.mid < (input.isCall ? input.spot : input.strike)) || !(input.forward > 0) || !(input.strike > 0) || !(input.perSessionVariance > 0) || !(input.varianceSessions > 0) || !(input.spot > 0)) return null;
  const buckets = standardizedReturnBucketsFor(tables, input.group, input.varianceSessions);
  const totalStandardDeviation = Math.sqrt(input.perSessionVariance * input.varianceSessions);
  const prices = pricesAtExpiry(buckets, totalStandardDeviation, input.forward);
  const discount = Math.exp(-input.riskFreeRate * Math.max(0, input.calendarYears));
  const payoffAt = (price: number) => (input.isCall ? Math.max(price - input.strike, 0) : Math.max(input.strike - price, 0));
  const premiumDollars = input.mid * 100;

  const pnl: number[] = new Array(buckets.length);
  // The outcomes risk is judged on: the option alone for a put; shares + call for a call.
  const riskPnl: number[] = new Array(buckets.length);
  let payoffSum = 0;
  for (let index = 0; index < buckets.length; index++) {
    const price = prices[index]!;
    const payoff = payoffAt(price);
    payoffSum += payoff;
    pnl[index] = premiumDollars - input.frictionDollars - discount * payoff * 100;
    riskPnl[index] = input.isCall ? pnl[index]! + (price - input.forward) * 100 : pnl[index]!;
  }
  const fairPrice = (discount * payoffSum) / buckets.length;
  const expectedPnlDollars = pnl.reduce((sum, value) => sum + value, 0) / pnl.length;
  const variance = (values: number[]) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  };
  const wins = riskPnl.filter((value) => value > 0);
  const losses = riskPnl.filter((value) => value <= 0);
  // A numeric typed-array sort orders as (a, b) => a − b does, but for where it puts −0 and +0, which no sum from 0
  // can tell apart; with a NaN (which that comparator leaves unordered) the comparator sort is kept.
  const sorted = riskPnl.some(Number.isNaN) ? [...riskPnl].sort((a, b) => a - b) : Float64Array.from(riskPnl).sort();
  const tailLength = Math.min(sorted.length, Math.max(1, Math.round(sorted.length * expectedShortfallTailShare)));
  let tailSum = 0;
  for (let index = 0; index < tailLength; index++) tailSum += sorted[index]!;
  const stressPrice = input.forward * Math.exp(-stressStandardDeviations * totalStandardDeviation);
  const stressShareMove = input.isCall ? (stressPrice - input.forward) * 100 : 0;
  const capitalAtRiskDollars = ((input.isCall ? input.spot : input.strike) - input.mid) * 100;
  const annualize = (dollars: number) => yieldOnExposure(dollars, capitalAtRiskDollars, input.sessionsHeld);
  const edgeMargin = 1 - fairPrice / input.mid;
  const calibrated = calibratedEdgeMargin(tables, edgeMargin, input.varianceSessions);
  const calibratedExpectedPnlDollars = calibrated * premiumDollars - input.frictionDollars;
  const premiumAfterCostsDollars = premiumDollars - input.frictionDollars;

  return {
    fairPrice,
    edgeMargin,
    expectedPnlDollars,
    calibratedEdgeMargin: calibrated,
    calibratedExpectedPnlDollars,
    expectedAnnualizedReturn: annualize(expectedPnlDollars),
    calibratedAnnualizedReturn: annualize(calibratedExpectedPnlDollars),
    probabilityOfProfit: wins.length / riskPnl.length,
    averageWinDollars: wins.length > 0 ? wins.reduce((sum, value) => sum + value, 0) / wins.length : 0,
    averageLossDollars: losses.length > 0 ? losses.reduce((sum, value) => sum + value, 0) / losses.length : 0,
    expectedShortfallDollars: tailSum / tailLength,
    stressPnlDollars: premiumDollars - input.frictionDollars - discount * payoffAt(stressPrice) * 100 + stressShareMove,
    premiumAfterCostsDollars,
    premiumYield: annualize(premiumAfterCostsDollars),
    pnlVarianceDollars: variance(pnl),
    coveredPositionPnlVarianceDollars: input.isCall ? variance(riskPnl) : null,
    capitalAtRiskDollars,
    forecastVolatility: Math.sqrt(input.perSessionVariance * 252),
    varianceSessions: input.varianceSessions,
    sessionsHeld: input.sessionsHeld,
    grade: gradeForEdgeMargin(edgeMargin),
  };
}
