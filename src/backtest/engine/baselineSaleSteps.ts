import { valueContract, yieldOnExposure } from "../../lib/contractValuation.js";
import type { OpenCycleSummary } from "../../lib/cycleBreakEven.js";
import { blackScholesDelta, forwardAtSpot, impliedVolatilityFromPrice, parityImpliedForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry } from "../../lib/optionContractLabel.js";
import { frictionDollarsPerContract } from "../../lib/signalCandidates.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import type { ModelVolatilityForecast } from "../../lib/volatilityEdge.js";
import type { ValuationGroup, VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import type { BacktestBaselineSettings, BacktestOrderShortfall } from "../backtestTypes.js";
import { ladderBase, ladderBudget, ladderRungToday, ladderShareLots, type LadderCycleState } from "./backtestBaselineLadder.js";
import { computeSaleFillPrice, sharesPerContract } from "./backtestBook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import type { CommissionEstimator, StockCommissionEstimator } from "../../lib/commissionEstimate.js";

// The baseline's candidate rules and sale steps, one implementation for the backtest and live Pluto's CC + Put Ladder
// (Marcelo 2026-10-15). Every read of the book and every sale goes through BaselineLookBook: the backtest's wraps its
// simulated ledger and fills each sale at once (runBaselineLook); live's counts working orders as filled and turns each
// sale into an order. The rules and formulas are described in backtestBaselineLook.ts, which re-exports this file's names.
// The live Pluto process loads this file: keep its imports free of node:sqlite, the data-file readers and the database.

export const baselineMinimumBid = 0.05;
export const baselineMaxVolumeShare = 0.2;
const minimumAnnualizationYears = 1 / 365;
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
}

/** What the Signals model brings to a symbol's look, when the volatility-edge filter or Edge Yield ranking is on. */
export interface BaselineModelInput {
  tables: VolatilityModelTables;
  group: ValuationGroup;
  /** YZ21 from the daily bars before today; null when too few (every contract is then left out). */
  forecast: ModelVolatilityForecast | null;
  /** τ from the look's instant to an expiry's close. */
  varianceSessionsTo(expiryIso: string): number;
  /** The smallest volatility edge sold, as a fraction; null: no filter. */
  minVolatilityEdge: number | null;
  rankByEdgeYield: boolean;
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
  settings: Pick<BacktestBaselineSettings, "minAbsDelta" | "maxAbsDelta" | "minDte" | "maxDte" | "maxSpreadPctOfMid">;
  /** λ: the share of the half-spread a fill gives up. */
  spreadShareCharged: number;
  isHeld(contract: { expiry: string; strike: number }): boolean;
  /** Calls on held shares under a cost rule: the lowest strike allowed; absent or null when any strike is. */
  minimumStrike?: number | null;
  /** The highest strike allowed (puts under a cost rule); absent or null when any strike is. */
  maximumStrike?: number | null;
  /** Only a premium yield above this (a fraction, annualized); absent or null: any. */
  minimumPremiumYield?: number | null;
  /** Earnings dates still to come: an expiry on or after one is left out. Absent: earnings are ignored. */
  earningsDatesIso?: readonly string[];
  /** Absent or null: neither the volatility-edge filter nor Edge Yield ranking. */
  model?: BaselineModelInput | null;
  /** The order without the model (absent: premium yield); Edge Yield ranking comes with the model. */
  ranking?: "premium_yield" | "time_value" | "premium_dollars" | "premium_per_day";
  /** Candidates of the nearest expiry first, then the next expiry's, each in the ranking's order. */
  nearestExpiryFirst?: boolean;
}

/** The expiry rule: DTE within minDte–maxDte. */
export function baselineExpiryInRange(dte: number, settings: Pick<BacktestBaselineSettings, "minDte" | "maxDte">): boolean {
  return !(dte < settings.minDte || dte > settings.maxDte);
}

/** The quote rules: a bid of at least baselineMinimumBid with an ask above it, then a spread within maxSpreadPctOfMid of the mid. Null when both pass. */
export function baselineQuoteRejection(quote: { bid: number | null; ask: number | null }, maxSpreadPctOfMid: number): "noUsableQuote" | "spreadTooWide" | null {
  if (quote.bid === null || quote.ask === null || quote.bid < baselineMinimumBid || !(quote.ask > quote.bid)) return "noUsableQuote";
  const mid = (quote.bid + quote.ask) / 2;
  if ((quote.ask - quote.bid) / mid > maxSpreadPctOfMid / 100) return "spreadTooWide";
  return null;
}

/**
 * A sale's time value and premium yield at a fill: the fill less its intrinsic value, and what that earns after one
 * contract's commission on the capital it ties up (strike, or the stock, less the fill), annualized. A null yield: no
 * time value left after the commission, or no capital.
 */
export function baselineSaleYield(input: { isCall: boolean; fillPrice: number; strike: number; stockPrice: number; yearsToExpiry: number; commissions: BaselineCommissions }): { timeValue: number; premiumYield: number | null } {
  const intrinsicValue = input.isCall ? Math.max(input.stockPrice - input.strike, 0) : Math.max(input.strike - input.stockPrice, 0);
  const timeValue = input.fillPrice - intrinsicValue;
  const capitalPerShare = (input.isCall ? input.stockPrice : input.strike) - input.fillPrice;
  const earnedDollars = timeValue * sharesPerContract - optionCommissionPerContract(input.commissions);
  if (!(earnedDollars > 0) || !(capitalPerShare > 0)) return { timeValue, premiumYield: null };
  return { timeValue, premiumYield: yieldOnExposure(earnedDollars, capitalPerShare * sharesPerContract, Math.max(input.yearsToExpiry, minimumAnnualizationYears)) };
}

/**
 * A hedge Put's yearly cost at its purchase, the sale yield's twin (Marcelo 2026-10-26, the Wheel cycles' hedge rows): its
 * time value (the fill less any in-the-money part) plus one contract's commission, on the stock it protects, annualized
 * over its own days to expiry: (time value × 100 + commission) ÷ (stock price × 100) ÷ (days ÷ 365). Null when that
 * cost is not above 0.
 */
