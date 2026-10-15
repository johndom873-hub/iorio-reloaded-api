import { valueContract, yieldOnExposure } from "../../lib/contractValuation.js";
import type { OpenCycleSummary } from "../../lib/cycleBreakEven.js";
import { blackScholesDelta, forwardAtSpot, impliedVolatilityFromPrice, parityImpliedForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry } from "../../lib/optionContractLabel.js";
import { frictionDollarsPerContract } from "../../lib/signalCandidates.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import type { ModelVolatilityForecast } from "../../lib/volatilityEdge.js";
import type { ValuationGroup, VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import type { BacktestBaselineSettings, BacktestOrderShortfall } from "../backtestTypes.js";
import { ladderBase, ladderBudget, ladderRungPaceBlock, ladderRungToday, ladderShareLots, noteLadderRungSold, type LadderCycleState } from "./backtestBaselineLadder.js";
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
    if (dte < input.settings.minDte || dte > input.settings.maxDte) {
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
    if (quote.bid === null || quote.ask === null || quote.bid < baselineMinimumBid || !(quote.ask > quote.bid)) {
      rejections.noUsableQuote++;
      continue;
    }
    const mid = (quote.bid + quote.ask) / 2;
    if ((quote.ask - quote.bid) / mid > input.settings.maxSpreadPctOfMid / 100) {
      rejections.spreadTooWide++;
      continue;
    }
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
    const fillPrice = computeSaleFillPrice(quote.bid, quote.ask, input.spreadShareCharged);
    const intrinsicValue = isCall ? Math.max(input.stockPrice - quote.strike, 0) : Math.max(quote.strike - input.stockPrice, 0);
    const timeValue = fillPrice - intrinsicValue;
    const capitalPerShare = (isCall ? input.stockPrice : quote.strike) - fillPrice;
    const earnedDollars = timeValue * sharesPerContract - optionCommissionPerContract(input.commissions);
    if (!(earnedDollars > 0) || !(capitalPerShare > 0)) {
      rejections.noTimeValue++;
      continue;
    }
    const premiumYield = yieldOnExposure(earnedDollars, capitalPerShare * sharesPerContract, Math.max(yearsToExpiry, minimumAnnualizationYears));
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
          frictionDollars: frictionDollarsPerContract(quote.bid, quote.ask, input.spreadShareCharged, optionCommissionPerContract(input.commissions)),
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
      bid: quote.bid,
      ask: quote.ask,
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
  const rankOf = (candidate: BaselineCandidate) => {
    if (input.model?.rankByEdgeYield) return candidate.edgeYield!;
    if (input.ranking === "time_value") return candidate.timeValue;
    if (input.ranking === "premium_dollars") return candidate.fillPrice;
    if (input.ranking === "premium_per_day") return candidate.fillPrice / Math.max(candidate.dte, 1);
    return candidate.premiumYield;
  };
  candidates.sort((a, b) => (input.nearestExpiryFirst ? a.expiry.localeCompare(b.expiry) : 0) || rankOf(b) - rankOf(a) || a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
  return { candidates, rejections };
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

/** Contracts the free cash pays for: a put reserves its strike and brings its fill in; a buy-write pays the shares less the fill. */
export function baselineContractsForCash(freeCash: number, candidate: Pick<BaselineCandidate, "strike" | "fillPrice">, entry: "put" | "buy_write", stockFillPrice: number, commissions: BaselineCommissions): number {
  const optionCommission = optionCommissionPerContract(commissions);
  const perContract = entry === "put" ? (candidate.strike - candidate.fillPrice) * sharesPerContract + optionCommission : (stockFillPrice - candidate.fillPrice) * sharesPerContract + optionCommission + stockCommissionPerLot(commissions);
  return perContract > 0 ? Math.max(0, Math.floor(freeCash / perContract)) : 0;
}

export type BaselineSelect = (right: "C" | "P", minimumStrike?: number | null, forEntry?: boolean, maximumStrike?: number | null, byPremiumYield?: boolean) => { candidates: BaselineCandidate[]; rejections: BaselineRejections };

/** A symbol's candidate selection at a look: entries on the baseline's ranges, calls on held shares on theirs (callDeltaRange). */
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
  const callsSettings = baseline.callDeltaRange === "own_range" ? { ...baseline, minAbsDelta: baseline.callMinAbsDelta, maxAbsDelta: baseline.callMaxAbsDelta } : baseline;
  // Calls (on held shares and new Covered Calls) only above minCallYieldPct; a put ranked by premium yield alone when asked.
  const minimumCallYield = baseline.minCallYieldPct > 0 ? baseline.minCallYieldPct / 100 : null;
  return (right: "C" | "P", minimumStrike: number | null = null, forEntry = true, maximumStrike: number | null = null, byPremiumYield = false) =>
    selectBaselineCandidates({ quotes, forwardAnchors, commissions, right, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate, previousSessionVolumeByContract: previousSessionVolumeByContract, settings: forEntry ? baseline : callsSettings, spreadShareCharged, isHeld, minimumStrike, maximumStrike, minimumPremiumYield: right === "C" ? minimumCallYield : null, ...(earningsDatesIso ? { earningsDatesIso } : {}), model: byPremiumYield && model ? { ...model, rankByEdgeYield: false } : forEntry ? model : callsModel, ...(byPremiumYield ? { ranking: "premium_yield" as const } : baseline.ranking !== "edge_yield" ? { ranking: baseline.ranking } : {}), nearestExpiryFirst: !byPremiumYield && baseline.expiryChoice === "nearest_qualifying" });
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
  /** One sale: the backtest fills it at once, live places it as an order. */
  sell(strategyKey: "cash_secured_put" | "covered_call", candidate: BaselineCandidate, contracts: number, eligibleCount: number, chosenBecause: string, strikeLimit?: { name: "costFloor" | "costCeiling"; value: number | null } | null, buyEveryShare?: boolean, extraScores?: Record<string, number | null>): void;
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
}

/** An order that left contracts unsold, without the look's own facts (its time and symbol). */
export type BaselineOrderShortfall = Omit<BacktestOrderShortfall, "tradingDate" | "at" | "lookTimeEt" | "symbol" | "lookCount">;

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
  // "above_average_cost_else_break_even", the average price held first, then the cycle's break-even for the lots left.
  const callFloors: { floor: number | null; label: string }[] = [];
  if (freeLots >= 1 && baseline.callStrike !== "none") {
    const onTodaysScale = (perShareOnCycleScale: number | null) => (perShareOnCycleScale === null ? Number.POSITIVE_INFINITY : perShareOnCycleScale / priceToCycleScale);
    const cycle = baseline.callStrike === "delta_range" || baseline.callStrike === "above_latest_entry" || baseline.callStrike === "above_average_cost" ? null : book.openCycleSummary();
    if (baseline.callStrike === "delta_range") callFloors.push({ floor: null, label: "" });
    else if (baseline.callStrike === "above_latest_entry") callFloors.push({ floor: onTodaysScale(book.latestShareAcquisitionPrice()), label: "" });
    else if (baseline.callStrike === "above_average_cost") callFloors.push({ floor: onTodaysScale(book.heldSharesAverageCost()), label: "" });
    else if (baseline.callStrike === "above_share_cost") callFloors.push({ floor: onTodaysScale(cycle && cycle.sharesAcquired > 0 ? cycle.acquisitionCost / cycle.sharesAcquired : null), label: "" });
    else if (baseline.callStrike === "above_break_even") callFloors.push({ floor: onTodaysScale(cycle?.breakEvenPerShare ?? null), label: "" });
    else {
      callFloors.push({ floor: onTodaysScale(book.heldSharesAverageCost()), label: " at or above the average price held" });
      if (cycle?.breakEvenPerShare != null) callFloors.push({ floor: onTodaysScale(cycle.breakEvenPerShare), label: " at or above the break-even (none at or above the average)" });
    }
  }
  // The ladder put, planned for today's rung (null when the ladder cannot sell one now: no cycle, no rung, one open).
  const ladderReady = ladderState !== null && ladderState.startedOn !== null && baseline.ladderPace !== "no_puts" && freeLots >= 1;
  const planLadderPuts = () => {
    if (!ladderState) return null;
    const cycle = book.openCycleSummary();
    const breakEven = cycle?.breakEvenPerShare == null ? null : cycle.breakEvenPerShare / priceToCycleScale;
    const rung = ladderRungToday({ settings: baseline, state: ladderState, accountValueToday: book.accountValueToday(), tickerWeight: book.tickerWeight(), breakEven, stockPrice, heldSharesCost: heldSharesCostToday(), openPutCollateral: book.openPutCollateral(), priceToCycleScale });
    if (baseline.ladderPace === "one_open" && book.openPutCollateral() > 0) return { rung, blocked: `${symbol}: no new ladder put while one is open`, candidates: [] as BaselineCandidate[], rejections: null };
    const paceBlock = ladderRungPaceBlock(baseline, ladderState, atMs, todayIso);
    if (paceBlock !== null) return { rung, blocked: `${symbol}: ${paceBlock}`, candidates: [] as BaselineCandidate[], rejections: null };
    if (rung.cap === null) return { rung, blocked: `${symbol}: no ladder put (${rung.note})`, candidates: [] as BaselineCandidate[], rejections: null };
    const { candidates, rejections } = select("P", null, true, rung.cap, true);
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
      book.sell("cash_secured_put", candidate, contracts, plan.candidates.length, `baseline: the ladder put with the highest premium yield (${why}), strike at most ${cap.toFixed(2)}${putsSold > 0 ? " (next in order: the volume limit of the ones before)" : ""}`, { name: "costCeiling", value: cap }, false, { ...plan.rung.scores, ...orderScores(wanted, plan.candidates, candidate, best) });
      collateralLeft -= contracts * candidate.strike * sharesPerContract;
      putsSold++;
      contractsSold += contracts;
    }
    noteOrderShortfall({ step: "ladder_put", right: "P", wanted, filled: contractsSold, unsold: contractsOfBest(collateralLeft), cashCut, anyCandidate: plan.candidates.length > 0, best });
    if (putsSold > 0 && ladderState) noteLadderRungSold(ladderState, atMs, todayIso);
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
      for (const { floor } of callFloors) {
        bestCall = select("C", floor, false).candidates.find((candidate) => !book.isHeld(candidate)) ?? null;
        if (bestCall) break;
      }
      const marginFactor = 1 + baseline.ladderPutYieldMarginPct / 100;
      if (bestCall === null || bestPut.premiumYield > bestCall.premiumYield * marginFactor) {
        ladderPutChosen = true;
        sellLadderPuts(plan, bestCall === null ? "no call qualifies" : `its yield ${(bestPut.premiumYield * 100).toFixed(1)}% beats the best call's ${(bestCall.premiumYield * 100).toFixed(1)}% by more than ${baseline.ladderPutYieldMarginPct}%`);
      }
    }
  }

  let lastCallRejections: BaselineRejections | null = null;
  let anyCallCandidate = false;
  // The order wants a call on every free lot; its best candidate is the first floor's. A Call order also records the
  // shares' average cost before it and the look's stock price (the Analyse window's largest pot).
  let heldCallsBest: BaselineCandidate | null = null;
  const heldCallsSharesAverageCost = book.heldSharesAverageCostToday();
  for (const { floor, label } of ladderPutChosen ? [] : callFloors) {
    if (uncoveredLots < 1) break;
    const { candidates, rejections } = select("C", floor, false);
    lastCallRejections = rejections;
    anyCallCandidate ||= candidates.length > 0;
    heldCallsBest ??= bestOf(candidates);
    let soldAtThisFloor = 0;
    for (const candidate of fillDown ? candidates : candidates.slice(0, 1)) {
      if (uncoveredLots < 1) break;
      if (book.isHeld(candidate)) continue;
      const contracts = Math.min(uncoveredLots, candidate.volumeCap);
      book.sell("covered_call", candidate, contracts, candidates.length, `baseline: the call with the highest ${rankingLabel}${label} on the free shares${fillDown && soldAtThisFloor > 0 ? " (next in order: the volume limit of the ones before)" : ""}`, floor === null ? null : { name: "costFloor", value: floor }, false, { ...orderScores(freeLots, candidates, candidate, heldCallsBest), sharesAverageCostBefore: heldCallsSharesAverageCost, stockPriceAtLook: stockPrice });
      uncoveredLots -= contracts;
      soldAtThisFloor += 1;
    }
  }
  if (!ladderPutChosen && callFloors.length > 0) noteOrderShortfall({ step: "held_calls", right: "C", wanted: freeLots, filled: freeLots - uncoveredLots, unsold: uncoveredLots, cashCut: false, anyCandidate: anyCallCandidate, best: heldCallsBest });
  // When the ladder put was chosen over the calls, they were quoted and lost: the put's own line says why.
  if (callFloors.length > 0 && !anyCallCandidate && !ladderPutChosen) notes.push(`${symbol}: no call for ${freeLots * sharesPerContract} free shares (${(lastCallRejections && describeRejections(lastCallRejections)) || "no quotes"})`);

  // 2. The entry with the free cash. A buy-write waits while free round lots are still uncovered, unless it buys every share.
  const buyWrite = baseline.entry === "buy_write";
  // Room for the buy-writes' shares under maxSharesPctOfAccount, in round lots at today's fill (unbounded at 100).
  const shareCapLots = () => {
    if (buyWrite && ladderState !== null) return ladderShareLots(ladderBudget(ladderBase(ladderState, book.accountValueToday(), book.tickerWeight()), baseline.ladderSharesPct).sharesBudget - heldSharesCostToday() - book.openPutCollateral(), stockFillToday);
    if (!buyWrite || baseline.maxSharesPctOfAccount >= 100) return Number.POSITIVE_INFINITY;
    const room = (book.accountValueToday() * baseline.maxSharesPctOfAccount) / 100 - book.heldSharesToday() * stockPrice;
    return room > 0 ? Math.floor(room / (stockFillToday * sharesPerContract)) : 0;
  };
  /** True when a buy-write had cash and room for a round lot and sold none (no call passed, the yield threshold included). */
  const enterWithFreeCash = (): boolean => {
    const buyEveryShare = buyWrite && baseline.entryWhenSharesUncovered === "buy";
    if (buyWrite && uncoveredLots >= 1 && !buyEveryShare) return false;
    const roomForALot = buyWrite && Math.min(Math.floor(book.freeCash() / (stockFillToday * sharesPerContract)), shareCapLots()) >= 1;
    const entryRight = baseline.entry === "put" ? "P" : "C";
    const floorAfterPurchase = buyWrite && baseline.entryCallStrike === "above_average_after_purchase";
    // The average once `contracts` more lots are bought at today's fill (the fill itself when none are held).
    const averageCostAfterBuying = (contracts: number) => {
      const averageCost = book.heldSharesAverageCostToday();
      const sharesHeld = book.heldSharesToday();
      return averageCost === null || !(sharesHeld > 0) ? stockFillToday : (sharesHeld * averageCost + contracts * sharesPerContract * stockFillToday) / (sharesHeld + contracts * sharesPerContract);
    };
    // Selection takes the lowest the average after the purchase can be (today's fill or the average now); each candidate is then held to its own.
    const heldAverageNow = floorAfterPurchase ? book.heldSharesAverageCostToday() : null;
    const entryMinimumStrike = !buyWrite ? null : baseline.entryCallStrike === "above_purchase_price" ? stockFillToday : floorAfterPurchase ? Math.min(stockFillToday, heldAverageNow ?? stockFillToday) : null;
    const { candidates, rejections } = select(entryRight, entryMinimumStrike);
    if (candidates.length === 0) {
      notes.push(`${symbol}: no ${baseline.entry === "put" ? "put" : "new Covered Call"} (${describeRejections(rejections) || "no quotes"})`);
      // Lots the buy-writes had cash and room for (a put entry's depend on a strike: unknown).
      const wanted = buyWrite ? Math.min(Math.floor(book.freeCash() / (stockFillToday * sharesPerContract)), shareCapLots()) : null;
      if (wanted === null || wanted >= 1) noteOrderShortfall({ step: "entry", right: entryRight, wanted, filled: 0, unsold: wanted, cashCut: false, anyCandidate: false, best: null });
      return roomForALot;
    }
    const entryLimitsFor = (candidate: BaselineCandidate) => {
      const byCash = baselineContractsForCash(book.freeCash(), candidate, baseline.entry, stockFillToday, commissions);
      let byRoom = Number.POSITIVE_INFINITY;
      if (baseline.maxAccountPctPerStock < 100) {
        const exposure = book.openPositionsCapitalAtRisk();
        const room = (book.netLiquidationValue() * baseline.maxAccountPctPerStock) / 100 - exposure;
        const perContract = ((baseline.entry === "put" ? candidate.strike : stockFillToday) - candidate.fillPrice) * sharesPerContract;
        byRoom = room > 0 && perContract > 0 ? Math.floor(room / perContract) : 0;
      }
      return { byCash, byRoom: Math.min(byRoom, shareCapLots()), byVolume: candidate.volumeCap };
    };
    // The order wants what the room holds (the shares' cap, maxAccountPctPerStock); with neither, what the cash pays for.
    const best = bestOf(candidates);
    const bestLimits = best === null ? null : entryLimitsFor(best);
    const wanted = bestLimits === null ? null : Number.isFinite(bestLimits.byRoom) ? bestLimits.byRoom : bestLimits.byCash;
    const entrySharesAverageCost: Record<string, number | null> = buyWrite ? { sharesAverageCostBefore: book.heldSharesAverageCostToday(), stockPriceAtLook: stockPrice } : {};
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
      const costFloor = floorAfterPurchase ? averageCostAfterBuying(contracts) : entryMinimumStrike;
      if (floorAfterPurchase && candidate.strike < costFloor! - 1e-9) {
        belowAverageAfterPurchase++;
        continue;
      }
      book.sell(baseline.entry === "put" ? "cash_secured_put" : "covered_call", candidate, contracts, candidates.length, `baseline: the ${baseline.entry === "put" ? "put" : "Covered Call"} with the highest ${rankingLabel}${entriesMade > 0 ? " (next in order: the volume limit of the ones before)" : ""}`, costFloor === null ? null : { name: "costFloor", value: costFloor }, buyEveryShare, { ...orderScores(wanted, candidates, candidate, best), ...entrySharesAverageCost });
      entriesMade++;
      contractsSold += contracts;
    }
    if (wanted !== null && wanted >= 1) noteOrderShortfall({ step: "entry", right: entryRight, wanted, filled: contractsSold, unsold: Math.max(0, wanted - contractsSold), cashCut, anyCandidate: true, best });
    if (entriesMade === 0 && belowAverageAfterPurchase > 0) notes.push(`${symbol}: no new Covered Call at or above the average after the purchase (${belowAverageAfterPurchase} below it)`);
    return entriesMade === 0 && roomForALot;
  };
  const buyWriteFoundNoCall = enterWithFreeCash();

  // 3. One put when no call was sold (held lots left without one, or a buy-write with room found none), while none is open.
  if (buyWrite && baseline.putsWhenNoCall === "dte_budget" && (uncoveredLots >= 1 || buyWriteFoundNoCall)) {
    const putOpen = book.hasOpenCashSecuredPut();
    if (putOpen) notes.push(`${symbol}: no new put while one is open`);
    else {
      const averageNow = book.heldSharesAverageCostToday();
      const { candidates, rejections } = select("P", null, true, averageNow, true);
      const accountValue = book.accountValueToday();
      const budgetOf = (candidate: BaselineCandidate) => {
        const budget = ((accountValue * baseline.putBudgetPctPerDte) / 100) * candidate.dte;
        const exposurePerContract = (candidate.strike - candidate.fillPrice) * sharesPerContract;
        return { budget, byBudget: exposurePerContract > 0 ? Math.floor(budget / exposurePerContract) : 0 };
      };
      const best = bestOf(candidates);
      const wanted = best === null ? null : budgetOf(best).byBudget;
      let putSold = false;
      let contractsSold = 0;
      let cashCut = false;
      for (const candidate of candidates) {
        if (book.isHeld(candidate)) continue;
        const { budget, byBudget } = budgetOf(candidate);
        const byCash = baselineContractsForCash(book.freeCash(), candidate, "put", stockFillToday, commissions);
        const contracts = Math.min(byBudget, byCash, candidate.volumeCap);
        cashCut ||= byCash < Math.min(byBudget, candidate.volumeCap);
        if (contracts < 1) continue;
        book.sell("cash_secured_put", candidate, contracts, candidates.length, `baseline: the put with the highest premium yield (no call sold), ${baseline.putBudgetPctPerDte}% of the account per day to expiry`, { name: "costCeiling", value: averageNow }, false, { putBudgetDollars: budget, accountValue, ...orderScores(wanted, candidates, candidate, best) });
        putSold = true;
        contractsSold = contracts;
        break;
      }
      noteOrderShortfall({ step: "budget_put", right: "P", wanted, filled: contractsSold, unsold: wanted === null ? null : Math.max(0, wanted - contractsSold), cashCut, anyCandidate: candidates.length > 0, best });
      if (!putSold) notes.push(`${symbol}: no put (${candidates.length > 0 ? `${candidates.length} within the rules, none fits the budget or the cash` : describeRejections(rejections) || "no quotes"})`);
    }
  }

  // 4. The put ladder: held lots without a call and no call qualifying, in a cycle (unless its put was sold before the calls).
  if (ladderReady && !anyCallCandidate && !ladderPutChosen) {
    const plan = planLadderPuts();
    if (plan) sellLadderPuts(plan, "no call qualifies");
  }
}
