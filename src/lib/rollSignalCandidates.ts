import { blackScholesDelta, sviTotalVariance } from "./impliedVolatilitySurface.js";
import { blackScholesVega, commissionPerContractDollars as flatCommissionPerContractDollars, computeFrictionCost } from "./optionFriction.js";
import { flatCommissionEstimator, type CommissionEstimator } from "./commissionEstimate.js";
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
/** What makes a roll fall outside the list's hard filters (a chain pick may still be ordered): a net debit at the mid, or a riskier (higher |delta|) contract. */
export type RollSignalWarning = "debit" | "higher_delta";
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
  /** mid(B) − mid(A), per share; positive unless the warnings say "debit". */
  netCreditPerShare: number;
  /** |delta(B)| − |delta(A)|; positive only with the "higher_delta" warning. */
  deltaChange: number;
  /** dollarRisk(B) − dollarRisk(A), per contract. */
  dollarRiskChange: number;
  flags: RollSignalFlag[];
  /** Always empty for the list (those are hard filters); set only for a roll to a contract the user picked on the chain. */
  warnings: RollSignalWarning[];
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
  /** Commission per contract for the buy-back, estimated for the leg's own size; flat $0.68 when omitted. */
  commissionEstimator?: CommissionEstimator;
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

/** The held leg's quote and what it implies without any surface: what a roll needs to price the close, so an unscored leg with a real quote still carries it. */
function heldLegQuoteFields(leg: OpenShortLeg, quote: { bid: number; ask: number; source?: SignalQuoteSource; quotedAt?: string }, spotPrice: number): { bid: number; ask: number; mid: number; dollarRisk: number; quoteSource: SignalQuoteSource; quotedAt: string | null } {
  const mid = (quote.bid + quote.ask) / 2;
  const capitalAtRisk = leg.strategyKey === "covered_call" ? spotPrice : leg.strike;
  return { bid: quote.bid, ask: quote.ask, mid, dollarRisk: capitalAtRisk * 100 - mid, quoteSource: quote.source ?? "snapshot", quotedAt: quote.quotedAt ?? null };
}

/** Scores every open short leg through the same surface, forecast and friction as a new-trade candidate; ITM legs included. An unscored leg with a two-sided quote keeps its bid, ask and mid (a roll can still be priced at the quotes). */
export function scoreHeldLegs(legs: OpenShortLeg[], input: HeldLegScoringInput): HeldLegScore[] {
  const slicesByExpiry = new Map(input.slices.map((slice) => [slice.expiry, slice]));
  const quotesByKey = new Map(input.quotes.map((quote) => [`${quote.expiry}|${quote.strike}|${quote.right}`, quote]));
  return legs.map((leg) => {
    const slice = slicesByExpiry.get(leg.expiry);
    const rawQuote = quotesByKey.get(heldLegContractKey(leg));
    const twoSidedQuote = rawQuote && rawQuote.bid !== null && rawQuote.ask !== null && rawQuote.bid > 0 && rawQuote.ask > rawQuote.bid ? { ...rawQuote, bid: rawQuote.bid, ask: rawQuote.ask } : null;
    const quoteFields = twoSidedQuote ? heldLegQuoteFields(leg, twoSidedQuote, input.spotPrice) : null;
    if (!slice || slice.status !== "ok" || !slice.parameters || !(slice.yearsToExpiry > 0)) return unscored(leg, "no_slice", { ...quoteFields });
    const dte = Math.round(slice.yearsToExpiry * annualDays);
    const flagsWithoutQuote: RollSignalFlag[] = dte <= nearExpiryDaysThreshold ? ["near_expiry"] : [];
    if (!twoSidedQuote || !quoteFields) return unscored(leg, "no_quote", { dte, flags: flagsWithoutQuote });
    if (!input.forecast) return unscored(leg, "no_forecast", { ...quoteFields, dte, flags: flagsWithoutQuote });

    const isCall = leg.right === "C";
    const logMoneyness = Math.log(leg.strike / slice.forwardPrice);
    const totalVariance = sviTotalVariance(slice.parameters, logMoneyness);
    if (!(totalVariance > 0)) return unscored(leg, "no_slice", { ...quoteFields, dte, flags: flagsWithoutQuote });
    const surfaceIv = Math.sqrt(totalVariance / slice.yearsToExpiry) + (input.ivShiftByExpiry?.get(leg.expiry) ?? 0);
    if (!(surfaceIv > 0)) return unscored(leg, "no_slice", { ...quoteFields, dte, flags: flagsWithoutQuote });
    const friction = computeFrictionCost({ bid: twoSidedQuote.bid, ask: twoSidedQuote.ask, forward: slice.forwardPrice, strike: leg.strike, yearsToExpiry: slice.yearsToExpiry, riskFreeRate: input.riskFreeRate, impliedVolatility: surfaceIv, commissionPerContractDollars: (input.commissionEstimator ?? flatCommissionEstimator).perContractDollars("buy", leg.quantity) });
    if (!friction) return unscored(leg, "no_quote", { dte, flags: flagsWithoutQuote });

    const delta = blackScholesDelta(slice.forwardPrice, leg.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv, isCall);
    const vega = blackScholesVega(slice.forwardPrice, leg.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv);
    const edge = surfaceIv - input.forecast.volatility;
    const flags: RollSignalFlag[] = [...flagsWithoutQuote];
    if (Math.abs(delta) >= assignmentRiskDeltaThreshold) flags.push("assignment_risk");
    if (leg.entryPrice > 0 && quoteFields.mid <= leg.entryPrice * decayedFractionOfEntryCredit) flags.push("decayed");
    return {
      ...leg,
      ...quoteFields,
      dte,
      delta,
      surfaceImpliedVolatility: surfaceIv,
      midImpliedVolatility: impliedVolatilityFromMid(slice.forwardPrice, leg.strike, slice.yearsToExpiry, input.riskFreeRate, twoSidedQuote.bid, twoSidedQuote.ask, isCall),
      edge,
      frictionVolatility: friction.frictionVolatility,
      vega,
      holdEdgeDollars: edge * vega * 100,
      closeCostDollars: friction.frictionVolatility * vega * 100,
      flags,
      unscoredReason: null,
    };
  });
}