export function hedgePutCostYield(input: { fillPrice: number; strike: number; stockPrice: number; dte: number; commissionDollarsPerContract: number }): number | null {
  const timeValue = input.fillPrice - Math.max(input.strike - input.stockPrice, 0);
  const costDollars = timeValue * sharesPerContract + input.commissionDollarsPerContract;
  if (!(costDollars > 0) || !(input.stockPrice > 0)) return null;
  return yieldOnExposure(costDollars, input.stockPrice * sharesPerContract, Math.max(input.dte / 365, minimumAnnualizationYears));
}

/**
 * The lowest premium yield a sale needs (a fraction, annualized), or null for any: minCallYieldPct for the entries always
 * (a Covered Call's call, or a Cash-Secured Put entry's put: Marcelo 2026-10-19), for the calls on held shares with
 * "every_call"; the ladder's puts at any yield.
 */
export function baselineMinimumSaleYield(baseline: Pick<BacktestBaselineSettings, "minCallYieldPct" | "minCallYieldAppliesTo">, right: "C" | "P", forEntry: boolean, ladderPut: boolean): number | null {
  const minimumCallYield = baseline.minCallYieldPct > 0 ? baseline.minCallYieldPct / 100 : null;
  if (right === "P") return ladderPut ? null : minimumCallYield;
  return forEntry || baseline.minCallYieldAppliesTo === "every_call" ? minimumCallYield : null;
}

/** Pure: the contracts of one right that pass the baseline's rules, best premium yield (or Edge Yield) first (ties: nearer expiry, then lower strike). */
export function selectBaselineCandidates(input: BaselineCandidateInput): { candidates: BaselineCandidate[]; rejections: BaselineRejections } {
  const rejections: BaselineRejections = { outsideExpiryRange: 0, noUsableQuote: 0, spreadTooWide: 0, tooLittleVolume: 0, noImpliedVolatility: 0, outsideDeltaRange: 0, noTimeValue: 0, alreadyHeld: 0, belowCost: 0, aboveCeiling: 0, belowMinimumYield: 0, spansEarnings: 0, noForecast: 0, belowVolatilityEdge: 0 };
  const isCall = input.right === "C";
  // The day's anchor moved with the stock (sticky moneyness), as Pluto's surface; an expiry without one (not noted) on spot × e^(rT).
  const forwardOf = (expiry: string, yearsToExpiry: number) => {
    const anchor = input.forwardAnchors.get(expiry);
    return anchor ? forwardAtSpot(anchor.forward, anchor.spotPrice, input.stockPrice) : input.stockPrice * Math.exp(input.riskFreeRate * yearsToExpiry);
  };
  const candidates: BaselineCandidate[] = [];
  for (const quote of input.quotes) {
    if (quote.right !== input.right) continue;
    const dte = daysToExpiry(quote.expiry, input.todayIso);
    if (!baselineExpiryInRange(dte, input.settings)) {
      rejections.outsideExpiryRange++;
      continue;
    }
    if (input.earningsDatesIso && input.earningsDatesIso.some((dateIso) => dateIso >= input.todayIso && dateIso <= quote.expiry)) {
      rejections.spansEarnings++;
      continue;
    }
    const yearsToExpiry = dte === 0 ? input.yearsToTodaysClose : yearsBetweenIsoDates(input.todayIso, quote.expiry);
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
    const volumeCap = volume === null ? 0 : Math.floor(volume * baselineMaxVolumeShare);
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
    const { timeValue, premiumYield } = baselineSaleYield({ isCall, fillPrice, strike: quote.strike, stockPrice: input.stockPrice, yearsToExpiry, commissions: input.commissions });
    if (premiumYield === null) {
      rejections.noTimeValue++;
      continue;
    }
    if (input.minimumPremiumYield !== undefined && input.minimumPremiumYield !== null && !(premiumYield > input.minimumPremiumYield)) {
      rejections.belowMinimumYield++;
      continue;
    }
    let volatilityEdge: number | null = null;
    let edgeYield: number | null = null;
    if (input.model) {
      const forecast = input.model.forecast;
      const varianceSessions = input.model.varianceSessionsTo(quote.expiry);
      if (forecast === null || !(varianceSessions > 0)) {
        rejections.noForecast++;
        continue;
      }
      volatilityEdge = Math.sqrt((252 * impliedVolatility * impliedVolatility * yearsToExpiry) / varianceSessions) - forecast.annualizedVolatility;
      if (input.model.minVolatilityEdge !== null && volatilityEdge < input.model.minVolatilityEdge - 1e-12) {
        rejections.belowVolatilityEdge++;
        continue;
      }
      if (input.model.rankByEdgeYield) {
        const valuation = valueContract(input.model.tables, {
          isCall,
          strike: quote.strike,
          forward,
          mid,
          frictionDollars: frictionDollarsPerContract(bid, ask, input.spreadShareCharged, optionCommissionPerContract(input.commissions)),
          perSessionVariance: forecast.perSessionVariance,
          varianceSessions,
          calendarYears: yearsToExpiry,
          riskFreeRate: input.riskFreeRate,
          group: input.model.group,
          spot: input.stockPrice,
        });
        if (valuation === null) {
          rejections.noForecast++;
          continue;
        }
        edgeYield = valuation.expectedAnnualizedReturn;
      }
    }
    candidates.push({
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
      volatilityEdge,
      edgeYield,
    });
  }
  const rankOf = (candidate: BaselineCandidate) => baselineCandidateRank(candidate, input.ranking, input.model?.rankByEdgeYield ?? false);
  candidates.sort((a, b) => (input.nearestExpiryFirst ? a.expiry.localeCompare(b.expiry) : 0) || rankOf(b) - rankOf(a) || a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
  return { candidates, rejections };
}

/** A candidate's measure in the ranking: Edge Yield when the model ranks by it, else the ranking's own (premium yield when none). */
export function baselineCandidateRank(candidate: BaselineCandidate, ranking: BaselineCandidateInput["ranking"], rankByEdgeYield: boolean): number {
  if (rankByEdgeYield) return candidate.edgeYield!;
  if (ranking === "time_value") return candidate.timeValue;
  if (ranking === "premium_dollars") return candidate.fillPrice;
  if (ranking === "premium_per_day") return candidate.fillPrice / Math.max(candidate.dte, 1);
  return candidate.premiumYield;
}

/** "spread 40, volume 12": the rules that left contracts out, most first. */
export function describeRejections(rejections: BaselineRejections): string {
  const labels: Record<keyof BaselineRejections, string> = { outsideExpiryRange: "expiry", noUsableQuote: "quote", spreadTooWide: "spread", tooLittleVolume: "volume", noImpliedVolatility: "IV", outsideDeltaRange: "delta", noTimeValue: "time value", alreadyHeld: "held", belowCost: "below cost", aboveCeiling: "above ceiling", belowMinimumYield: "yield", spansEarnings: "earnings", noForecast: "no forecast", belowVolatilityEdge: "IV not above forecast" };
  return (Object.entries(rejections) as [keyof BaselineRejections, number][])
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => `${labels[key]} ${count}`)
    .join(", ");
}

