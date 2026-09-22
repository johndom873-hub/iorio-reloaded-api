import { blackScholesDelta, sviTotalVariance, type RawSviParameters, type SviSliceStatus } from "./impliedVolatilitySurface.js";
import { blackScholesVega, computeFrictionCost, computeNetEdge } from "./optionFriction.js";
import { computeUncompensatedShare, type UncompensatedShareOptions } from "./uncompensatedShare.js";
import { expirySpansEarnings, type RealizedVolatilityForecast } from "./volatilityEdge.js";

// Signals screen: turns one ticker's fitted surface (one row per expiry, from
// option_surface_fits) + that day's raw quotes into graded, tradable candidates.
// Approved 2026-09-22 (mockup): STRUCTURAL filters only (OTM side, two-sided
// quote, >=1 day to expiry, a slice with status 'ok') — nothing about delta,
// DTE window, spread or open interest narrows the list; those show up as
// columns/flags instead. Delta and the surface-vs-mid IV comparison are both
// computed here (not read from IBKR's own tick-13 delta/IV), so every
// candidate has a number even where IBKR's own computation tick never arrived
// (~17% of contracts, see PROGRESS.md).

export type SignalStrategyKey = "covered_call" | "cash_secured_put";
export type SignalGrade = "strong" | "good" | "marginal" | "avoid";
export type SignalFlag = "spans_earnings" | "outside_fitted_range" | "wide_spread" | "no_shares" | "insufficient_cash";

export const wideSpreadThreshold = 0.5; // matches the surface fit's own quote filter
const annualDays = 365;

export interface SignalSurfaceSlice {
  expiry: string; // ISO date
  status: SviSliceStatus;
  parameters: RawSviParameters | null;
  kMin: number | null;
  kMax: number | null;
  yearsToExpiry: number;
  forwardPrice: number;
}

export type SignalQuoteSource = "live" | "snapshot";

export interface SignalQuote {
  expiry: string; // ISO date, matches a slice's expiry
  strike: number;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
  /** Where bid/ask came from: the 10:00 capture (default) or a live IBKR subscription (Signals modal). */
  source?: SignalQuoteSource;
}

export interface SignalCandidatesInput {
  spotPrice: number;
  riskFreeRate: number;
  forecast: RealizedVolatilityForecast | null;
  slices: SignalSurfaceSlice[];
  quotes: SignalQuote[];
  earningsDatesIso: string[];
  snapshotDateIso: string;
  /** Free (uncovered) shares available for a covered call. */
  freeShares: number;
  /** Free cash available to secure a put. */
  freeCash: number;
}

export interface SignalCandidate {
  strategyKey: SignalStrategyKey;
  expiry: string;
  strike: number;
  dte: number;
  delta: number;
  bid: number;
  ask: number;
  spreadPercent: number;
  surfaceImpliedVolatility: number;
  midImpliedVolatility: number | null;
  forecastVolatility: number;
  edge: number;
  frictionVolatility: number;
  netEdge: number;
  /** net Edge x vega x 100 (Marcelo approved 2026-09-22). */
  edgeDollars: number;
  vega: number;
  /** Best case for an Adaptive order that fills at the mid: only the commission is conceded. */
  netEdgeAtMid: number;
  edgeDollarsAtMid: number;
  annualizedYield: number;
  uncompensatedSharePercent: number | null;
  quoteSource: SignalQuoteSource;
  flags: SignalFlag[];
  executable: boolean;
  grade: SignalGrade; // filled in by gradeSignalCandidates; "avoid" until then
}

function impliedVolatilityFromMid(forward: number, strike: number, yearsToExpiry: number, riskFreeRate: number, bid: number, ask: number, isCall: boolean): number | null {
  // Local bisection, independent of the surface fitter's own inversion helper (same maths, kept
  // separate so a change to the fitter's tolerance can't silently move what the Signals screen shows).
  const mid = (bid + ask) / 2;
  let low = 0.01;
  let high = 5;
  const price = (vol: number) => {
    const sd = vol * Math.sqrt(yearsToExpiry);
    const d1 = (Math.log(forward / strike) + 0.5 * sd * sd) / sd;
    const d2 = d1 - sd;
    const discount = Math.exp(-riskFreeRate * yearsToExpiry);
    return discount * (isCall ? forward * cdf(d1) - strike * cdf(d2) : strike * cdf(-d2) - forward * cdf(-d1));
  };
  if (mid <= price(low) || mid >= price(high)) return null;
  for (let i = 0; i < 60; i++) {
    const mv = (low + high) / 2;
    if (price(mv) > mid) high = mv;
    else low = mv;
  }
  return (low + high) / 2;
}
function cdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * y);
}

