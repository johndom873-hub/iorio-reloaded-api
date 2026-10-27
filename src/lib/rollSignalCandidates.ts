import { blackScholesDelta, sviTotalVariance } from "./impliedVolatilitySurface.js";
import { blackScholesVega, commissionPerContractDollars as flatCommissionPerContractDollars } from "./optionFriction.js";
import { flatCommissionEstimator, type CommissionEstimator } from "./commissionEstimate.js";
import { frictionDollarsPerContract, impliedVolatilityFromMid, scoreContractWithModel, type CandidateModelContext, type CandidateModelScore, type SignalCandidate, type SignalGrade, type SignalQuote, type SignalQuoteSource, type SignalStrategyKey, type SignalSurfaceSlice } from "./signalCandidates.js";
import { gradeForEdgeMargin, yieldOnExposure } from "./contractValuation.js";

// Roll Signals: an open short option leg is valued as a contract to KEEP, every new-trade candidate on the same ticker
// and right as its replacement, and the roll is the difference, all on the valuation model (the 63-day net Edge's
// Formula 3j was retired 2026-10-20). Hard filters (Marcelo): |delta(B)| ≤ |delta(A)| -- never roll into a riskier
// contract -- and a positive net credit at the mid. The old Trade Alerts triggers (50 % decay, 21 DTE, |delta| ≥ 0.5)
// survive as flags only. A pair the model cannot value is not a roll.
//
// The valuation model's roll (model review P5, approved by Marcelo 2026-10-10; what Pluto acts on), per contract:
//   hold value A        = (mid(A) − fair(A)) × 100        what staying short still earns versus buying back at the mid
//   close cost A        = λ × half-spread(A) × 100 + buy commission
//   net roll expected $ = expected P&L(B) − hold value A − close cost A        (expected P&L(B) is after B's own friction)
//   roll edge margin    = ((mid(B) − fair(B)) × 100 − hold value A) ÷ (mid(B) × 100)   before friction, graded like an open

const annualDays = 365;
export const nearExpiryDaysThreshold = 21;
export const assignmentRiskDeltaThreshold = 0.5;
export const decayedFractionOfEntryCredit = 0.5;

export type RollSignalFlag = "near_expiry" | "assignment_risk" | "decayed";
/** What makes a roll fall outside the list's hard filters (a chain pick may still be ordered): a net debit at the mid, or a riskier (higher |delta|) contract. */
export type RollSignalWarning = "debit" | "higher_delta";
export type HeldLegUnscoredReason = "no_slice" | "no_quote" | "no_forecast";

import type { OpenShortLeg } from "./openShortLegs.js";
export type { OpenShortLeg };

/** One open short leg scored as a contract to keep: the roll's close side. */
export interface HeldLegScore extends OpenShortLeg {
  dte: number | null;
  delta: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  surfaceImpliedVolatility: number | null;
  midImpliedVolatility: number | null;
  /** Exposure per contract at the mid: (strike − mid) × 100 for a put, (spot − mid) × 100 for a covered call. */
  dollarRisk: number | null;
  quoteSource: SignalQuoteSource | null;
  quotedAt: string | null;
  flags: RollSignalFlag[];
  unscoredReason: HeldLegUnscoredReason | null;
  /** The valuation model's view of the held leg; null when it is unscored or the model cannot value it. */
  model: HeldLegModelScore | null;
}

export interface HeldLegModelScore {
  valuation: CandidateModelScore;
  /** (mid − fair) × 100 per contract: what holding still earns versus buying back at the mid (negative = the leg is now cheap to keep short no longer). */
  holdValueDollars: number;
  /** λ × half-spread × 100 + buy commission, per contract. */
  closeCostDollars: number;
}

export interface RollModelScore {
  netExpectedPnlPerContract: number;
  netExpectedPnl: number;
  edgeMargin: number;
  grade: SignalGrade;
}

export interface RollSignalCandidate {
  legId: string;
  positionId: string;
  strategyKey: SignalStrategyKey;
  quantity: number;
  replacement: SignalCandidate;
  /** mid(B) − mid(A), per share; positive unless the warnings say "debit". */
  netCreditPerShare: number;
  /** |delta(B)| − |delta(A)|; positive only with the "higher_delta" warning. */
  deltaChange: number;
  /** dollarRisk(B) − dollarRisk(A), per contract. */
  dollarRiskChange: number;
  flags: RollSignalFlag[];
  /** Always empty for the list (those are hard filters); set only for a roll to a contract the user picked on the chain. */
  warnings: RollSignalWarning[];
  /** The valuation model's roll: what is shown, ranked and acted on (a pair it cannot value is not a roll). */
  model: RollModelScore;
}