const formatRuleNumber = (value: number) => String(+value.toFixed(4));

/**
 * Each check's rule as one selection applied it, in the order the checks run: a contract drops out at the first it fails
 * (the Wheel cycles' explanation of a look that found no candidate).
 */
export function describeBaselineRules(input: Pick<BaselineCandidateInput, "settings" | "minimumStrike" | "maximumStrike" | "minimumPremiumYield" | "previousSessionVolumeByContract" | "model">): Record<keyof BaselineRejections, string> {
  const { settings } = input;
  return {
    outsideExpiryRange: `expiry outside ${settings.minDte}–${settings.maxDte} days`,
    spansEarnings: "expiry on or after an earnings report",
    belowCost: `strike below the floor${input.minimumStrike != null ? ` of $${input.minimumStrike.toFixed(2)}` : ""}`,
    aboveCeiling: `strike above the cap${input.maximumStrike != null ? ` of $${input.maximumStrike.toFixed(2)}` : ""}`,
    noUsableQuote: `no usable quote (a bid under $${baselineMinimumBid.toFixed(2)}, or no ask above the bid)`,
    spreadTooWide: `spread wider than ${formatRuleNumber(settings.maxSpreadPctOfMid)}% of the mid`,
    tooLittleVolume: input.previousSessionVolumeByContract === null ? "no volume known for the previous session" : `under 1 contract at ${formatRuleNumber(baselineMaxVolumeShare * 100)}% of the previous session's volume`,
    noImpliedVolatility: "no implied volatility at the mid",
    outsideDeltaRange: `|delta| outside ${formatRuleNumber(settings.minAbsDelta)}–${formatRuleNumber(settings.maxAbsDelta)}`,
    alreadyHeld: "already held",
    noTimeValue: "no time value left after the commission",
    belowMinimumYield: `premium yield not above ${input.minimumPremiumYield != null ? formatRuleNumber(input.minimumPremiumYield * 100) : "0"}% a year`,
    noForecast: "no volatility forecast",
    belowVolatilityEdge: `volatility edge under ${input.model?.minVolatilityEdge != null ? formatRuleNumber(input.model.minVolatilityEdge * 100) : "0"} points`,
  };
}

/** Contracts the free cash pays for: a put reserves its strike and brings its fill in; a Covered Call entry pays the shares less the fill. */
export function baselineContractsForCash(freeCash: number, candidate: Pick<BaselineCandidate, "strike" | "fillPrice">, entry: "put" | "covered_call", stockFillPrice: number, commissions: BaselineCommissions): number {
  const optionCommission = optionCommissionPerContract(commissions);
  const perContract = entry === "put" ? (candidate.strike - candidate.fillPrice) * sharesPerContract + optionCommission : (stockFillPrice - candidate.fillPrice) * sharesPerContract + optionCommission + stockCommissionPerLot(commissions);
  return perContract > 0 ? Math.max(0, Math.floor(freeCash / perContract)) : 0;
}

export type BaselineSelect = (right: "C" | "P", minimumStrike?: number | null, forEntry?: boolean, maximumStrike?: number | null, byPremiumYield?: boolean, options?: { ladderPut?: boolean }) => { candidates: BaselineCandidate[]; rejections: BaselineRejections; describeRules?: () => Record<keyof BaselineRejections, string> };

/** A look's order that found no contract within the rules: how many each check left out, and each check's rule then. */
export interface BaselineNoCandidate {
  order: "entry" | "calls";
  right: "C" | "P";
  rejections: BaselineRejections;
  rules: Record<keyof BaselineRejections, string> | null;
}

/**
 * A symbol's candidate selection at a look: Puts on the baseline's |delta| range (the ladder's at any |delta| with
 * ladderPutDeltaRange "none"), every Call (on held shares and a new Covered Call) on the Calls' (callDeltaRange).
 */
