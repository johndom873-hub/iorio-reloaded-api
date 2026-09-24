import { blackScholesDelta, sviTotalVariance } from "./impliedVolatilitySurface.js";
import { blackScholesVega, computeFrictionCost } from "./optionFriction.js";
import { gradeForNetEdge, impliedVolatilityFromMid, type SignalCandidate, type SignalGrade, type SignalQuote, type SignalQuoteSource, type SignalStrategyKey, type SignalSurfaceSlice } from "./signalCandidates.js";
import type { RealizedVolatilityForecast } from "./volatilityEdge.js";

// Roll Signals (Formula 3j, approved 2026-09-24): an open short option leg
// is scored as a contract to KEEP, every new-trade candidate on the same
// ticker and right is scored as its replacement, and the roll is the
// difference:
//
//   netRollEdge  = netEdge(B) − edge(A) − friction(A)
//                = netEdge(B) − netEdge(A) − 2·friction(A)
//   netRollEdge$ = netEdge(B)·vega(B)·100 − (edge(A) + friction(A))·vega(A)·100   (per contract)
//
// The held leg is bought back at the ask, so its friction is a cost again,
// never a credit. The commission sits inside every friction term already
// (optionFriction.ts), so there is no separate commission line. Each dollar
// component is weighted by its own leg's vega. Grades reuse the Net Edge cut
// points. Hard filters (Marcelo): |delta(B)| ≤ |delta(A)| -- never roll into
// a riskier contract -- and a positive net credit at the mid. The old Trade
// Alerts triggers (50 % decay, 21 DTE, |delta| ≥ 0.5) survive as flags only.

const annualDays = 365;
export const nearExpiryDaysThreshold = 21;
export const assignmentRiskDeltaThreshold = 0.5;
export const decayedFractionOfEntryCredit = 0.5;

export type RollSignalFlag = "near_expiry" | "assignment_risk" | "decayed";
export type HeldLegUnscoredReason = "no_slice" | "no_quote" | "no_forecast";

/** An open short option leg as the inputs loader reads it from position_legs. */
export interface OpenShortLeg {
  legId: string;
  positionId: string;
  strategyKey: SignalStrategyKey;
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
  quantity: number;
  /** Credit collected per share when the leg was opened. */
  entryPrice: number;
  entryAtIso: string;
}

/** One open short leg scored as a contract to keep (Formula 3j's A side). */
export interface HeldLegScore extends OpenShortLeg {
  dte: number | null;
  delta: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  surfaceImpliedVolatility: number | null;
  midImpliedVolatility: number | null;
  /** Surface IV minus the forecast: what holding the leg still offers, in annualised volatility. */
  edge: number | null;
  /** Cost of buying the leg back (half-spread + commission over vega), in annualised volatility. */
  frictionVolatility: number | null;
  vega: number | null;
  /** edge × vega × 100: the per-contract dollar value of holding. */
  holdEdgeDollars: number | null;
  /** frictionVolatility × vega × 100: the per-contract dollar cost of closing. */
  closeCostDollars: number | null;
  /** Max theoretical loss per contract at the mid: strike×100 − mid (CSP) or spot×100 − mid (CC). */
  dollarRisk: number | null;
  quoteSource: SignalQuoteSource | null;
  quotedAt: string | null;
  flags: RollSignalFlag[];
  unscoredReason: HeldLegUnscoredReason | null;
}

export interface RollSignalCandidate {
  legId: string;
  positionId: string;
  strategyKey: SignalStrategyKey;
  quantity: number;
  replacement: SignalCandidate;
  /** Formula 3j, a fraction of annualised volatility (0.056 = 5.6 vp). */
  netRollEdge: number;
  /** Per contract: netEdge(B)·vega(B)·100 − (edge(A)+friction(A))·vega(A)·100. */
  netRollEdgeDollarsPerContract: number;
  /** netRollEdgeDollarsPerContract × quantity. */
  netRollEdgeDollars: number;
  /** mid(B) − mid(A), per share; always > 0 here (credit rolls only). */
  netCreditPerShare: number;
  /** |delta(B)| − |delta(A)|; never positive here (lower-delta filter). */
  deltaChange: number;
  /** dollarRisk(B) − dollarRisk(A), per contract. */
  dollarRiskChange: number;
  flags: RollSignalFlag[];
  grade: SignalGrade;
}

