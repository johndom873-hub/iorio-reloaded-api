import { yieldOnExposure } from "../../lib/contractValuation.js";
import { blackScholesDelta, forwardAtSpot, impliedVolatilityFromPrice, parityImpliedForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry } from "../../lib/optionContractLabel.js";
import { contractKey } from "../../lib/optionContractKey.js";
import type { BacktestBaselineSettings } from "../backtestTypes.js";
import { computeSaleFillPrice, sharesPerContract } from "./backtestBook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import type { CommissionEstimator, StockCommissionEstimator } from "../../lib/commissionEstimate.js";

// The candidate rules the Steady Stake, Vol Farmer v4 (volFarmerV4Steps.ts) and live Pluto sell by, first written for
// the CC + Put Ladder (Marcelo 2026-10-15): the realism limits (bid at least $0.05 with an ask above it, a spread within
// maxSpreadPctOfMid of the mid, at most 20% of the contract's previous-session volume), delta on the expiry's parity
// forward, and each sale's premium yield. The live Pluto process loads this file: keep its imports free of node:sqlite,
// the data-file readers and the database.

export const baselineMinimumBid = 0.05;
export const baselineMaxVolumeShare = 0.2;
export const roundedStrike = (strike: number) => Math.round(strike * 10_000) / 10_000;

export interface BaselineCandidate {
  expiry: string;
  strike: number;
  right: "C" | "P";
  bid: number;
  ask: number;
  fillPrice: number;
  dte: number;
  delta: number;
  impliedVolatility: number;
  /** Per share: the fill less its intrinsic value. */
  timeValue: number;
  premiumYield: number;
  /** Contracts the previous session's volume allows. */
  volumeCap: number;
  /** As a fraction (0.05 = 5 points); null when the model was not asked. */
  volatilityEdge: number | null;
  /** Null unless the candidates are ranked by it. */
  edgeYield: number | null;
}

export interface BaselineRejections {
  outsideExpiryRange: number;
  noUsableQuote: number;
  spreadTooWide: number;
  tooLittleVolume: number;
  noImpliedVolatility: number;
  outsideDeltaRange: number;
  noTimeValue: number;
  alreadyHeld: number;
  belowCost: number;
  aboveCeiling: number;
  belowMinimumYield: number;
  spansEarnings: number;
  noForecast: number;
  belowVolatilityEdge: number;
  /** The commission more than maxCommissionShareOfPremium of the premium (Vol Farmer v4's Calls). */
  commissionOverCap: number;
}

/** A contract the commission cap left out, with what the rule compared: one contract's commission against its premium (fill × 100). */
export interface BaselineCommissionCapped extends BaselineCandidate {
  commissionDollars: number;
  premiumDollars: number;
}

/** An expiry's forward as the day's first look that quoted it found it (parity), with the stock price then. */
export interface BaselineForwardAnchor {
  forward: number;
  spotPrice: number;
}

/**
 * Notes the forward of every expiry the look quotes that the day has no anchor for yet (Pluto's rule, approved by
 * Marcelo 2026-10-15): put-call parity on the look's quotes of that expiry, else spot × e^(rT). The caller keeps the
 * anchors for the ticker's day and starts afresh each day; later looks move them with the stock (forwardAtSpot).
 */
export function noteBaselineForwardAnchors(anchors: Map<string, BaselineForwardAnchor>, look: { quotes: readonly SymbolFileQuote[]; todayIso: string; yearsToTodaysClose: number; stockPrice: number; riskFreeRate: number }): void {
  const quotesByExpiry = new Map<string, { strike: number; right: "C" | "P"; bid: number | null; ask: number | null }[]>();
  for (const quote of look.quotes) {
    if (anchors.has(quote.expiry) || quote.expiry < look.todayIso) continue;
    const expiryQuotes = quotesByExpiry.get(quote.expiry) ?? quotesByExpiry.set(quote.expiry, []).get(quote.expiry)!;
    expiryQuotes.push({ strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask });
  }
  for (const [expiry, expiryQuotes] of quotesByExpiry) {
    const yearsToExpiry = expiry === look.todayIso ? look.yearsToTodaysClose : yearsBetweenIsoDates(look.todayIso, expiry);
    const spotForward = look.stockPrice * Math.exp(look.riskFreeRate * yearsToExpiry);
    anchors.set(expiry, { forward: parityImpliedForward(expiryQuotes, spotForward, yearsToExpiry, look.riskFreeRate) ?? spotForward, spotPrice: look.stockPrice });
  }
}