export function makeBaselineSelector(input: {
  quotes: readonly SymbolFileQuote[];
  forwardAnchors: ReadonlyMap<string, BaselineForwardAnchor>;
  commissions: BaselineCommissions;
  todayIso: string;
  yearsToTodaysClose: number;
  stockPrice: number;
  riskFreeRate: number;
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  baseline: BacktestBaselineSettings;
  spreadShareCharged: number;
  isHeld(contract: { expiry: string; strike: number }): boolean;
  earningsDatesIso: readonly string[] | undefined;
  model: BaselineModelInput | null;
}): BaselineSelect {
  const { quotes, forwardAnchors, commissions, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate, previousSessionVolumeByContract, baseline, spreadShareCharged, isHeld, earningsDatesIso, model } = input;
  // The calls on held shares are held to the margin only when every sale is.
  const callsModel = model && baseline.volatilityEdgeFilter === "entries" ? { ...model, minVolatilityEdge: null } : model;
  // With their own range every Call uses it, the Covered Call entry's included (Marcelo 2026-10-15).
  const callsSettings = baseline.callDeltaRange === "own_range" ? { ...baseline, minAbsDelta: baseline.callMinAbsDelta, maxAbsDelta: baseline.callMaxAbsDelta } : baseline;
  // Sales only above minCallYieldPct (baselineMinimumSaleYield). A put ranked by premium yield alone when asked.
  const minimumYieldFor = (right: "C" | "P", forEntry: boolean, ladderPut: boolean) => baselineMinimumSaleYield(baseline, right, forEntry, ladderPut);
  // Any |delta| passes 0–1: the ladder's Puts without a range still need a usable implied volatility, as every contract does.
  const ladderPutsSettings = baseline.ladderPutDeltaRange === "none" ? { ...baseline, minAbsDelta: 0, maxAbsDelta: 1 } : baseline;
  const settingsFor = (right: "C" | "P", ladderPut: boolean) => (right === "C" ? callsSettings : ladderPut ? ladderPutsSettings : baseline);
  return (right: "C" | "P", minimumStrike: number | null = null, forEntry = true, maximumStrike: number | null = null, byPremiumYield = false, options = {}) => {
    const selectionInput: BaselineCandidateInput = { quotes, forwardAnchors, commissions, right, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate, previousSessionVolumeByContract: previousSessionVolumeByContract, settings: settingsFor(right, options.ladderPut === true), spreadShareCharged, isHeld, minimumStrike, maximumStrike, minimumPremiumYield: minimumYieldFor(right, forEntry, options.ladderPut === true), ...(earningsDatesIso ? { earningsDatesIso } : {}), model: byPremiumYield && model ? { ...model, rankByEdgeYield: false } : forEntry ? model : callsModel, ...(byPremiumYield ? { ranking: "premium_yield" as const } : baseline.ranking !== "edge_yield" ? { ranking: baseline.ranking } : {}), nearestExpiryFirst: !byPremiumYield && baseline.expiryChoice === "nearest_qualifying" };
    return { ...selectBaselineCandidates(selectionInput), describeRules: () => describeBaselineRules(selectionInput) };
  };
}

/** What the sale steps read from the symbol's book and how they sell; prices on the cycle's scale unless the name says "Today". */
export interface BaselineLookBook {
  /** Shares held with no call written on them. */
  freeShares(): number;
  /** Cash less every open put's strike. */
  freeCash(): number;
  /** The running average price of the shares held; null when none are held. */
  heldSharesAverageCost(): number | null;
  heldSharesAverageCostToday(): number | null;
  heldSharesToday(): number;
  latestShareAcquisitionPrice(): number | null;
  openCycleSummary(): OpenCycleSummary | null;
  /** Open cash-secured puts' strike × shares. */
  openPutCollateral(): number;
  /** The day's account value for sizing (dayValueOptions): the whole account's. */
  accountValueToday(): number;
  /** The ticker's share of the account for the ladder's base: its pot ÷ every pot, fixed for the session; 1 when the session's tickers share one account. */
  tickerWeight(): number;
  /** Net liquidation value at the look's marks (maxAccountPctPerStock). */
  netLiquidationValue(): number;
  /** The symbol's open positions' capital at risk (maxAccountPctPerStock). */
  openPositionsCapitalAtRisk(): number;
  hasOpenCashSecuredPut(): boolean;
  /** One position per contract (either right): held, or sold earlier at this look. */
  isHeld(contract: { expiry: string; strike: number }): boolean;
  /** One sale: the backtest fills it at once, live places it as an order. `step`: the order it belongs to (held calls, entry, ladder put). */
  sell(strategyKey: "cash_secured_put" | "covered_call", candidate: BaselineCandidate, contracts: number, eligibleCount: number, chosenBecause: string, strikeLimit?: { name: "costFloor" | "costCeiling"; value: number | null } | null, buyEveryShare?: boolean, extraScores?: Record<string, number | null>, step?: BaselineSaleStep): void;
}

export interface BaselineSalesInput {
  symbol: string;
  commissions: BaselineCommissions;
  todayIso: string;
  atMs: number;
  stockPrice: number;
  /** The cycle's split scale over today's (1 without a split in the cycle). */
  priceToCycleScale: number;
  baseline: BacktestBaselineSettings;
  select: BaselineSelect;
  book: BaselineLookBook;
  /** The ladder's cycle memory, noted before the look's sales; null when the ladder is off. */
  ladderState: LadderCycleState | null;
  /** The look's lines ("no call for …"), in order with the sales' own. */
  notes: string[];
  /** Told of each order that left contracts unsold (recorded only: no decision reads it). */
  noteShortfall?: (shortfall: BaselineOrderShortfall) => void;
  /** Why the drop-risk filters block new entries today (entryDropRiskFilters.ts); null or absent when they don't. */
  entryBlockedBecause?: string | null;
  /** Records a sale that was due and not made for a reason the shortfalls do not hold (recorded only). */
  noteNoSale?: (reason: BaselineNoSaleReason) => void;
  /** Records an order that found no contract within the rules: what each check left out (recorded only). */
  noteNoCandidate?: (note: BaselineNoCandidate) => void;
}

/** The Entry filters blocked the entry; or a ladder put was sold instead of the calls on the free shares, a call qualifying or none. */
export type BaselineNoSaleReason = "entry_filter" | "ladder_put_instead_of_calls" | "no_call_candidate";

/** An order that left contracts unsold, without the look's own facts (its time and symbol). */
export type BaselineOrderShortfall = Omit<BacktestOrderShortfall, "tradingDate" | "at" | "lookTimeEt" | "symbol" | "lookCount">;

/** The look's order a sale belongs to: the calls on held shares, the entry with the free cash, or a ladder put. */
export type BaselineSaleStep = BaselineOrderShortfall["step"];