export interface HeldLegScoringInput {
  spotPrice: number;
  riskFreeRate: number;
  forecast: RealizedVolatilityForecast | null;
  slices: SignalSurfaceSlice[];
  /** Merged quotes (live > day > snapshot), including contracts the new-trade candidate build ignores (the ITM side). */
  quotes: SignalQuote[];
  ivShiftByExpiry?: Map<string, number>;
}

export function heldLegContractKey(leg: Pick<OpenShortLeg, "expiry" | "strike" | "right">): string {
  return `${leg.expiry}|${leg.strike}|${leg.right}`;
}

function unscored(leg: OpenShortLeg, reason: HeldLegUnscoredReason, partial: Partial<HeldLegScore> = {}): HeldLegScore {
  return {
    ...leg,
    dte: null,
    delta: null,
    bid: null,
    ask: null,
    mid: null,
    surfaceImpliedVolatility: null,
    midImpliedVolatility: null,
    edge: null,
    frictionVolatility: null,
    vega: null,
    holdEdgeDollars: null,
    closeCostDollars: null,
    dollarRisk: null,
    quoteSource: null,
    quotedAt: null,
    flags: [],
    ...partial,
    unscoredReason: reason,
  };
}

/** Scores every open short leg through the same surface, forecast and friction as a new-trade candidate; ITM legs included. */
export function scoreHeldLegs(legs: OpenShortLeg[], input: HeldLegScoringInput): HeldLegScore[] {
  const slicesByExpiry = new Map(input.slices.map((slice) => [slice.expiry, slice]));
  const quotesByKey = new Map(input.quotes.map((quote) => [`${quote.expiry}|${quote.strike}|${quote.right}`, quote]));
  return legs.map((leg) => {
    const slice = slicesByExpiry.get(leg.expiry);
    if (!slice || slice.status !== "ok" || !slice.parameters || !(slice.yearsToExpiry > 0)) return unscored(leg, "no_slice");
    const dte = Math.round(slice.yearsToExpiry * annualDays);
    const quote = quotesByKey.get(heldLegContractKey(leg));
    const flagsWithoutQuote: RollSignalFlag[] = dte <= nearExpiryDaysThreshold ? ["near_expiry"] : [];
    if (!quote || quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask > quote.bid)) return unscored(leg, "no_quote", { dte, flags: flagsWithoutQuote });
    if (!input.forecast) return unscored(leg, "no_forecast", { dte, bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2, flags: flagsWithoutQuote });

    const isCall = leg.right === "C";
    const logMoneyness = Math.log(leg.strike / slice.forwardPrice);
    const totalVariance = sviTotalVariance(slice.parameters, logMoneyness);
    if (!(totalVariance > 0)) return unscored(leg, "no_slice", { dte, flags: flagsWithoutQuote });
    const surfaceIv = Math.sqrt(totalVariance / slice.yearsToExpiry) + (input.ivShiftByExpiry?.get(leg.expiry) ?? 0);
    if (!(surfaceIv > 0)) return unscored(leg, "no_slice", { dte, flags: flagsWithoutQuote });
    const friction = computeFrictionCost({ bid: quote.bid, ask: quote.ask, forward: slice.forwardPrice, strike: leg.strike, yearsToExpiry: slice.yearsToExpiry, riskFreeRate: input.riskFreeRate, impliedVolatility: surfaceIv });
    if (!friction) return unscored(leg, "no_quote", { dte, flags: flagsWithoutQuote });

    const mid = (quote.bid + quote.ask) / 2;
    const delta = blackScholesDelta(slice.forwardPrice, leg.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv, isCall);
    const vega = blackScholesVega(slice.forwardPrice, leg.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv);
    const edge = surfaceIv - input.forecast.volatility;
    const flags: RollSignalFlag[] = [...flagsWithoutQuote];
    if (Math.abs(delta) >= assignmentRiskDeltaThreshold) flags.push("assignment_risk");
    if (leg.entryPrice > 0 && mid <= leg.entryPrice * decayedFractionOfEntryCredit) flags.push("decayed");
    const capitalAtRisk = leg.strategyKey === "covered_call" ? input.spotPrice : leg.strike;
    return {
      ...leg,
      dte,
      delta,
      bid: quote.bid,
      ask: quote.ask,
      mid,
      surfaceImpliedVolatility: surfaceIv,
      midImpliedVolatility: impliedVolatilityFromMid(slice.forwardPrice, leg.strike, slice.yearsToExpiry, input.riskFreeRate, quote.bid, quote.ask, isCall),
      edge,
      frictionVolatility: friction.frictionVolatility,
      vega,
      holdEdgeDollars: edge * vega * 100,
      closeCostDollars: friction.frictionVolatility * vega * 100,
      dollarRisk: capitalAtRisk * 100 - mid,
      quoteSource: quote.source ?? "snapshot",
      quotedAt: quote.quotedAt ?? null,
      flags,
      unscoredReason: null,
    };
  });
}