/**
 * The commissions the steps rank and size with, as Pluto estimates them (Marcelo 2026-10-15): live passes IBKR's
 * estimators, the backtest the flat rates its ledger charges. A new option is priced at one contract.
 */
export interface BaselineCommissions {
  option: CommissionEstimator;
  stock: StockCommissionEstimator;
}

const optionCommissionPerContract = (commissions: BaselineCommissions) => commissions.option.perContractDollars("sell", 1);
const stockCommissionPerLot = (commissions: BaselineCommissions) => commissions.stock.perShareDollars("buy") * sharesPerContract;

export interface BaselineCandidateInput {
  /** Every quote of the look. */
  quotes: readonly SymbolFileQuote[];
  /** The day's forward anchors by expiry (noteBaselineForwardAnchors, run on this look first). */
  forwardAnchors: ReadonlyMap<string, BaselineForwardAnchor>;
  commissions: BaselineCommissions;
  right: "C" | "P";
  todayIso: string;
  /** T for an option expiring on the look's day: the hours from the look to that day's close ÷ 8,760 (later expiries use whole calendar days). */
  yearsToTodaysClose: number;
  stockPrice: number;
  /** As a fraction (0.05 = 5%). */
  riskFreeRate: number;
  /** The previous session's volume by contractKey; null when unknown (nothing passes the volume limit). */
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  /** Pluto only (Marcelo 2026-10-30): expiries without the previous session's volume, on which the volume limit is lifted for the day; the lab always has the volumes. */
  volumeLimitLiftedExpiries?: ReadonlySet<string>;
  settings: Pick<BacktestBaselineSettings, "minAbsDelta" | "maxAbsDelta" | "minDte" | "maxDte" | "maxSpreadPctOfMid">;
  /** λ: the share of the half-spread a fill gives up. */
  spreadShareCharged: number;
  isHeld(contract: { expiry: string; strike: number }): boolean;
  /** The trading sessions from today's to an expiry's, both in full (tradingSessionsHeld.ts): what a premium yield is annualized over. */
  tradingSessionsThrough(expiry: string): number;
  /** Calls on held shares under a cost rule: the lowest strike allowed; absent or null when any strike is. */
  minimumStrike?: number | null;
  /** The highest strike allowed (puts under a cost rule); absent or null when any strike is. */
  maximumStrike?: number | null;
  /** Leaves out a contract whose commission is more than this share of its premium (0.2 = 20%); absent: no cap. */
  maxCommissionShareOfPremium?: number;
}

/** Each expiry's days, years and sessions to it, worked out the first time a quote of it reaches the check that reads it. */
type ExpiryFigures = { dte: number; yearsToExpiry: number; sessionsHeld?: number };

/** The quote rules: a bid of at least baselineMinimumBid with an ask above it, then a spread within maxSpreadPctOfMid of the mid. Null when both pass. */
export function baselineQuoteRejection(quote: { bid: number | null; ask: number | null }, maxSpreadPctOfMid: number): "noUsableQuote" | "spreadTooWide" | null {
  if (quote.bid === null || quote.ask === null || quote.bid < baselineMinimumBid || !(quote.ask > quote.bid)) return "noUsableQuote";
  const mid = (quote.bid + quote.ask) / 2;
  if ((quote.ask - quote.bid) / mid > maxSpreadPctOfMid / 100) return "spreadTooWide";
  return null;
}

/**
 * A sale's time value and premium yield at a fill: the fill less its intrinsic value, and what that earns after one
 * contract's commission on the capital it ties up (strike, or the stock, less the fill), annualized over the trading
 * sessions held: × 252 ÷ sessions (tradingSessionsHeld.ts). A null yield: no time value left after the commission, or no
 * capital.
 */
export function baselineSaleYield(input: { isCall: boolean; fillPrice: number; strike: number; stockPrice: number; sessionsHeld: number; commissions: BaselineCommissions }): { timeValue: number; premiumYield: number | null } {
  const intrinsicValue = input.isCall ? Math.max(input.stockPrice - input.strike, 0) : Math.max(input.strike - input.stockPrice, 0);
  const timeValue = input.fillPrice - intrinsicValue;
  const capitalPerShare = (input.isCall ? input.stockPrice : input.strike) - input.fillPrice;
  const earnedDollars = timeValue * sharesPerContract - optionCommissionPerContract(input.commissions);
  if (!(earnedDollars > 0) || !(capitalPerShare > 0)) return { timeValue, premiumYield: null };
  return { timeValue, premiumYield: yieldOnExposure(earnedDollars, capitalPerShare * sharesPerContract, input.sessionsHeld) };
}