/** Builds every structurally-eligible candidate for a ticker. Ungraded (grade is a placeholder "avoid" until gradeSignalCandidates runs). */
export function buildSignalCandidates(input: SignalCandidatesInput): SignalCandidate[] {
  const slicesByExpiry = new Map(input.slices.map((slice) => [slice.expiry, slice]));
  const candidates: SignalCandidate[] = [];

  for (const quote of input.quotes) {
    const slice = slicesByExpiry.get(quote.expiry);
    if (!slice || slice.status !== "ok" || !slice.parameters || slice.kMin === null || slice.kMax === null) continue;
    if (!(slice.yearsToExpiry > 0)) continue; // expiring today: excluded, same as the surface fitter -- also caught downstream by computeFrictionCost's vega guard, kept explicit for clarity

    const isCall = quote.right === "C";
    if (isCall !== quote.strike >= slice.forwardPrice) continue; // OTM side only
    if (quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask > quote.bid)) continue; // two-sided quote

    const logMoneyness = Math.log(quote.strike / slice.forwardPrice);
    const totalVariance = sviTotalVariance(slice.parameters, logMoneyness);
    if (!(totalVariance > 0)) continue;
    const surfaceIv = Math.sqrt(totalVariance / slice.yearsToExpiry);
    const midIv = impliedVolatilityFromMid(slice.forwardPrice, quote.strike, slice.yearsToExpiry, input.riskFreeRate, quote.bid, quote.ask, isCall);
    const delta = blackScholesDelta(slice.forwardPrice, quote.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv, isCall);
    const friction = computeFrictionCost({ bid: quote.bid, ask: quote.ask, forward: slice.forwardPrice, strike: quote.strike, yearsToExpiry: slice.yearsToExpiry, riskFreeRate: input.riskFreeRate, impliedVolatility: surfaceIv });
    if (!friction) continue;
    const edge = input.forecast ? surfaceIv - input.forecast.volatility : null;
    const netEdge = edge === null ? null : computeNetEdge({ impliedVolatility: surfaceIv, forecastVolatility: input.forecast!.volatility, forecastWindowDays: input.forecast!.windowDays, edge, insideFittedRange: true }, friction);
    if (netEdge === null) continue; // no forecast: unscored, not shown as a candidate at all (caller shows the ticker as "Unscored")
    const vega = blackScholesVega(slice.forwardPrice, quote.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv);
    const edgeDollars = netEdge * vega * 100;
    const netEdgeAtMid = edge! - friction.commissionVolatility;
    const edgeDollarsAtMid = netEdgeAtMid * vega * 100;

    const strategyKey: SignalStrategyKey = isCall ? "covered_call" : "cash_secured_put";
    const dte = Math.round(slice.yearsToExpiry * annualDays);
    const premium = (quote.bid + quote.ask) / 2;
    const capitalAtRisk = strategyKey === "covered_call" ? input.spotPrice : quote.strike;
    const annualizedYield = (premium / capitalAtRisk) * (annualDays / dte);
    const spreadPercent = ((quote.ask - quote.bid) / premium) * 100;
    const insideRange = logMoneyness >= slice.kMin && logMoneyness <= slice.kMax;
    const flags: SignalFlag[] = [];
    if (expirySpansEarnings(input.snapshotDateIso, quote.expiry, input.earningsDatesIso)) flags.push("spans_earnings");
    if (!insideRange) flags.push("outside_fitted_range");
    if (spreadPercent / 100 > wideSpreadThreshold) flags.push("wide_spread");
    if (strategyKey === "covered_call" && input.freeShares < 100) flags.push("no_shares");
    if (strategyKey === "cash_secured_put" && input.freeCash < quote.strike * 100) flags.push("insufficient_cash");
    const executable = !flags.includes("no_shares") && !flags.includes("insufficient_cash");

    candidates.push({
      strategyKey,
      expiry: quote.expiry,
      strike: quote.strike,
      dte,
      delta,
      bid: quote.bid,
      ask: quote.ask,
      spreadPercent,
      surfaceImpliedVolatility: surfaceIv,
      midImpliedVolatility: midIv,
      forecastVolatility: input.forecast!.volatility,
      edge: edge!,
      frictionVolatility: friction.frictionVolatility,
      netEdge,
      edgeDollars,
      vega,
      netEdgeAtMid,
      edgeDollarsAtMid,
      annualizedYield,
      uncompensatedSharePercent: null,
      quoteSource: quote.source ?? "snapshot",
      flags,
      executable,
      grade: "avoid",
    });
  }
  return candidates;
}