export interface HeldLegScoringInput {
  spotPrice: number;
  riskFreeRate: number;
  slices: SignalSurfaceSlice[];
  /** Merged quotes (live > day > snapshot), including contracts the new-trade candidate build ignores (the ITM side). */
  quotes: SignalQuote[];
  ivShiftByExpiry?: Map<string, number>;
  /** Commission per contract for the buy-back, estimated for the leg's own size; flat $0.68 when omitted. */
  commissionEstimator?: CommissionEstimator;
  /** λ (0..1): the share of the half-spread friction charges, from the Risk & Limits spread cost. */
  spreadShareCharged: number;
  /** The valuation model; absent or null leaves every held leg unscored ("no_forecast": no model forecast). */
  model?: CandidateModelContext | null;
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
    dollarRisk: null,
    quoteSource: null,
    quotedAt: null,
    flags: [],
    ...partial,
    unscoredReason: reason,
    model: null,
  };
}

/** The held leg's quote and what it implies without any surface: what a roll needs to price the close, so an unscored leg with a real quote still carries it. */
function heldLegQuoteFields(leg: OpenShortLeg, quote: { bid: number; ask: number; source?: SignalQuoteSource; quotedAt?: string }, spotPrice: number): { bid: number; ask: number; mid: number; dollarRisk: number; quoteSource: SignalQuoteSource; quotedAt: string | null } {
  const mid = (quote.bid + quote.ask) / 2;
  const exposurePerShare = (leg.strategyKey === "covered_call" ? spotPrice : leg.strike) - mid;
  return { bid: quote.bid, ask: quote.ask, mid, dollarRisk: exposurePerShare * 100, quoteSource: quote.source ?? "snapshot", quotedAt: quote.quotedAt ?? null };
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
    if (!input.model) return unscored(leg, "no_forecast", { ...quoteFields, dte, flags: flagsWithoutQuote });

    const isCall = leg.right === "C";
    const buyCommission = (input.commissionEstimator ?? flatCommissionEstimator).perContractDollars("buy", leg.quantity);
    const closeCostDollars = frictionDollarsPerContract(twoSidedQuote.bid, twoSidedQuote.ask, input.spreadShareCharged, buyCommission);
    const modelValuation = scoreContractWithModel(input.model, slice, twoSidedQuote, input.riskFreeRate, closeCostDollars);
    const model: HeldLegModelScore | null = modelValuation ? { valuation: modelValuation, holdValueDollars: (quoteFields.mid - modelValuation.fairPrice) * 100, closeCostDollars } : null;
    const logMoneyness = Math.log(leg.strike / slice.forwardPrice);
    const totalVariance = sviTotalVariance(slice.parameters, logMoneyness);
    if (!(totalVariance > 0)) return unscored(leg, "no_slice", { ...quoteFields, dte, flags: flagsWithoutQuote });
    const surfaceIv = Math.sqrt(totalVariance / slice.yearsToExpiry) + (input.ivShiftByExpiry?.get(leg.expiry) ?? 0);
    if (!(surfaceIv > 0)) return unscored(leg, "no_slice", { ...quoteFields, dte, flags: flagsWithoutQuote });
    // A leg with no sensitivity left to its volatility (vega 0) cannot be weighed: left unscored, as a new contract is excluded.
    const vega = blackScholesVega(slice.forwardPrice, leg.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv);
    if (!(vega > 0) || !Number.isFinite(vega)) return unscored(leg, "no_quote", { dte, flags: flagsWithoutQuote });

    const delta = blackScholesDelta(slice.forwardPrice, leg.strike, slice.yearsToExpiry, input.riskFreeRate, surfaceIv, isCall);
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
      flags,
      unscoredReason: null,
      model,
    };
  });
}

/**
 * The replacement as the roll will trade it (approved 2026-10-02): a candidate is scored at the size the setup form
 * defaults to, but a roll sells the held leg's whole quantity, so its commission is re-estimated at that size. Every model
 * figure derived from the commission moves with it; a same-size roll comes back unchanged.
 */
export function recostReplacementCommission(replacement: SignalCandidate, contracts: number, estimator: CommissionEstimator): SignalCandidate {
  const scoredCommission = replacement.commissionPerContractDollars ?? flatCommissionPerContractDollars;
  const legCommission = estimator.perContractDollars("sell", contracts);
  const extraCommissionDollars = legCommission - scoredCommission; // per contract
  if (extraCommissionDollars === 0) return replacement;
  const model = {
        ...replacement.model,
        expectedPnlDollars: replacement.model.expectedPnlDollars - extraCommissionDollars,
        calibratedExpectedPnlDollars: replacement.model.calibratedExpectedPnlDollars - extraCommissionDollars,
        premiumAfterCostsDollars: replacement.model.premiumAfterCostsDollars - extraCommissionDollars,
        expectedAnnualizedReturn: replacement.model.expectedAnnualizedReturn - annualizedPerContract(extraCommissionDollars, replacement.model),
        calibratedAnnualizedReturn: replacement.model.calibratedAnnualizedReturn - annualizedPerContract(extraCommissionDollars, replacement.model),
        premiumYield: replacement.model.premiumYield - annualizedPerContract(extraCommissionDollars, replacement.model),
        averageWinDollars: replacement.model.averageWinDollars - extraCommissionDollars,
        averageLossDollars: replacement.model.averageLossDollars - extraCommissionDollars,
        expectedShortfallDollars: replacement.model.expectedShortfallDollars - extraCommissionDollars,
        stressPnlDollars: replacement.model.stressPnlDollars - extraCommissionDollars,
      };
  return { ...replacement, commissionPerContractDollars: legCommission, model };
}