/** A hedge Put's cost per contract: its time value (the fill less any in-the-money part) plus one contract's commission; null when not above 0 or without a stock price. */
function hedgePutCostDollars(input: { fillPrice: number; strike: number; stockPrice: number; commissionDollarsPerContract: number }): number | null {
  const timeValue = input.fillPrice - Math.max(input.strike - input.stockPrice, 0);
  const costDollars = timeValue * sharesPerContract + input.commissionDollarsPerContract;
  return costDollars > 0 && input.stockPrice > 0 ? costDollars : null;
}

/**
 * A hedge Put's yearly cost at its purchase, the sale yield's twin (Marcelo 2026-10-26, the Wheel cycles' hedge rows): its
 * cost on the stock it protects, annualized over the trading sessions it is held, as every yield (Marcelo 2026-10-29):
 * (time value × 100 + commission) ÷ (stock price × 100) × 252 ÷ sessions. Null when that cost is not above 0.
 */
export function hedgePutCostYield(input: { fillPrice: number; strike: number; stockPrice: number; sessionsHeld: number; commissionDollarsPerContract: number }): number | null {
  const costDollars = hedgePutCostDollars(input);
  return costDollars === null ? null : yieldOnExposure(costDollars, input.stockPrice * sharesPerContract, input.sessionsHeld);
}

/** The same cost over calendar days to expiry, at least one, ÷ (days ÷ 365): what a purchase recorded before engine 4 (no session count) shows. */
export function hedgePutCostYieldOnCalendarDays(input: { fillPrice: number; strike: number; stockPrice: number; dte: number; commissionDollarsPerContract: number }): number | null {
  const costDollars = hedgePutCostDollars(input);
  return costDollars === null ? null : (costDollars / (input.stockPrice * sharesPerContract)) * (365 / Math.max(input.dte, 1));
}