/** Every (held leg, replacement) pair passing the hard filters, graded and sorted by net roll Edge $ (then vol points). */
export function buildRollCandidates(heldLegs: HeldLegScore[], candidates: SignalCandidate[]): RollSignalCandidate[] {
  const rolls: RollSignalCandidate[] = [];
  for (const leg of heldLegs) {
    if (leg.unscoredReason !== null || leg.edge === null || leg.frictionVolatility === null || leg.vega === null || leg.delta === null || leg.mid === null || leg.dollarRisk === null) continue;
    const holdAndCloseVolatility = leg.edge + leg.frictionVolatility;
    const holdAndCloseDollars = holdAndCloseVolatility * leg.vega * 100;
    for (const replacement of candidates) {
      if (replacement.strategyKey !== leg.strategyKey) continue;
      if (replacement.expiry === leg.expiry && replacement.strike === leg.strike) continue;
      if (Math.abs(replacement.delta) > Math.abs(leg.delta)) continue; // never into a riskier contract
      const netCreditPerShare = (replacement.bid + replacement.ask) / 2 - leg.mid;
      if (!(netCreditPerShare > 0)) continue; // credit rolls only (debit "rescue" rolls are separate, deferred work)
      const netRollEdge = replacement.netEdge - holdAndCloseVolatility;
      const netRollEdgeDollarsPerContract = replacement.edgeDollars - holdAndCloseDollars;
      rolls.push({
        legId: leg.legId,
        positionId: leg.positionId,
        strategyKey: leg.strategyKey,
        quantity: leg.quantity,
        replacement,
        netRollEdge,
        netRollEdgeDollarsPerContract,
        netRollEdgeDollars: netRollEdgeDollarsPerContract * leg.quantity,
        netCreditPerShare,
        deltaChange: Math.abs(replacement.delta) - Math.abs(leg.delta),
        dollarRiskChange: replacement.dollarRisk - leg.dollarRisk,
        flags: leg.flags,
        grade: gradeForNetEdge(netRollEdge),
      });
    }
  }
  return rolls.sort((a, b) => b.netRollEdgeDollars - a.netRollEdgeDollars || b.netRollEdge - a.netRollEdge);
}

/** The roll the screen badge and the modal pre-select: highest net roll Edge $, ties by vol points. */
export function pickBestRoll(rolls: RollSignalCandidate[]): RollSignalCandidate | null {
  if (rolls.length === 0) return null;
  return [...rolls].sort((a, b) => b.netRollEdgeDollars - a.netRollEdgeDollars || b.netRollEdge - a.netRollEdge)[0]!;
}

export function rollCandidateKey(roll: Pick<RollSignalCandidate, "legId" | "replacement">): string {
  return `${roll.legId}|${roll.replacement.expiry}|${roll.replacement.strike}|${roll.replacement.strategyKey === "covered_call" ? "C" : "P"}`;
}