/**
 * Formula 3j for one (held leg, replacement) pair, with no hard filters: the two the list applies come back as warnings
 * instead. Null when the pair cannot be scored (held leg unscored, other strategy, or the same contract).
 */
/**
 * The replacement as the roll will trade it (approved 2026-10-02): a candidate is scored at the size the setup form
 * defaults to, but a roll sells the held leg's whole quantity, so its commission term is re-estimated at that size.
 *   net Edge' = net Edge - (c_leg - c_scored) / 100 / vega     (c = estimated commission per contract)
 * Every field derived from the commission moves with it; a same-size roll comes back unchanged.
 */
export function recostReplacementCommission(replacement: SignalCandidate, contracts: number, estimator: CommissionEstimator): SignalCandidate {
  const scoredCommission = replacement.commissionPerContractDollars ?? flatCommissionPerContractDollars;
  const legCommission = estimator.perContractDollars("sell", contracts);
  const extraCommissionDollars = legCommission - scoredCommission; // per contract
  if (extraCommissionDollars === 0) return replacement;
  const extraCommissionVolatility = extraCommissionDollars / 100 / replacement.vega;
  const netEdge = replacement.netEdge - extraCommissionVolatility;
  const netEdgeAtMid = replacement.netEdgeAtMid - extraCommissionVolatility;
  const edgeDollars = replacement.edgeDollars - extraCommissionDollars;
  const edgeDollarsAtMid = replacement.edgeDollarsAtMid - extraCommissionDollars;
  return {
    ...replacement,
    commissionPerContractDollars: legCommission,
    frictionVolatility: replacement.frictionVolatility + extraCommissionVolatility,
    netEdge,
    netEdgeAtMid,
    edgeDollars,
    edgeDollarsAtMid,
    riskAdjustedRatio: edgeDollars / replacement.dollarRisk,
    riskAdjustedRatioAtMid: edgeDollarsAtMid / replacement.dollarRisk,
    grade: gradeForNetEdge(netEdge),
  };
}

export function scoreRollPair(leg: HeldLegScore, scoredReplacement: SignalCandidate, commissionEstimator: CommissionEstimator = flatCommissionEstimator): RollSignalCandidate | null {
  if (leg.unscoredReason !== null || leg.edge === null || leg.frictionVolatility === null || leg.vega === null || leg.delta === null || leg.mid === null || leg.dollarRisk === null) return null;
  if (scoredReplacement.strategyKey !== leg.strategyKey) return null;
  if (scoredReplacement.expiry === leg.expiry && scoredReplacement.strike === leg.strike) return null;
  const replacement = recostReplacementCommission(scoredReplacement, leg.quantity, commissionEstimator);
  const holdAndCloseVolatility = leg.edge + leg.frictionVolatility;
  const holdAndCloseDollars = holdAndCloseVolatility * leg.vega * 100;
  const netCreditPerShare = (replacement.bid + replacement.ask) / 2 - leg.mid;
  const netRollEdge = replacement.netEdge - holdAndCloseVolatility;
  const netRollEdgeDollarsPerContract = replacement.edgeDollars - holdAndCloseDollars;
  const warnings: RollSignalWarning[] = [];
  if (!(netCreditPerShare > 0)) warnings.push("debit"); // debit "rescue" rolls are not listed, only pickable on the chain
  if (Math.abs(replacement.delta) > Math.abs(leg.delta)) warnings.push("higher_delta");
  return {
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
    warnings,
    grade: gradeForNetEdge(netRollEdge),
  };
}

/** Every (held leg, replacement) pair passing the hard filters, graded and sorted by net roll Edge $ (then vol points). */
export function buildRollCandidates(heldLegs: HeldLegScore[], candidates: SignalCandidate[], commissionEstimator?: CommissionEstimator): RollSignalCandidate[] {
  const rolls: RollSignalCandidate[] = [];
  for (const leg of heldLegs) {
    for (const replacement of candidates) {
      const roll = scoreRollPair(leg, replacement, commissionEstimator);
      if (roll && roll.warnings.length === 0) rolls.push(roll);
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