/** A per-contract dollar amount as a yearly rate on the contract's capital over its calendar time to expiry. */
function annualizedPerContract(dollars: number, model: Pick<CandidateModelScore, "capitalAtRiskDollars" | "calendarYears">): number {
  return yieldOnExposure(dollars, model.capitalAtRiskDollars, model.calendarYears);
}

/** The valuation model's roll for one pair; null unless both legs carry a model score. */
export function scoreRollModel(leg: Pick<HeldLegScore, "model" | "quantity">, replacement: Pick<SignalCandidate, "model" | "bid" | "ask">): RollModelScore | null {
  if (!leg.model || !replacement.model) return null;
  const replacementMid = (replacement.bid + replacement.ask) / 2;
  const netExpectedPnlPerContract = replacement.model.expectedPnlDollars - leg.model.holdValueDollars - leg.model.closeCostDollars;
  const edgeMargin = ((replacementMid - replacement.model.fairPrice) * 100 - leg.model.holdValueDollars) / (replacementMid * 100);
  return { netExpectedPnlPerContract, netExpectedPnl: netExpectedPnlPerContract * leg.quantity, edgeMargin, grade: gradeForEdgeMargin(edgeMargin) };
}

/**
 * One (held leg, replacement) pair valued by the model, with no hard filters: the two the list applies come back as
 * warnings instead. Null when the pair cannot be scored (held leg unscored or unvalued, other strategy, or the same contract).
 */
export function scoreRollPair(leg: HeldLegScore, scoredReplacement: SignalCandidate, commissionEstimator: CommissionEstimator = flatCommissionEstimator): RollSignalCandidate | null {
  if (leg.unscoredReason !== null || leg.model === null || leg.delta === null || leg.mid === null || leg.dollarRisk === null) return null;
  if (scoredReplacement.strategyKey !== leg.strategyKey) return null;
  if (scoredReplacement.expiry === leg.expiry && scoredReplacement.strike === leg.strike) return null;
  const replacement = recostReplacementCommission(scoredReplacement, leg.quantity, commissionEstimator);
  const model = scoreRollModel(leg, replacement);
  if (!model) return null;
  const netCreditPerShare = (replacement.bid + replacement.ask) / 2 - leg.mid;
  const warnings: RollSignalWarning[] = [];
  if (!(netCreditPerShare > 0)) warnings.push("debit"); // debit "rescue" rolls are not listed, only pickable on the chain
  if (Math.abs(replacement.delta) > Math.abs(leg.delta)) warnings.push("higher_delta");
  return {
    legId: leg.legId,
    positionId: leg.positionId,
    strategyKey: leg.strategyKey,
    quantity: leg.quantity,
    replacement,
    netCreditPerShare,
    deltaChange: Math.abs(replacement.delta) - Math.abs(leg.delta),
    dollarRiskChange: replacement.dollarRisk - leg.dollarRisk,
    flags: leg.flags,
    warnings,
    model,
  };
}

/** Rolls in the order Pluto acts on them (mockup approved 2026-10-10): the valuation model's net roll $ across the held quantity, highest first. */
export function compareRollsByModel(a: Pick<RollSignalCandidate, "model">, b: Pick<RollSignalCandidate, "model">): number {
  return b.model.netExpectedPnl - a.model.netExpectedPnl;
}

/** Every (held leg, replacement) pair passing the hard filters, graded and sorted by compareRollsByModel. */
export function buildRollCandidates(heldLegs: HeldLegScore[], candidates: SignalCandidate[], commissionEstimator?: CommissionEstimator): RollSignalCandidate[] {
  const rolls: RollSignalCandidate[] = [];
  for (const leg of heldLegs) {
    for (const replacement of candidates) {
      const roll = scoreRollPair(leg, replacement, commissionEstimator);
      if (roll && roll.warnings.length === 0) rolls.push(roll);
    }
  }
  return rolls.sort(compareRollsByModel);
}

/** The roll the screen badge and the modal pre-select: the first by compareRollsByModel. */
export function pickBestRoll(rolls: RollSignalCandidate[]): RollSignalCandidate | null {
  if (rolls.length === 0) return null;
  return [...rolls].sort(compareRollsByModel)[0]!;
}

export function rollCandidateKey(roll: Pick<RollSignalCandidate, "legId" | "replacement">): string {
  return `${roll.legId}|${roll.replacement.expiry}|${roll.replacement.strike}|${roll.replacement.strategyKey === "covered_call" ? "C" : "P"}`;
}