/** Pure: the contracts of one right that pass the rules, best premium yield first (ties: nearer expiry, then lower strike). */
export function selectBaselineCandidates(input: BaselineCandidateInput): { candidates: BaselineCandidate[]; rejections: BaselineRejections; commissionCapped: BaselineCommissionCapped[] } {
  const commissionCapped: BaselineCommissionCapped[] = [];
  const rejections: BaselineRejections = { outsideExpiryRange: 0, noUsableQuote: 0, spreadTooWide: 0, tooLittleVolume: 0, noImpliedVolatility: 0, outsideDeltaRange: 0, noTimeValue: 0, alreadyHeld: 0, belowCost: 0, aboveCeiling: 0, belowMinimumYield: 0, spansEarnings: 0, noForecast: 0, belowVolatilityEdge: 0, commissionOverCap: 0 };
  const isCall = input.right === "C";
  // The day's anchor moved with the stock (sticky moneyness), as Pluto's surface; an expiry without one (not noted) on spot × e^(rT).
  const forwardOf = (expiry: string, yearsToExpiry: number) => {
    const anchor = input.forwardAnchors.get(expiry);
    return anchor ? forwardAtSpot(anchor.forward, anchor.spotPrice, input.stockPrice) : input.stockPrice * Math.exp(input.riskFreeRate * yearsToExpiry);
  };
  const figuresByExpiry = new Map<string, ExpiryFigures>();
  const candidates: BaselineCandidate[] = [];
  for (const quote of input.quotes) {
    if (quote.right !== input.right) continue;
    let expiryFigures = figuresByExpiry.get(quote.expiry);
    if (!expiryFigures) {
      const expiryDte = daysToExpiry(quote.expiry, input.todayIso);
      expiryFigures = { dte: expiryDte, yearsToExpiry: expiryDte === 0 ? input.yearsToTodaysClose : yearsBetweenIsoDates(input.todayIso, quote.expiry) };
      figuresByExpiry.set(quote.expiry, expiryFigures);
    }
    const { dte, yearsToExpiry } = expiryFigures;
    // The expiry rule: DTE within minDte–maxDte.
    if (dte < input.settings.minDte || dte > input.settings.maxDte) {
      rejections.outsideExpiryRange++;
      continue;
    }
    if (input.minimumStrike !== undefined && input.minimumStrike !== null && quote.strike < input.minimumStrike - 1e-9) {
      rejections.belowCost++;
      continue;
    }
    if (input.maximumStrike !== undefined && input.maximumStrike !== null && quote.strike > input.maximumStrike + 1e-9) {
      rejections.aboveCeiling++;
      continue;
    }
    const quoteRejection = baselineQuoteRejection(quote, input.settings.maxSpreadPctOfMid);
    if (quoteRejection !== null) {
      rejections[quoteRejection]++;
      continue;
    }
    const bid = quote.bid!;
    const ask = quote.ask!;
    const mid = (bid + ask) / 2;
    const volume = input.previousSessionVolumeByContract?.get(contractKey(quote)) ?? null;
    const volumeCap = input.volumeLimitLiftedExpiries?.has(quote.expiry) ? Number.POSITIVE_INFINITY : volume === null ? 0 : Math.floor(volume * baselineMaxVolumeShare);
    if (volumeCap < 1) {
      rejections.tooLittleVolume++;
      continue;
    }
    const forward = forwardOf(quote.expiry, yearsToExpiry);
    const impliedVolatility = impliedVolatilityFromPrice(mid, forward, quote.strike, yearsToExpiry, input.riskFreeRate, isCall);
    if (impliedVolatility === null) {
      rejections.noImpliedVolatility++;
      continue;
    }
    const delta = blackScholesDelta(forward, quote.strike, yearsToExpiry, input.riskFreeRate, impliedVolatility, isCall);
    if (Math.abs(delta) < input.settings.minAbsDelta || Math.abs(delta) > input.settings.maxAbsDelta) {
      rejections.outsideDeltaRange++;
      continue;
    }
    if (input.isHeld({ expiry: quote.expiry, strike: quote.strike })) {
      rejections.alreadyHeld++;
      continue;
    }
    const fillPrice = computeSaleFillPrice(bid, ask, input.spreadShareCharged);
    // Worked out once a contract of the expiry has passed the range checks: only those are annualized.
    const sessionsHeld = (expiryFigures.sessionsHeld ??= input.tradingSessionsThrough(quote.expiry));
    const { timeValue, premiumYield } = baselineSaleYield({ isCall, fillPrice, strike: quote.strike, stockPrice: input.stockPrice, sessionsHeld, commissions: input.commissions });
    if (premiumYield === null) {
      rejections.noTimeValue++;
      continue;
    }
    const candidate: BaselineCandidate = {
      expiry: quote.expiry,
      strike: quote.strike,
      right: input.right,
      bid,
      ask,
      fillPrice,
      dte,
      delta,
      impliedVolatility,
      timeValue,
      premiumYield,
      volumeCap,
      volatilityEdge: null,
      edgeYield: null,
    };
    // Example: a Call at a $0.05 fill brings $5.00 a contract; a $1.11 commission is 22% of it, over a 20% cap.
    const commissionDollars = optionCommissionPerContract(input.commissions);
    const premiumDollars = fillPrice * sharesPerContract;
    if (input.maxCommissionShareOfPremium !== undefined && commissionDollars > input.maxCommissionShareOfPremium * premiumDollars) {
      rejections.commissionOverCap++;
      commissionCapped.push({ ...candidate, commissionDollars, premiumDollars });
      continue;
    }
    candidates.push(candidate);
  }
  candidates.sort((a, b) => b.premiumYield - a.premiumYield || a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
  commissionCapped.sort((a, b) => b.premiumYield - a.premiumYield);
  return { candidates, rejections, commissionCapped };
}

/** "spread 40, volume 12": the rules that left contracts out, most first. */
export function describeRejections(rejections: BaselineRejections): string {
  const labels: Record<keyof BaselineRejections, string> = { outsideExpiryRange: "expiry", noUsableQuote: "quote", spreadTooWide: "spread", tooLittleVolume: "volume", noImpliedVolatility: "IV", outsideDeltaRange: "delta", noTimeValue: "time value", alreadyHeld: "held", belowCost: "below cost", aboveCeiling: "above ceiling", belowMinimumYield: "yield", spansEarnings: "earnings", noForecast: "no forecast", belowVolatilityEdge: "IV not above forecast", commissionOverCap: "commission over cap" };
  return (Object.entries(rejections) as [keyof BaselineRejections, number][])
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => `${labels[key]} ${count}`)
    .join(", ");
}

/** Contracts the free cash pays for: a put reserves its strike and brings its fill in; a Covered Call entry pays the shares less the fill. */
export function baselineContractsForCash(freeCash: number, candidate: Pick<BaselineCandidate, "strike" | "fillPrice">, entry: "put" | "covered_call", stockFillPrice: number, commissions: BaselineCommissions): number {
  const optionCommission = optionCommissionPerContract(commissions);
  const perContract = entry === "put" ? (candidate.strike - candidate.fillPrice) * sharesPerContract + optionCommission : (stockFillPrice - candidate.fillPrice) * sharesPerContract + optionCommission + stockCommissionPerLot(commissions);
  return perContract > 0 ? Math.max(0, Math.floor(freeCash / perContract)) : 0;
}