/** The pre-step and steps 1–4 of the baseline's look, in order: each step sees the book after the earlier steps' sales. */
export function planBaselineSales(input: BaselineSalesInput): void {
  const { symbol, commissions, todayIso, atMs, stockPrice, priceToCycleScale, baseline, select, book, ladderState, notes } = input;
  const rankingLabel = { premium_yield: "premium yield", edge_yield: "Edge Yield", time_value: "time value", premium_dollars: "premium", premium_per_day: "premium per day" }[baseline.ranking];
  const fillDown = baseline.coverage === "fill_down_ranking";
  const heldSharesCostToday = () => (book.heldSharesAverageCostToday() ?? 0) * book.heldSharesToday();

  // Shares are bought at the look's price itself.
  const stockFillToday = stockPrice;

  // What each order wanted and why any of it went unsold, recorded only: each sale's scores, and input.noteShortfall.
  // An order's best candidate is the first in its ranking not already held when it starts; its rank counts from 1.
  const bestOf = (candidates: readonly BaselineCandidate[]) => candidates.find((candidate) => !book.isHeld(candidate)) ?? null;
  const orderScores = (wantedContracts: number | null, candidates: readonly BaselineCandidate[], candidate: BaselineCandidate, best: BaselineCandidate | null): Record<string, number | null> => ({
    wantedContracts,
    rank: candidates.indexOf(candidate) + 1,
    bestCandidateStrike: best?.strike ?? null,
    bestCandidateDte: best?.dte ?? null,
    bestCandidatePremiumYield: best?.premiumYield ?? null,
    bestCandidateVolumeCap: best?.volumeCap ?? null,
  });
  /** An order that wanted contracts and left some unsold (unsold null: none to measure it by, so nothing was within the rules). */
  const noteOrderShortfall = (order: { step: BaselineOrderShortfall["step"]; right: "C" | "P"; wanted: number | null; filled: number; unsold: number | null; cashCut: boolean; anyCandidate: boolean; best: BaselineCandidate | null }) => {
    if (!input.noteShortfall || (order.unsold !== null && order.unsold < 1)) return;
    const { best } = order;
    input.noteShortfall({
      step: order.step,
      right: order.right,
      wantedContracts: order.wanted,
      filledContracts: order.filled,
      unsoldContracts: order.unsold,
      reason: order.cashCut ? "cash" : order.anyCandidate ? "volume" : "no_candidate",
      bestCandidate: best === null ? null : { expiry: best.expiry, strike: best.strike, dte: best.dte, premiumYield: best.premiumYield, volumeCap: best.volumeCap },
    });
  };

  // 1. Calls on the free round lots.
  const freeLots = Math.floor((book.freeShares() * priceToCycleScale) / sharesPerContract + 1e-9);
  let uncoveredLots = freeLots;
  // The floors tried in turn, lowest strike allowed on today's scale (null: any strike): with
  // "above_average_cost_else_break_even", the average price held first, then the cycle's break-even for the lots left. A
  // call's break-even is the cycle's cash one (Marcelo 2026-10-20): what the shares held must bring back for the cycle to
  // end flat, counting what earlier shares left at (the pro-rata one let a cycle that rebought dearer shares end negative).
  const callFloors: { floor: number | null; label: string }[] = [];
  if (freeLots >= 1 && baseline.callStrike !== "none") {
    const onTodaysScale = (perShareOnCycleScale: number | null) => (perShareOnCycleScale === null ? Number.POSITIVE_INFINITY : perShareOnCycleScale / priceToCycleScale);
    const cycle = baseline.callStrike === "delta_range" || baseline.callStrike === "above_latest_entry" || baseline.callStrike === "above_average_cost" ? null : book.openCycleSummary();
    if (baseline.callStrike === "delta_range") callFloors.push({ floor: null, label: "" });
    else if (baseline.callStrike === "above_latest_entry") callFloors.push({ floor: onTodaysScale(book.latestShareAcquisitionPrice()), label: "" });
    else if (baseline.callStrike === "above_average_cost") callFloors.push({ floor: onTodaysScale(book.heldSharesAverageCost()), label: "" });
    else if (baseline.callStrike === "above_share_cost") callFloors.push({ floor: onTodaysScale(cycle && cycle.sharesAcquired > 0 ? cycle.acquisitionCost / cycle.sharesAcquired : null), label: "" });
    else if (baseline.callStrike === "above_break_even") callFloors.push({ floor: onTodaysScale(cycle?.cashBreakEvenPerShare ?? null), label: "" });
    else {
      callFloors.push({ floor: onTodaysScale(book.heldSharesAverageCost()), label: " at or above the average price held" });
      if (cycle?.cashBreakEvenPerShare != null) callFloors.push({ floor: onTodaysScale(cycle.cashBreakEvenPerShare), label: " at or above the break-even (none at or above the average)" });
    }
  }
  // The ladder put, planned for today's rung (null when the ladder cannot sell one now: no cycle, no rung, one open).
  const ladderReady = ladderState !== null && ladderState.startedOn !== null && baseline.ladderPace !== "no_puts" && freeLots >= 1;
  const planLadderPuts = () => {
    if (!ladderState) return null;
    const cycle = book.openCycleSummary();
    const breakEven = cycle?.breakEvenPerShare == null ? null : cycle.breakEvenPerShare / priceToCycleScale;
    const rung = ladderRungToday({ settings: baseline, state: ladderState, accountValueToday: book.accountValueToday(), tickerWeight: book.tickerWeight(), breakEven, stockPrice, heldSharesCost: heldSharesCostToday(), openPutCollateral: book.openPutCollateral(), sharesAverageCost: book.heldSharesAverageCostToday() });
    if (baseline.ladderPace === "one_open" && book.openPutCollateral() > 0) return { rung, blocked: `${symbol}: no new ladder put while one is open`, candidates: [] as BaselineCandidate[], rejections: null };
    if (rung.cap === null) return { rung, blocked: `${symbol}: no ladder put (${rung.note})`, candidates: [] as BaselineCandidate[], rejections: null };
    const { candidates, rejections } = select("P", null, true, rung.cap, true, { ladderPut: true });
    return { rung, blocked: null, candidates, rejections };
  };
  const ladderPutLimits = (candidate: BaselineCandidate, collateralLeft: number) => ({
    byCollateral: Math.floor(collateralLeft / (candidate.strike * sharesPerContract)),
    byCash: baselineContractsForCash(book.freeCash(), candidate, "put", stockFillToday, commissions),
    byVolume: candidate.volumeCap,
  });
  const ladderPutContracts = (candidate: BaselineCandidate, collateralLeft: number) => {
    const limits = ladderPutLimits(candidate, collateralLeft);
    return Math.min(limits.byCollateral, limits.byCash, limits.byVolume);
  };
  const sellLadderPuts = (plan: NonNullable<ReturnType<typeof planLadderPuts>>, why: string) => {
    if (plan.blocked !== null) {
      notes.push(plan.blocked);
      return;
    }
    const cap = plan.rung.cap!;
    // The rung wants its collateral's worth of the best put: collateral ÷ (strike × 100).
    const best = bestOf(plan.candidates);
    const contractsOfBest = (collateral: number) => (best === null ? null : Math.floor(collateral / (best.strike * sharesPerContract)));
    const wanted = contractsOfBest(plan.rung.collateral);
    let collateralLeft = plan.rung.collateral;
    let putsSold = 0;
    let contractsSold = 0;
    let cashCut = false;
    for (const candidate of fillDown ? plan.candidates : plan.candidates.slice(0, 1)) {
      if (book.isHeld(candidate)) continue;
      const limits = ladderPutLimits(candidate, collateralLeft);
      const contracts = Math.min(limits.byCollateral, limits.byCash, limits.byVolume);
      cashCut ||= limits.byCash < Math.min(limits.byCollateral, limits.byVolume);
      if (contracts < 1) continue;
      book.sell("cash_secured_put", candidate, contracts, plan.candidates.length, `baseline: the ladder put with the highest premium yield (${why}), strike at most ${cap.toFixed(2)}${putsSold > 0 ? " (next in order: the volume limit of the ones before)" : ""}`, { name: "costCeiling", value: cap }, false, { ...plan.rung.scores, ...orderScores(wanted, plan.candidates, candidate, best) }, "ladder_put");
      collateralLeft -= contracts * candidate.strike * sharesPerContract;
      putsSold++;
      contractsSold += contracts;
    }
    noteOrderShortfall({ step: "ladder_put", right: "P", wanted, filled: contractsSold, unsold: contractsOfBest(collateralLeft), cashCut, anyCandidate: plan.candidates.length > 0, best });
    if (putsSold === 0) notes.push(`${symbol}: no ladder put at or below ${cap.toFixed(2)} (${plan.candidates.length > 0 ? `${plan.candidates.length} within the rules, none fits the rung or the cash` : (plan.rejections && describeRejections(plan.rejections)) || "no quotes"}; ${plan.rung.note})`);
  };
  // With ladderPutVersusCall "higher_yield": the best ladder put that can be sold now against the best call on the free
  // shares; a put yielding more than ladderPutYieldMarginPct% above the call is sold instead (the shares wait).
  let ladderPutChosen = false;
  if (ladderReady && baseline.ladderPutVersusCall === "higher_yield") {
    const plan = planLadderPuts();
    const bestPut = plan && plan.blocked === null ? (plan.candidates.find((candidate) => !book.isHeld(candidate) && ladderPutContracts(candidate, plan.rung.collateral) >= 1) ?? null) : null;
    if (plan && bestPut) {
      let bestCall: BaselineCandidate | null = null;
      let lastCallSelection: ReturnType<BaselineSelect> | null = null;
      for (const { floor } of callFloors) {
        lastCallSelection = select("C", floor, false);
        bestCall = lastCallSelection.candidates.find((candidate) => !book.isHeld(candidate)) ?? null;
        if (bestCall) break;
      }
      const marginFactor = 1 + baseline.ladderPutYieldMarginPct / 100;
      if (bestCall === null || bestPut.premiumYield > bestCall.premiumYield * marginFactor) {
        ladderPutChosen = true;
        // The calls' order is skipped and records no shortfall: say why the shares wait.
        input.noteNoSale?.(bestCall === null ? "no_call_candidate" : "ladder_put_instead_of_calls");
        if (bestCall === null && lastCallSelection) input.noteNoCandidate?.({ order: "calls", right: "C", rejections: lastCallSelection.rejections, rules: lastCallSelection.describeRules?.() ?? null });
        sellLadderPuts(plan, bestCall === null ? "no call qualifies" : `its yield ${(bestPut.premiumYield * 100).toFixed(1)}% beats the best call's ${(bestCall.premiumYield * 100).toFixed(1)}% by more than ${baseline.ladderPutYieldMarginPct}%`);
      }
    }
  }

  let lastCallRejections: BaselineRejections | null = null;
  let lastCallRules: (() => Record<keyof BaselineRejections, string>) | undefined;
  let anyCallCandidate = false;
  // The order wants a call on every free lot; its best candidate is the first floor's. A Call order also records the
  // shares' average cost before it and the look's stock price (the Analyse window's largest pot).
  let heldCallsBest: BaselineCandidate | null = null;
  const heldCallsSharesAverageCost = book.heldSharesAverageCostToday();
  for (const { floor, label } of ladderPutChosen ? [] : callFloors) {
    if (uncoveredLots < 1) break;
    const { candidates, rejections, describeRules } = select("C", floor, false);
    lastCallRejections = rejections;
    lastCallRules = describeRules;
    anyCallCandidate ||= candidates.length > 0;
    heldCallsBest ??= bestOf(candidates);
    let soldAtThisFloor = 0;
    for (const candidate of fillDown ? candidates : candidates.slice(0, 1)) {
      if (uncoveredLots < 1) break;
      if (book.isHeld(candidate)) continue;
      const contracts = Math.min(uncoveredLots, candidate.volumeCap);
      book.sell("covered_call", candidate, contracts, candidates.length, `baseline: the call with the highest ${rankingLabel}${label} on the free shares${fillDown && soldAtThisFloor > 0 ? " (next in order: the volume limit of the ones before)" : ""}`, floor === null ? null : { name: "costFloor", value: floor }, false, { ...orderScores(freeLots, candidates, candidate, heldCallsBest), sharesAverageCostBefore: heldCallsSharesAverageCost, stockPriceAtLook: stockPrice }, "held_calls");
      uncoveredLots -= contracts;
      soldAtThisFloor += 1;
    }
  }
  if (!ladderPutChosen && callFloors.length > 0) noteOrderShortfall({ step: "held_calls", right: "C", wanted: freeLots, filled: freeLots - uncoveredLots, unsold: uncoveredLots, cashCut: false, anyCandidate: anyCallCandidate, best: heldCallsBest });
  // When the ladder put was chosen over the calls, they were quoted and lost: the put's own line says why.
  if (callFloors.length > 0 && !anyCallCandidate && !ladderPutChosen) {
    notes.push(`${symbol}: no call for ${freeLots * sharesPerContract} free shares (${(lastCallRejections && describeRejections(lastCallRejections)) || "no quotes"})`);
    if (lastCallRejections) input.noteNoCandidate?.({ order: "calls", right: "C", rejections: lastCallRejections, rules: lastCallRules?.() ?? null });
  }

  // 2. The entry with the free cash: a Cash-Secured Put, a Covered Call, or (higher_yield, Marcelo 2026-10-20) whichever of
  // the two ranks higher at the look by the session's Ranking, each held to its own rules and filled down within its own
  // type. A Covered Call entry waits while free round lots are still uncovered, unless it buys every share.
  type EntryKind = "put" | "covered_call";
  const entryKindLabel: Record<EntryKind, string> = { put: "put", covered_call: "Covered Call" };
  const entryKindPlural: Record<EntryKind, string> = { put: "puts", covered_call: "Covered Calls" };
  // With the ladder, the entries' room: the shares' budget less the shares held at cost and the open puts' collateral.
  const ladderEntryRoomDollars = () => (ladderState === null ? Number.POSITIVE_INFINITY : ladderBudget(ladderBase(ladderState, book.accountValueToday(), book.tickerWeight()), baseline.ladderSharesPct).sharesBudget - heldSharesCostToday() - book.openPutCollateral());
  // Room for the Covered Call entries' shares under maxSharesPctOfAccount, in round lots at today's fill (unbounded at 100).
  const shareCapLots = (kind: EntryKind) => {
    if (kind === "covered_call" && ladderState !== null) return ladderShareLots(ladderEntryRoomDollars(), stockFillToday);
    if (kind !== "covered_call" || baseline.maxSharesPctOfAccount >= 100) return Number.POSITIVE_INFINITY;
    const room = (book.accountValueToday() * baseline.maxSharesPctOfAccount) / 100 - book.heldSharesToday() * stockPrice;
    return room > 0 ? Math.floor(room / (stockFillToday * sharesPerContract)) : 0;
  };
  const buyEveryShare = baseline.entryWhenSharesUncovered === "buy";
  const floorAfterPurchase = baseline.entryCallStrike === "above_average_after_purchase";
  // The average once `contracts` more lots are bought at today's fill (the fill itself when none are held).
  const averageCostAfterBuying = (contracts: number) => {
    const averageCost = book.heldSharesAverageCostToday();
    const sharesHeld = book.heldSharesToday();
    return averageCost === null || !(sharesHeld > 0) ? stockFillToday : (sharesHeld * averageCost + contracts * sharesPerContract * stockFillToday) / (sharesHeld + contracts * sharesPerContract);
  };
  /** Whether an entry of the kind may be made at this look: a Covered Call not while free lots wait for a call (unless it buys every share), a put not once the ladder's shares budget is used. */
  const entryAllowed = (kind: EntryKind) => (kind === "covered_call" ? uncoveredLots < 1 || buyEveryShare : ladderEntryRoomDollars() > 0);
  /** An entry kind's candidates under its rules: a Covered Call's lowest strike from the Entry call strike setting. */
  const entryCandidatesOf = (kind: EntryKind) => {
    // Selection takes the lowest the average after the purchase can be (today's fill or the average now); each candidate is then held to its own.
    const heldAverageNow = kind === "covered_call" && floorAfterPurchase ? book.heldSharesAverageCostToday() : null;
    const minimumStrike = kind === "put" ? null : baseline.entryCallStrike === "above_purchase_price" ? stockFillToday : floorAfterPurchase ? Math.min(stockFillToday, heldAverageNow ?? stockFillToday) : null;
    const right: "C" | "P" = kind === "put" ? "P" : "C";
    return { kind, right, minimumStrike, ...select(right, minimumStrike) };
  };
  const rankOf = (candidate: BaselineCandidate) => baselineCandidateRank(candidate, baseline.ranking === "edge_yield" ? undefined : baseline.ranking, baseline.ranking === "edge_yield");
  const formatRank = (value: number) => (baseline.ranking === "premium_yield" || baseline.ranking === "edge_yield" ? `${(value * 100).toFixed(1)}%` : value.toFixed(2));
  const enterWithFreeCash = () => {
    const kinds = (baseline.entry === "higher_yield" ? (["put", "covered_call"] as const) : [baseline.entry]).filter(entryAllowed);
    if (kinds.length === 0) return;
    // The drop-risk filters: no new entry while the stock is stretched or its IV Rank is high (the cash waits).
    if (input.entryBlockedBecause) {
      notes.push(`${symbol}: no new entry (${input.entryBlockedBecause})`);
      input.noteNoSale?.("entry_filter");
      return;
    }
    const options = kinds.map(entryCandidatesOf);
    const withCandidates = options.filter((option) => option.candidates.length > 0);
    if (withCandidates.length === 0) {
      for (const option of options) {
        notes.push(`${symbol}: no ${option.kind === "put" ? "put" : "new Covered Call"} (${describeRejections(option.rejections) || "no quotes"})`);
        input.noteNoCandidate?.({ order: "entry", right: option.right, rejections: option.rejections, rules: option.describeRules?.() ?? null });
        // Lots the Covered Call entries had cash and room for (a put entry's depend on a strike: unknown).
        const wanted = option.kind === "covered_call" ? Math.min(Math.floor(book.freeCash() / (stockFillToday * sharesPerContract)), shareCapLots("covered_call")) : null;
        if (wanted === null || wanted >= 1) noteOrderShortfall({ step: "entry", right: option.right, wanted, filled: 0, unsold: wanted, cashCut: false, anyCandidate: false, best: null });
      }
      return;
    }
    // With both kinds open, the one whose best contract ranks higher (a tie: the put); its order then runs as that entry's.
    const ranked = withCandidates.map((option) => ({ option, best: bestOf(option.candidates) })).filter((entry) => entry.best !== null);
    if (ranked.length === 0) return;
    ranked.sort((a, b) => rankOf(b.best!) - rankOf(a.best!));
    const { kind, right: entryRight, minimumStrike: entryMinimumStrike, candidates } = ranked[0]!.option;
    const coveredCallEntry = kind === "covered_call";
    const runnerUp = ranked[1] ?? null;
    // The kinds' contest is between their best contracts: the one sold can be a later one (the best did not fit).
    const comparedWith = runnerUp ? ` (${entryKindPlural[kind]} over ${entryKindPlural[runnerUp.option.kind]}: the best ${entryKindLabel[kind]}'s ${formatRank(rankOf(ranked[0]!.best!))} against the best ${entryKindLabel[runnerUp.option.kind]}'s ${formatRank(rankOf(runnerUp.best!))})` : "";
    const entryLimitsFor = (candidate: BaselineCandidate) => {
      const byCash = baselineContractsForCash(book.freeCash(), candidate, kind, stockFillToday, commissions);
      let byRoom = Number.POSITIVE_INFINITY;
      if (baseline.maxAccountPctPerStock < 100) {
        const exposure = book.openPositionsCapitalAtRisk();
        const room = (book.netLiquidationValue() * baseline.maxAccountPctPerStock) / 100 - exposure;
        const perContract = ((kind === "put" ? candidate.strike : stockFillToday) - candidate.fillPrice) * sharesPerContract;
        byRoom = room > 0 && perContract > 0 ? Math.floor(room / perContract) : 0;
      }
      // With the ladder, a Cash-Secured Put entry's collateral (strike × 100 a contract) fits the entries' room.
      const byLadderRoom = !coveredCallEntry && ladderState !== null ? ladderShareLots(ladderEntryRoomDollars(), candidate.strike) : Number.POSITIVE_INFINITY;
      return { byCash, byRoom: Math.min(byRoom, shareCapLots(kind), byLadderRoom), byVolume: candidate.volumeCap };
    };
    // The order wants what the room holds (the shares' cap, maxAccountPctPerStock); with neither, what the cash pays for.
    const best = bestOf(candidates);
    const bestLimits = best === null ? null : entryLimitsFor(best);
    const wanted = bestLimits === null ? null : Number.isFinite(bestLimits.byRoom) ? bestLimits.byRoom : bestLimits.byCash;
    const entrySharesAverageCost: Record<string, number | null> = coveredCallEntry ? { sharesAverageCostBefore: book.heldSharesAverageCostToday(), stockPriceAtLook: stockPrice } : {};
    let entriesMade = 0;
    let contractsSold = 0;
    let cashCut = false;
    let belowAverageAfterPurchase = 0;
    for (const candidate of fillDown ? candidates : candidates.slice(0, 1)) {
      if (book.isHeld(candidate)) continue;
      // A later candidate can still fit when this one does not: its fill may leave less to pay per contract.
      const limits = entryLimitsFor(candidate);
      const contracts = Math.min(limits.byCash, limits.byRoom, limits.byVolume);
      cashCut ||= Number.isFinite(limits.byRoom) && limits.byCash < Math.min(limits.byRoom, limits.byVolume);
      if (contracts < 1) continue;
      const costFloor = coveredCallEntry && floorAfterPurchase ? averageCostAfterBuying(contracts) : entryMinimumStrike;
      if (coveredCallEntry && floorAfterPurchase && candidate.strike < costFloor! - 1e-9) {
        belowAverageAfterPurchase++;
        continue;
      }
      book.sell(kind === "put" ? "cash_secured_put" : "covered_call", candidate, contracts, candidates.length, `baseline: the ${entryKindLabel[kind]} with the highest ${rankingLabel}${entriesMade > 0 ? " (next in order: the volume limit of the ones before)" : comparedWith}`, costFloor === null ? null : { name: "costFloor", value: costFloor }, coveredCallEntry && buyEveryShare, { ...orderScores(wanted, candidates, candidate, best), ...entrySharesAverageCost }, "entry");
      entriesMade++;
      contractsSold += contracts;
    }
    if (wanted !== null && wanted >= 1) noteOrderShortfall({ step: "entry", right: entryRight, wanted, filled: contractsSold, unsold: Math.max(0, wanted - contractsSold), cashCut, anyCandidate: true, best });
    if (entriesMade === 0 && belowAverageAfterPurchase > 0) notes.push(`${symbol}: no new Covered Call at or above the average after the purchase (${belowAverageAfterPurchase} below it)`);
  };
  enterWithFreeCash();

  // 3. The put ladder: held lots without a call and no call qualifying, in a cycle (unless its put was sold before the calls).
  if (ladderReady && !anyCallCandidate && !ladderPutChosen) {
    const plan = planLadderPuts();
    if (plan) sellLadderPuts(plan, "no call qualifies");
  }
}