// UncompensatedShare is a Monte Carlo (~3 ms per candidate on the dyno at 1000 paths, 4x that at the
// default 4000), so it is NOT part of buildSignalCandidates: the Signals screen never needs it (only
// the modal shows it), and live re-scoring runs on every spot tick. Decided with Marcelo 2026-09-22
// after a laptop-vs-Basic-dyno benchmark: attach it only for the open modal's ticker, refreshed at
// most every 5 s and only after a >= 0.5% spot move, in a worker thread.
export const liveUncompensatedSharePathCount = 1000;
export const uncompensatedShareRefreshIntervalMs = 5_000;
export const uncompensatedShareRefreshSpotMoveFraction = 0.005;

export interface UncompensatedShareAttachInput {
  spotPrice: number;
  slices: SignalSurfaceSlice[];
}

/** Returns new candidate objects with uncompensatedSharePercent filled in (null where the slice is missing or the simulation degenerates). */
export function attachUncompensatedShare(candidates: SignalCandidate[], input: UncompensatedShareAttachInput, options: UncompensatedShareOptions = {}): SignalCandidate[] {
  const yearsByExpiry = new Map(input.slices.map((slice) => [slice.expiry, slice.yearsToExpiry]));
  return candidates.map((candidate) => {
    const yearsToExpiry = yearsByExpiry.get(candidate.expiry);
    if (yearsToExpiry === undefined) return { ...candidate, uncompensatedSharePercent: null };
    const shares = computeUncompensatedShare({ spotPrice: input.spotPrice, strike: candidate.strike, yearsToExpiry, volatility: candidate.surfaceImpliedVolatility }, options);
    return { ...candidate, uncompensatedSharePercent: shares ? shares.timingShare * 100 : null };
  });
}

// Grade cut points (approved 2026-09-22): top 10% of net Edge = strong, next 20% = good, next 30% = marginal,
// the rest = avoid; net Edge <= 0 is always avoid regardless of rank.
const strongQuantile = 0.9;
const goodQuantile = 0.7;
const marginalQuantile = 0.4;

/** Assigns a grade to every candidate, in place conceptually (returns a new array), from the ticker's own net-Edge distribution. */
export function gradeSignalCandidates(candidates: SignalCandidate[]): SignalCandidate[] {
  if (candidates.length === 0) return candidates;
  const sortedNetEdges = candidates.map((candidate) => candidate.netEdge).sort((a, b) => a - b);
  const quantile = (probability: number) => sortedNetEdges[Math.min(sortedNetEdges.length - 1, Math.floor(probability * sortedNetEdges.length))]!;
  const strongCut = quantile(strongQuantile);
  const goodCut = quantile(goodQuantile);
  const marginalCut = quantile(marginalQuantile);

  return candidates.map((candidate) => {
    let grade: SignalGrade;
    if (candidate.netEdge <= 0) grade = "avoid";
    else if (candidate.netEdge >= strongCut) grade = "strong";
    else if (candidate.netEdge >= goodCut) grade = "good";
    else if (candidate.netEdge >= marginalCut) grade = "marginal";
    else grade = "avoid";
    return { ...candidate, grade };
  });
}

/** The candidate the Signals screen shows as a ticker's headline: highest Edge $, ties broken by net Edge. */
export function pickBestCandidate(candidates: SignalCandidate[]): SignalCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.edgeDollars - a.edgeDollars || b.netEdge - a.netEdge)[0]!;
}
