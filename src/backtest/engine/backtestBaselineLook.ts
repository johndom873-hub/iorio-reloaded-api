import { valueContract, yieldOnExposure } from "../../lib/contractValuation.js";
import { blackScholesDelta, impliedVolatilityFromPrice, parityImpliedForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { frictionDollarsPerContract } from "../../lib/signalCandidates.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { regularCloseMinutesEt, varianceSessionsToExpiry } from "../../lib/varianceClock.js";
import { selectModelVolatilityForecast, type ModelVolatilityForecast } from "../../lib/volatilityEdge.js";
import type { ValuationGroup, VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import { openCandidateId } from "../../pluto/candidateFilters.js";
import type { BacktestAction, BacktestBaselineSettings } from "../backtestTypes.js";
import { toOhlcvBars } from "./backtestBarHistory.js";
import { ladderBase, ladderBudget, ladderRungPaceBlock, ladderRungToday, ladderShareLots, noteLadderLook, noteLadderRungSold } from "./backtestBaselineLadder.js";
import { computeSaleFillPrice, sharesPerContract } from "./backtestBook.js";
import type { BacktestLookContext, BacktestLookResult, BacktestOptionSale } from "./backtestLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { captureLookTimeEt, earningsNotYetReported, forecastBarRowCount, lookInstantMs } from "./backtestTickerInputs.js";
import { buyBackCoveredCallKeepingShares, buyBackPut, closeCoveredCall, openCashSecuredPut, openCoveredCall, sellShares } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, optionPurchaseFillPrice, stockCommissionDollars, stockPurchaseFillPrice, stockSaleFillPrice } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerFreeCash, ledgerFreeShares, ledgerHeldSharesAverageCost, ledgerLatestShareAcquisitionPrice, ledgerNetLiquidationValue, ledgerOpenCycleSummary } from "./ledger/ledgerSelectors.js";
import { cycleSplitFactorFor, legsOfPosition, positionsOfSymbol, requireLeg } from "./ledger/simulatedLedger.js";

// The baseline wheel's look (decision maker "baseline", approved by Marcelo 2026-10-13): none of Pluto's rules and none
// of the Signals model, so each can later be added back and measured. At every look, for every symbol:
//   −1. with a share stop (shareStopLossPct > 0), once the price is that far below the cycle's cost per share acquired,
//      every share of the stock is sold at the look's price, a covered call closed whole (its call bought back);
//   0. with profit-taking on (takeProfitPct > 0), every open short option whose buyback keeps at least that share of its
//      premium (1 − buyback fill ÷ entry price, the entry net of its commission) is bought back; a covered call's call
//      alone, its shares kept. The contract is not sold again at the same look;
//   1. free round lots of shares get a call: the contract with the highest premium yield in the expiry range and the
//      calls' delta range (callDeltaRange: the entry's, or their own), by callStrike: any strike, or only at or above the
//      cycle's cost per share acquired, or its break-even after its premium, or the latest share acquisition's price, or
//      the average price paid for the shares held (ledgerHeldSharesAverageCost); on as many lots as the volume limit
//      allows. With callStrike "none", no call: the shares are held uncovered;
//   2. free cash goes into the entry with the highest premium yield in the same ranges: a cash-secured put, or 100
//      shares bought with a call sold on them (a buy-write; with entryCallStrike "above_purchase_price", the call at or
//      above the price paid for the shares; with "above_average_after_purchase", at or above the average price of the
//      shares held once these are bought), as many contracts as the cash, the stock's share of the account
//      (maxAccountPctPerStock: its open positions' capital at risk, net of premium), the shares' cap
//      (maxSharesPctOfAccount: the shares held at the 10:00 price, against the day's account value) and the volume limit
//      allow. A buy-write waits while held round lots have no call, unless entryWhenSharesUncovered is "buy": it then buys
//      every share its call covers and the uncovered lots keep waiting for their own;
//   3. with putsWhenNoCall "dte_budget" (a buy-write entry), when step 1 left held lots without a call or step 2 had room
//      for a lot and sold no buy-write, and no put of the stock is open: one put, the highest premium yield, strike at
//      most the average price of the shares held (any with none held), as many contracts as putBudgetPctPerDte% of the
//      day's account value × days to expiry (its exposure, (strike − fill) × 100 a contract), the free cash and the volume
//      limit allow (approved by Marcelo 2026-10-13). An assignment may take the shares past their cap.
// With minCallYieldPct > 0, a call (step 1 or a buy-write's) is sold only when its premium yield is above that.
// The day's account value for sizing is the session's: open options at zero when dayValueOptions is "excluded".
// With earnings "skip_spanning", no sale whose expiry spans a known earnings date (today ≤ report ≤ expiry); with looks
// "first_look", the session asks only at 10:00. With volatilityEdgeFilter "entries" (or "all_sales"), a new entry (or any
// sale, the calls on held shares too) is sold only when its volatility edge is at least minVolatilityEdgePoints; with
// ranking "edge_yield", "time_value" or "premium_dollars", the candidates are picked by that instead of their premium
// yield; with expiryChoice "nearest_qualifying", from the nearest expiry that has any first. With coverage
// "fill_down_ranking", what the best contract's volume limit leaves goes to the next candidates in that order.
// Everything is held to expiry; the session settles it (assignment, call-away) as for any session.
//
//   delta          = Black-76 delta at the quote's own implied volatility (from its mid), on the expiry's put-call parity
//                    forward (spot × e^{rT} when no strike has a usable pair); T = calendar days to expiry ÷ 365, and for
//                    an option expiring on the look's day the hours from the look to that day's close ÷ 8,760
//                    (approved by Marcelo 2026-10-15: at 10:00 on a 16:00 close, 6 ÷ 8,760)
//   fill           = mid − λ × half-spread (the session's fill rule)
//   premium yield  = (fill − intrinsic value) × 100 − commission, ÷ capital at risk, ÷ max(T, 1 day): a sale expiring
//                    on the look's day counts one day, as its cash or shares stay committed until the next morning's settlement
//                    capital at risk = (strike − fill) × 100 for a put, (spot − fill) × 100 for a call
//   Out of the money this is the platform's premium yield after costs; in the money only the time value counts, as
//   the intrinsic value is not earned.
//   volatility edge = √(252 × σ_mid² × T ÷ τ) − σ_YZ21: the Signals model's implied volatility (the mid's total variance
//                    on the forecast's clock) less its forecast; τ = variance sessions from the look to the expiry's close
//                    (varianceClock.ts), σ_YZ21 from the daily bars before today
//   Edge Yield     = the Signals model's expected P&L after costs (contractValuation.ts, friction λ × half-spread × 100 +
//                    commission) ÷ capital at risk, annualized on calendar time
// Realism limits: bid at least $0.05, ask above bid, at most 20% of the contract's previous-session volume (fixed), and a
// spread at most maxSpreadPctOfMid of the mid (a setting, 15% by default).

export const baselineMinimumBid = 0.05;
export const baselineMaxVolumeShare = 0.2;
const minimumAnnualizationYears = 1 / 365;
const roundedStrike = (strike: number) => Math.round(strike * 10_000) / 10_000;

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

export interface BaselineCandidateInput {
  /** Every quote of the look (both rights; the parity forward reads both). */
  quotes: readonly SymbolFileQuote[];
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
  const forwardByExpiry = new Map<string, number>();
  const forwardOf = (expiry: string, yearsToExpiry: number) => {
    let forward = forwardByExpiry.get(expiry);
    if (forward === undefined) {
      const spotForward = input.stockPrice * Math.exp(input.riskFreeRate * yearsToExpiry);
      const expiryQuotes = input.quotes.filter((quote) => quote.expiry === expiry).map((quote) => ({ strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask }));
      forward = parityImpliedForward(expiryQuotes, spotForward, yearsToExpiry, input.riskFreeRate) ?? spotForward;
      forwardByExpiry.set(expiry, forward);
    }
    return forward;
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
    const earnedDollars = timeValue * sharesPerContract - optionCommissionDollars(1);
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
          frictionDollars: frictionDollarsPerContract(quote.bid, quote.ask, input.spreadShareCharged, optionCommissionDollars(1)),
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
function describeRejections(rejections: BaselineRejections): string {
  const labels: Record<keyof BaselineRejections, string> = { outsideExpiryRange: "expiry", noUsableQuote: "quote", spreadTooWide: "spread", tooLittleVolume: "volume", noImpliedVolatility: "IV", outsideDeltaRange: "delta", noTimeValue: "time value", alreadyHeld: "held", belowCost: "below cost", aboveCeiling: "above ceiling", belowMinimumYield: "yield", spansEarnings: "earnings", noForecast: "no forecast", belowVolatilityEdge: "IV not above forecast" };
  return (Object.entries(rejections) as [keyof BaselineRejections, number][])
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => `${labels[key]} ${count}`)
    .join(", ");
}

/** Contracts the free cash pays for: a put reserves its strike and brings its fill in; a buy-write pays the shares less the fill. */
export function baselineContractsForCash(freeCash: number, candidate: Pick<BaselineCandidate, "strike" | "fillPrice">, entry: "put" | "buy_write", stockFillPrice: number): number {
  const perContract = entry === "put" ? (candidate.strike - candidate.fillPrice) * sharesPerContract + optionCommissionDollars(1) : (stockFillPrice - candidate.fillPrice) * sharesPerContract + optionCommissionDollars(1) + stockCommissionDollars(sharesPerContract);
  return perContract > 0 ? Math.max(0, Math.floor(freeCash / perContract)) : 0;
}

export async function runBaselineLook(context: BacktestLookContext): Promise<BacktestLookResult> {
  const { settings, ledger, todayIso } = context;
  const baseline = settings.baseline;
  const lookTimeEt = context.lookTimeEt ?? captureLookTimeEt;
  const at = new Date(lookInstantMs(todayIso, lookTimeEt));
  // An option expiring today is priced on the hours left to today's close (13:00 on a half day).
  const closeMinutesEt = context.calendar.sessionsBetween(todayIso, todayIso)[0]?.closeMinutesEt ?? regularCloseMinutesEt;
  const [lookHours, lookMinutes] = lookTimeEt.split(":").map(Number);
  const yearsToTodaysClose = Math.max(0, closeMinutesEt - (lookHours! * 60 + lookMinutes!)) / 60 / 8760;
  const spreadShareCharged = settings.trading.spreadCostChargedPct / 100;
  const actions: BacktestAction[] = [];
  const optionSales: BacktestOptionSale[] = [];
  const summaries: string[] = [];

  for (const lookSymbol of context.symbols) {
    const symbol = lookSymbol.profile.symbol;
    if (!lookSymbol.optionContractsRepresentable) {
      summaries.push(`${symbol}: no option orders while the open cycle spans a split`);
      continue;
    }
    const quotes = lookSymbol.intraday?.quotes ?? lookSymbol.market.quotes;
    const stockPrice = lookSymbol.intraday?.stockPrice ?? lookSymbol.market.stockPrice;
    const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
    const cycleSplitFactor = cycleSplitFactorFor(ledger, symbol, lookSymbol.splitFactorToday, at);
    const priceToCycleScale = cycleSplitFactor / lookSymbol.splitFactorToday;
    const toCyclePrice = (price: number) => price * priceToCycleScale;
    const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
    const heldContracts = new Set(
      positionsOfSymbol(ledger, symbol)
        .filter((position) => position.status === "open")
        .flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.legType === "option" && leg.exitAt === null))
        .map((leg) => `${leg.expiryDate}|${Math.round((leg.strikePrice! / priceToCycleScale) * 10_000) / 10_000}`),
    );
    const heldKey = (contract: { expiry: string; strike: number }) => `${contract.expiry}|${Math.round(contract.strike * 10_000) / 10_000}`;
    const isHeld = (contract: { expiry: string; strike: number }) => heldContracts.has(heldKey(contract));
    const earningsDatesIso = baseline.earnings === "skip_spanning" && lookSymbol.profile.calendarChecksApply ? earningsNotYetReported(lookSymbol.profile.earnings, todayIso) : undefined;
    let model: BaselineModelInput | null = null;
    if (baseline.volatilityEdgeFilter !== "off" || baseline.ranking === "edge_yield") {
      const furthestExpiry = quotes.reduce<string | null>((furthest, quote) => (furthest === null || quote.expiry > furthest ? quote.expiry : furthest), null);
      const sessions = furthestExpiry === null ? [] : context.calendar.sessionsBetween(todayIso, furthestExpiry);
      const varianceSessionsByExpiry = new Map<string, number>();
      model = {
        tables: context.modelTables,
        group: lookSymbol.profile.valuationGroup,
        forecast: selectModelVolatilityForecast(toOhlcvBars(lookSymbol.bars.rowsBefore(todayIso, forecastBarRowCount))),
        varianceSessionsTo: (expiryIso) => {
          let varianceSessions = varianceSessionsByExpiry.get(expiryIso);
          if (varianceSessions === undefined) varianceSessionsByExpiry.set(expiryIso, (varianceSessions = varianceSessionsToExpiry(at.getTime(), expiryIso, sessions)));
          return varianceSessions;
        },
        minVolatilityEdge: baseline.volatilityEdgeFilter !== "off" ? baseline.minVolatilityEdgePoints / 100 : null,
        rankByEdgeYield: baseline.ranking === "edge_yield",
      };
    }
    // The calls on held shares are held to the margin only when every sale is.
    const callsModel = model && baseline.volatilityEdgeFilter === "entries" ? { ...model, minVolatilityEdge: null } : model;
    const callsSettings = baseline.callDeltaRange === "own_range" ? { ...baseline, minAbsDelta: baseline.callMinAbsDelta, maxAbsDelta: baseline.callMaxAbsDelta } : baseline;
    // Calls (on held shares and new Covered Calls) only above minCallYieldPct; a put ranked by premium yield alone when asked.
    const minimumCallYield = baseline.minCallYieldPct > 0 ? baseline.minCallYieldPct / 100 : null;
    const select = (right: "C" | "P", minimumStrike: number | null = null, forEntry = true, maximumStrike: number | null = null, byPremiumYield = false) =>
      selectBaselineCandidates({ quotes, right, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate, previousSessionVolumeByContract: lookSymbol.market.previousSessionVolumeByContract, settings: forEntry ? baseline : callsSettings, spreadShareCharged, isHeld, minimumStrike, maximumStrike, minimumPremiumYield: right === "C" ? minimumCallYield : null, ...(earningsDatesIso ? { earningsDatesIso } : {}), model: byPremiumYield && model ? { ...model, rankByEdgeYield: false } : forEntry ? model : callsModel, ...(byPremiumYield ? { ranking: "premium_yield" as const } : baseline.ranking !== "edge_yield" ? { ranking: baseline.ranking } : {}), nearestExpiryFirst: !byPremiumYield && baseline.expiryChoice === "nearest_qualifying" });
    // The day's account value for sizing: the session's own, open options at zero when it leaves them out.
    const accountValueToday = () =>
      ledgerNetLiquidationValue(ledger, baseline.dayValueOptions === "excluded" ? new Map([...context.priceByLegId].map(([legId, price]) => [legId, requireLeg(ledger, legId).legType === "option" ? 0 : price])) : context.priceByLegId);
    const rankingLabel = { premium_yield: "premium yield", edge_yield: "Edge Yield", time_value: "time value", premium_dollars: "premium", premium_per_day: "premium per day" }[baseline.ranking];
    const fillDown = baseline.coverage === "fill_down_ranking";
    let quoteIndex: Map<string, SymbolFileQuote> | null = null;
    const quoteOf = (contract: { expiry: string; strike: number; right: "C" | "P" }) => (quoteIndex ??= new Map(quotes.map((quote) => [contractKey({ expiry: quote.expiry, strike: roundedStrike(quote.strike), right: quote.right }), quote]))).get(contractKey(contract));
    // A buy-write's share price: the session's stock fill (10:00 price + $0.01), or the 10:00 price itself (shareFill).
    const shareFillPrice = (price: number) => (baseline.shareFill === "ten_oclock_price" ? price : stockPurchaseFillPrice(price));
    // On today's scale: the average price paid for the shares held (null when none), and how many are held.
    const heldSharesAverageCostToday = () => {
      const averageCost = ledgerHeldSharesAverageCost(ledger, symbol);
      return averageCost === null ? null : averageCost / priceToCycleScale;
    };
    const heldSharesToday = () =>
      positionsOfSymbol(ledger, symbol)
        .filter((position) => position.status === "open")
        .flatMap((position) => legsOfPosition(ledger, position.id))
        .filter((leg) => leg.legType === "stock" && leg.side === "long" && leg.exitAt === null)
        .reduce((sum, leg) => sum + leg.quantity * priceToCycleScale, 0);
    // The put ladder (backtestBaselineLadder.ts): the cycle's state, noted before anything is sold at this look.
    const ladderOn = baseline.entry === "buy_write" && baseline.putsWhenNoCall === "reserve_ladder";
    const ladderState = ladderOn
      ? noteLadderLook(ledger, symbol, { cycleOpen: ledgerOpenCycleSummary(ledger, symbol) !== null, todayIso, accountValue: accountValueToday(), stockPriceOnCycleScale: toCyclePrice(stockPrice), adjustedClosesBefore: lookSymbol.adjustedDailyClosesBeforeToday }, baseline)
      : null;
    const heldSharesCostToday = () => (heldSharesAverageCostToday() ?? 0) * heldSharesToday();
    const openPutCollateral = () =>
      positionsOfSymbol(ledger, symbol)
        .filter((position) => position.status === "open" && position.strategyKey === "cash_secured_put")
        .flatMap((position) => legsOfPosition(ledger, position.id))
        .filter((leg) => leg.legType === "option" && leg.side === "short" && leg.exitAt === null)
        .reduce((sum, leg) => sum + leg.strikePrice! * leg.quantity * leg.multiplier, 0);

    // strikeLimit: the cost rule's lowest strike for a call (costFloor, before the relief) or highest for a put (costCeiling,
    // the average held; null with none), when one applied; its scores then carry it with the averages around the order.
    const record = (strategyKey: "cash_secured_put" | "covered_call", candidate: BaselineCandidate, contracts: number, eligibleCount: number, chosenBecause: string, strikeLimit: { name: "costFloor" | "costCeiling"; value: number | null } | null = null, buyEveryShare = false, extraScores: Record<string, number | null> = {}) => {
      const actionId = context.nextActionId();
      const averageCostBefore = strikeLimit === null ? null : heldSharesAverageCostToday();
      const sharesHeldBefore = strikeLimit === null ? null : Math.round(heldSharesToday());
      const stockFillToday = shareFillPrice(stockPrice);
      const candidateMid = (candidate.bid + candidate.ask) / 2;
      let legIds: string[];
      let positionIds: string[];
      let newLegId: string;
      let sharesNote = "";
      if (strategyKey === "cash_secured_put") {
        const opened = openCashSecuredPut(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts, fillPrice: toCyclePrice(candidate.fillPrice), at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale });
        legIds = [opened.legId];
        positionIds = [opened.positionId];
        newLegId = opened.legId;
      } else {
        const opened = openCoveredCall(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts, callFillPrice: toCyclePrice(candidate.fillPrice), stockFillPrice: toCyclePrice(stockFillToday), at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale, tradedSharesPerLedgerShare: priceToCycleScale, buyEveryShare });
        const leftoverLegIds = opened.leftoverPositionId === null ? [] : legsOfPosition(ledger, opened.leftoverPositionId).filter((leg) => leg.exitAt === null).map((leg) => leg.id);
        legIds = [opened.callLegId, opened.stockLegId, ...leftoverLegIds];
        positionIds = [opened.positionId, ...(opened.leftoverPositionId === null ? [] : [opened.leftoverPositionId])];
        newLegId = opened.callLegId;
        const sharesBoughtToday = Math.round(opened.sharesBought * priceToCycleScale);
        const sharesHeldToday = Math.round(opened.sharesFromHeld * priceToCycleScale);
        sharesNote = [sharesHeldToday > 0 ? ` on ${sharesHeldToday} held shares` : "", sharesBoughtToday > 0 ? ` with ${sharesBoughtToday} shares bought @ ${stockFillToday.toFixed(2)}` : ""].join("");
      }
      // One position per contract (the ledger's rule, either right): the look's next choice must not take it again.
      heldContracts.add(heldKey(candidate));
      for (const legId of legIds) {
        const leg = requireLeg(ledger, legId);
        context.priceByLegId.set(legId, toCyclePrice(leg.legType === "stock" ? stockPrice : candidateMid));
      }
      const contractLabel = describeOptionContract({ strike: candidate.strike, right: candidate.right, expiry: candidate.expiry, dte: candidate.dte });
      const modelNote = [candidate.edgeYield === null ? "" : `, Edge Yield ${(candidate.edgeYield * 100).toFixed(0)}%`, candidate.volatilityEdge === null ? "" : `, IV ${(candidate.volatilityEdge * 100).toFixed(1)} pts above the forecast`].join("");
      const description = `${symbol} Sell ${contractLabel}${describeOrderSize(contracts, candidate.fillPrice)}${sharesNote} (premium yield ${(candidate.premiumYield * 100).toFixed(0)}%${modelNote}, delta ${Math.abs(candidate.delta).toFixed(2)}; ${eligibleCount} eligible)`;
      actions.push({
        actionId,
        tradingDate: todayIso,
        at: at.toISOString(),
        lookTimeEt,
        passNumber: 1,
        symbol,
        kind: strategyKey === "cash_secured_put" ? "open_cash_secured_put" : "open_covered_call",
        candidateId: openCandidateId(symbol, { strategyKey, expiry: candidate.expiry, strike: candidate.strike }),
        description,
        automatic: false,
        chosenBecause,
        outcome: "filled",
        blockReason: null,
        gateResults: [{ gate: "baseline", ok: true, detail: `${contracts} contract(s): volume allows ${candidate.volumeCap}` }],
        contract: { strategyKey, expiry: candidate.expiry, strike: candidate.strike, right: candidate.right },
        candidateScores: {
          premiumYield: candidate.premiumYield,
          delta: candidate.delta,
          impliedVolatility: candidate.impliedVolatility,
          timeValue: candidate.timeValue,
          dte: candidate.dte,
          bid: candidate.bid,
          ask: candidate.ask,
          volumeCap: candidate.volumeCap,
          eligibleCount,
          volatilityEdge: candidate.volatilityEdge,
          edgeYield: candidate.edgeYield,
          ...(strikeLimit === null
            ? {}
            : strikeLimit.name === "costFloor"
              ? { costFloor: strikeLimit.value, averageCostBefore, averageCostAfter: heldSharesAverageCostToday(), sharesHeldBefore }
              : { costCeiling: strikeLimit.value, averageCostBefore, averageCostAfter: heldSharesAverageCostToday(), sharesHeldBefore }),
          ...extraScores,
        },
        quantity: contracts,
        limitPrice: candidate.fillPrice,
        fillPrice: candidate.fillPrice,
        positionIds,
      });
      optionSales.push({
        legId: newLegId,
        actionId,
        symbol,
        openedOn: todayIso,
        strategyKey,
        expiry: candidate.expiry,
        strike: candidate.strike,
        optionRight: candidate.right,
        contracts,
        bid: candidate.bid,
        ask: candidate.ask,
        fillPrice: candidate.fillPrice,
        commissionDollars: optionCommissionDollars(contracts),
        spotAtOpen: stockPrice,
        sharePriceAtOpen: strategyKey === "covered_call" ? stockPrice : null,
        exposureDollars: ledgerCapitalAtRisk(ledger, requireLeg(ledger, newLegId).positionId) ?? ((strategyKey === "covered_call" ? stockPrice : candidate.strike) - candidate.fillPrice) * sharesPerContract * contracts,
        dte: candidate.dte,
        delta: candidate.delta,
        grade: null,
        edgeMargin: null,
        expectedPnlDollars: null,
        calibratedExpectedPnlDollars: null,
        edgeYield: candidate.edgeYield,
        histYield: null,
        kellyContracts: null,
        stressContracts: null,
        priceToCycleScale,
      });
      summaries.push(`Opened ${description}`);
    };

    // −1. The share stop.
    if (baseline.shareStopLossPct > 0) {
      const cycle = ledgerOpenCycleSummary(ledger, symbol);
      const costToday = cycle && cycle.sharesHeld > 0 && cycle.sharesAcquired > 0 ? cycle.acquisitionCost / cycle.sharesAcquired / priceToCycleScale : null;
      if (costToday !== null && stockPrice <= costToday * (1 - baseline.shareStopLossPct / 100)) {
        const stockFill = stockSaleFillPrice(stockPrice);
        for (const position of positionsOfSymbol(ledger, symbol)) {
          if (position.status !== "open" || (position.strategyKey !== "unstructured" && position.strategyKey !== "covered_call")) continue;
          const openLegs = legsOfPosition(ledger, position.id).filter((leg) => leg.exitAt === null);
          const stockLeg = openLegs.find((leg) => leg.legType === "stock");
          if (!stockLeg) continue;
          const sharesToday = Math.round(stockLeg.quantity * priceToCycleScale);
          let callNote = "";
          const actionId = context.nextActionId();
          if (position.strategyKey === "unstructured") {
            sellShares(ledger, { positionId: position.id, shares: stockLeg.quantity, fillPrice: toCyclePrice(stockFill), at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
          } else {
            const callLeg = openLegs.find((leg) => leg.legType === "option")!;
            const quote = quoteOf({ expiry: callLeg.expiryDate!, strike: roundedStrike(callLeg.strikePrice! / priceToCycleScale), right: "C" });
            if (!quote || quote.ask === null || !(quote.ask > 0)) {
              summaries.push(`${symbol}: share stop waits for a quote on the call written on ${sharesToday} shares`);
              continue;
            }
            const callFill = optionPurchaseFillPrice(quote.bid ?? 0, quote.ask, spreadShareCharged);
            closeCoveredCall(ledger, { positionId: position.id, callFillPrice: toCyclePrice(callFill), stockFillPrice: toCyclePrice(stockFill), at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
            callNote = `, buying back the call @ ${callFill.toFixed(2)}`;
          }
          const description = `${symbol} Sell ${sharesToday} shares @ ${stockFill.toFixed(2)}${callNote} (${(((stockPrice / costToday) - 1) * 100).toFixed(1)}% from their cost of ${costToday.toFixed(2)})`;
          actions.push({ actionId, tradingDate: todayIso, at: at.toISOString(), lookTimeEt, passNumber: 1, symbol, kind: position.strategyKey === "unstructured" ? "close_shares" : "close_position", candidateId: `${symbol}:share_stop:${position.id}`, description, automatic: false, chosenBecause: `baseline: shares ${baseline.shareStopLossPct}% or more below their cost`, outcome: "filled", blockReason: null, gateResults: [{ gate: "baseline", ok: true, detail: `price ${stockPrice.toFixed(2)} vs cost ${costToday.toFixed(2)}` }], contract: null, candidateScores: { costPerShare: costToday, stockPrice }, quantity: sharesToday, limitPrice: stockFill, fillPrice: stockFill, positionIds: [position.id] });
          summaries.push(`Closed ${description}`);
        }
      }
    }

    // 0. Profit-taking.
    if (baseline.takeProfitPct > 0) {
      for (const position of positionsOfSymbol(ledger, symbol)) {
        if (position.status !== "open" || (position.strategyKey !== "cash_secured_put" && position.strategyKey !== "covered_call")) continue;
        const optionLeg = legsOfPosition(ledger, position.id).find((leg) => leg.legType === "option" && leg.side === "short" && leg.exitAt === null);
        if (!optionLeg || daysToExpiry(optionLeg.expiryDate!, todayIso) < 1) continue;
        const right = optionLeg.optionType === "call" ? ("C" as const) : ("P" as const);
        const contract = { expiry: optionLeg.expiryDate!, strike: roundedStrike(optionLeg.strikePrice! / priceToCycleScale), right };
        const quote = quoteOf(contract);
        if (!quote || quote.ask === null || !(quote.ask > 0) || (quote.bid !== null && quote.bid > quote.ask)) continue;
        const buybackFill = optionPurchaseFillPrice(quote.bid ?? 0, quote.ask, spreadShareCharged);
        const entryToday = optionLeg.entryPrice / priceToCycleScale;
        const kept = entryToday > 0 ? 1 - buybackFill / entryToday : 0;
        if (kept * 100 < baseline.takeProfitPct) continue;
        const actionId = context.nextActionId();
        if (right === "P") buyBackPut(ledger, { legId: optionLeg.id, fillPrice: toCyclePrice(buybackFill), at, actionId });
        else buyBackCoveredCallKeepingShares(ledger, { positionId: position.id, callFillPrice: toCyclePrice(buybackFill), at, actionId });
        const contracts = Math.round((optionLeg.quantity * optionLeg.multiplier * priceToCycleScale) / sharesPerContract);
        const contractLabel = describeOptionContract({ strike: contract.strike, right, expiry: contract.expiry, dte: daysToExpiry(contract.expiry, todayIso) });
        const description = `${symbol} Buy back ${contractLabel}${describeOrderSize(contracts, buybackFill)} (keeps ${(kept * 100).toFixed(0)}% of the premium${right === "C" ? "; the shares stay" : ""})`;
        actions.push({ actionId, tradingDate: todayIso, at: at.toISOString(), lookTimeEt, passNumber: 1, symbol, kind: "close_leg", candidateId: `${symbol}:take_profit:${optionLeg.id}`, description, automatic: false, chosenBecause: `baseline: take profit at ${baseline.takeProfitPct}% of the premium`, outcome: "filled", blockReason: null, gateResults: [{ gate: "baseline", ok: true, detail: `buyback keeps ${(kept * 100).toFixed(1)}% of the premium` }], contract: { strategyKey: position.strategyKey, expiry: contract.expiry, strike: contract.strike, right }, candidateScores: { kept, entryPrice: entryToday, bid: quote.bid, ask: quote.ask }, quantity: contracts, limitPrice: buybackFill, fillPrice: buybackFill, positionIds: [position.id] });
        summaries.push(`Closed ${description}`);
      }
    }

    const stockFillToday = shareFillPrice(stockPrice);
    // 1. Calls on the free round lots.
    const freeLots = Math.floor((ledgerFreeShares(ledger, symbol) * priceToCycleScale) / sharesPerContract + 1e-9);
    let uncoveredLots = freeLots;
    // The floors tried in turn, lowest strike allowed on today's scale (null: any strike): with
    // "above_average_cost_else_break_even", the average price held first, then the cycle's break-even for the lots left.
    const callFloors: { floor: number | null; label: string }[] = [];
    if (freeLots >= 1 && baseline.callStrike !== "none") {
      const onTodaysScale = (perShareOnCycleScale: number | null) => (perShareOnCycleScale === null ? Number.POSITIVE_INFINITY : perShareOnCycleScale / priceToCycleScale);
      const cycle = baseline.callStrike === "delta_range" || baseline.callStrike === "above_latest_entry" || baseline.callStrike === "above_average_cost" ? null : ledgerOpenCycleSummary(ledger, symbol);
      if (baseline.callStrike === "delta_range") callFloors.push({ floor: null, label: "" });
      else if (baseline.callStrike === "above_latest_entry") callFloors.push({ floor: onTodaysScale(ledgerLatestShareAcquisitionPrice(ledger, symbol)), label: "" });
      else if (baseline.callStrike === "above_average_cost") callFloors.push({ floor: onTodaysScale(ledgerHeldSharesAverageCost(ledger, symbol)), label: "" });
      else if (baseline.callStrike === "above_share_cost") callFloors.push({ floor: onTodaysScale(cycle && cycle.sharesAcquired > 0 ? cycle.acquisitionCost / cycle.sharesAcquired : null), label: "" });
      else if (baseline.callStrike === "above_break_even") callFloors.push({ floor: onTodaysScale(cycle?.breakEvenPerShare ?? null), label: "" });
      else {
        callFloors.push({ floor: onTodaysScale(ledgerHeldSharesAverageCost(ledger, symbol)), label: " at or above the average price held" });
        if (cycle?.breakEvenPerShare != null) callFloors.push({ floor: onTodaysScale(cycle.breakEvenPerShare), label: " at or above the break-even (none at or above the average)" });
      }
    }
    // The ladder put, planned for today's rung (null when the ladder cannot sell one now: no cycle, no rung, one open).
    const ladderReady = ladderState !== null && ladderState.startedOn !== null && baseline.ladderPace !== "no_puts" && freeLots >= 1;
    const planLadderPuts = () => {
      if (!ladderState) return null;
      const cycle = ledgerOpenCycleSummary(ledger, symbol);
      const breakEven = cycle?.breakEvenPerShare == null ? null : cycle.breakEvenPerShare / priceToCycleScale;
      const rung = ladderRungToday({ settings: baseline, state: ladderState, accountValueToday: accountValueToday(), breakEven, stockPrice, heldSharesCost: heldSharesCostToday(), openPutCollateral: openPutCollateral(), priceToCycleScale });
      if (baseline.ladderPace === "one_open" && openPutCollateral() > 0) return { rung, blocked: `${symbol}: no new ladder put while one is open`, candidates: [] as BaselineCandidate[], rejections: null };
      const paceBlock = ladderRungPaceBlock(baseline, ladderState, at.getTime(), todayIso);
      if (paceBlock !== null) return { rung, blocked: `${symbol}: ${paceBlock}`, candidates: [] as BaselineCandidate[], rejections: null };
      if (rung.cap === null) return { rung, blocked: `${symbol}: no ladder put (${rung.note})`, candidates: [] as BaselineCandidate[], rejections: null };
      const { candidates, rejections } = select("P", null, true, rung.cap, true);
      return { rung, blocked: null, candidates, rejections };
    };
    const ladderPutContracts = (candidate: BaselineCandidate, collateralLeft: number) =>
      Math.min(Math.floor(collateralLeft / (candidate.strike * sharesPerContract)), baselineContractsForCash(ledgerFreeCash(ledger), candidate, "put", stockFillToday), candidate.volumeCap);
    const sellLadderPuts = (plan: NonNullable<ReturnType<typeof planLadderPuts>>, why: string) => {
      if (plan.blocked !== null) {
        summaries.push(plan.blocked);
        return;
      }
      const cap = plan.rung.cap!;
      let collateralLeft = plan.rung.collateral;
      let putsSold = 0;
      for (const candidate of fillDown ? plan.candidates : plan.candidates.slice(0, 1)) {
        if (isHeld(candidate)) continue;
        const contracts = ladderPutContracts(candidate, collateralLeft);
        if (contracts < 1) continue;
        record("cash_secured_put", candidate, contracts, plan.candidates.length, `baseline: the ladder put with the highest premium yield (${why}), strike at most ${cap.toFixed(2)}${putsSold > 0 ? " (next in order: the volume limit of the ones before)" : ""}`, { name: "costCeiling", value: cap }, false, plan.rung.scores);
        collateralLeft -= contracts * candidate.strike * sharesPerContract;
        putsSold++;
      }
      if (putsSold > 0 && ladderState) noteLadderRungSold(ladderState, at.getTime(), todayIso);
      if (putsSold === 0) summaries.push(`${symbol}: no ladder put at or below ${cap.toFixed(2)} (${plan.candidates.length > 0 ? `${plan.candidates.length} within the rules, none fits the rung or the cash` : (plan.rejections && describeRejections(plan.rejections)) || "no quotes"}; ${plan.rung.note})`);
    };
    // With ladderPutVersusCall "higher_yield": the best ladder put that can be sold now against the best call on the free
    // shares; a put yielding more than ladderPutYieldMarginPct% above the call is sold instead (the shares wait).
    let ladderPutChosen = false;
    if (ladderReady && baseline.ladderPutVersusCall === "higher_yield") {
      const plan = planLadderPuts();
      const bestPut = plan && plan.blocked === null ? (plan.candidates.find((candidate) => !isHeld(candidate) && ladderPutContracts(candidate, plan.rung.collateral) >= 1) ?? null) : null;
      if (plan && bestPut) {
        let bestCall: BaselineCandidate | null = null;
        for (const { floor } of callFloors) {
          bestCall = select("C", floor, false).candidates.find((candidate) => !isHeld(candidate)) ?? null;
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
    for (const { floor, label } of ladderPutChosen ? [] : callFloors) {
      if (uncoveredLots < 1) break;
      const { candidates, rejections } = select("C", floor, false);
      lastCallRejections = rejections;
      anyCallCandidate ||= candidates.length > 0;
      let soldAtThisFloor = 0;
      for (const candidate of fillDown ? candidates : candidates.slice(0, 1)) {
        if (uncoveredLots < 1) break;
        if (isHeld(candidate)) continue;
        const contracts = Math.min(uncoveredLots, candidate.volumeCap);
        record("covered_call", candidate, contracts, candidates.length, `baseline: the call with the highest ${rankingLabel}${label} on the free shares${fillDown && soldAtThisFloor > 0 ? " (next in order: the volume limit of the ones before)" : ""}`, floor === null ? null : { name: "costFloor", value: floor });
        uncoveredLots -= contracts;
        soldAtThisFloor += 1;
      }
    }
    // When the ladder put was chosen over the calls, they were quoted and lost: the put's own line says why.
    if (callFloors.length > 0 && !anyCallCandidate && !ladderPutChosen) summaries.push(`${symbol}: no call for ${freeLots * sharesPerContract} free shares (${(lastCallRejections && describeRejections(lastCallRejections)) || "no quotes"})`);

    // 2. The entry with the free cash. A buy-write waits while free round lots are still uncovered, unless it buys every share.
    const buyWrite = baseline.entry === "buy_write";
    // Room for the buy-writes' shares under maxSharesPctOfAccount, in round lots at today's fill (unbounded at 100).
    const shareCapLots = () => {
      if (buyWrite && ladderState !== null) return ladderShareLots(ladderBudget(ladderBase(ladderState, accountValueToday()), baseline.ladderSharesPct).sharesBudget - heldSharesCostToday() - openPutCollateral(), stockFillToday);
      if (!buyWrite || baseline.maxSharesPctOfAccount >= 100) return Number.POSITIVE_INFINITY;
      const room = (accountValueToday() * baseline.maxSharesPctOfAccount) / 100 - heldSharesToday() * stockPrice;
      return room > 0 ? Math.floor(room / (stockFillToday * sharesPerContract)) : 0;
    };
    /** True when a buy-write had cash and room for a round lot and sold none (no call passed, the yield threshold included). */
    const enterWithFreeCash = (): boolean => {
      const buyEveryShare = buyWrite && baseline.entryWhenSharesUncovered === "buy";
      if (buyWrite && uncoveredLots >= 1 && !buyEveryShare) return false;
      const roomForALot = buyWrite && Math.min(Math.floor(ledgerFreeCash(ledger) / (stockFillToday * sharesPerContract)), shareCapLots()) >= 1;
      const entryRight = baseline.entry === "put" ? "P" : "C";
      const floorAfterPurchase = buyWrite && baseline.entryCallStrike === "above_average_after_purchase";
      // The average once `contracts` more lots are bought at today's fill (the fill itself when none are held).
      const averageCostAfterBuying = (contracts: number) => {
        const averageCost = heldSharesAverageCostToday();
        const sharesHeld = heldSharesToday();
        return averageCost === null || !(sharesHeld > 0) ? stockFillToday : (sharesHeld * averageCost + contracts * sharesPerContract * stockFillToday) / (sharesHeld + contracts * sharesPerContract);
      };
      // Selection takes the lowest the average after the purchase can be (today's fill or the average now); each candidate is then held to its own.
      const heldAverageNow = floorAfterPurchase ? heldSharesAverageCostToday() : null;
      const entryMinimumStrike = !buyWrite ? null : baseline.entryCallStrike === "above_purchase_price" ? stockFillToday : floorAfterPurchase ? Math.min(stockFillToday, heldAverageNow ?? stockFillToday) : null;
      const { candidates, rejections } = select(entryRight, entryMinimumStrike);
      if (candidates.length === 0) {
        summaries.push(`${symbol}: no ${baseline.entry === "put" ? "put" : "new Covered Call"} (${describeRejections(rejections) || "no quotes"})`);
        return roomForALot;
      }
      const entryContractsFor = (candidate: BaselineCandidate) => {
        const byCash = baselineContractsForCash(ledgerFreeCash(ledger), candidate, baseline.entry, stockFillToday);
        let byRoom = Number.POSITIVE_INFINITY;
        if (baseline.maxAccountPctPerStock < 100) {
          const exposure = positionsOfSymbol(ledger, symbol).filter((position) => position.status === "open").reduce((sum, position) => sum + (ledgerCapitalAtRisk(ledger, position.id) ?? 0), 0);
          const room = (ledgerNetLiquidationValue(ledger, context.priceByLegId) * baseline.maxAccountPctPerStock) / 100 - exposure;
          const perContract = ((baseline.entry === "put" ? candidate.strike : stockFillToday) - candidate.fillPrice) * sharesPerContract;
          byRoom = room > 0 && perContract > 0 ? Math.floor(room / perContract) : 0;
        }
        return Math.min(byCash, byRoom, shareCapLots(), candidate.volumeCap);
      };
      let entriesMade = 0;
      let belowAverageAfterPurchase = 0;
      for (const candidate of fillDown ? candidates : candidates.slice(0, 1)) {
        if (isHeld(candidate)) continue;
        // A later candidate can still fit when this one does not: its fill may leave less to pay per contract.
        const contracts = entryContractsFor(candidate);
        if (contracts < 1) continue;
        const costFloor = floorAfterPurchase ? averageCostAfterBuying(contracts) : entryMinimumStrike;
        if (floorAfterPurchase && candidate.strike < costFloor! - 1e-9) {
          belowAverageAfterPurchase++;
          continue;
        }
        record(baseline.entry === "put" ? "cash_secured_put" : "covered_call", candidate, contracts, candidates.length, `baseline: the ${baseline.entry === "put" ? "put" : "Covered Call"} with the highest ${rankingLabel}${entriesMade > 0 ? " (next in order: the volume limit of the ones before)" : ""}`, costFloor === null ? null : { name: "costFloor", value: costFloor }, buyEveryShare);
        entriesMade++;
      }
      if (entriesMade === 0 && belowAverageAfterPurchase > 0) summaries.push(`${symbol}: no new Covered Call at or above the average after the purchase (${belowAverageAfterPurchase} below it)`);
      return entriesMade === 0 && roomForALot;
    };
    const buyWriteFoundNoCall = enterWithFreeCash();

    // 3. One put when no call was sold (held lots left without one, or a buy-write with room found none), while none is open.
    if (buyWrite && baseline.putsWhenNoCall === "dte_budget" && (uncoveredLots >= 1 || buyWriteFoundNoCall)) {
      const putOpen = positionsOfSymbol(ledger, symbol).some((position) => position.status === "open" && position.strategyKey === "cash_secured_put");
      if (putOpen) summaries.push(`${symbol}: no new put while one is open`);
      else {
        const averageNow = heldSharesAverageCostToday();
        const { candidates, rejections } = select("P", null, true, averageNow, true);
        const accountValue = accountValueToday();
        let putSold = false;
        for (const candidate of candidates) {
          if (isHeld(candidate)) continue;
          const budget = ((accountValue * baseline.putBudgetPctPerDte) / 100) * candidate.dte;
          const exposurePerContract = (candidate.strike - candidate.fillPrice) * sharesPerContract;
          const byBudget = exposurePerContract > 0 ? Math.floor(budget / exposurePerContract) : 0;
          const contracts = Math.min(byBudget, baselineContractsForCash(ledgerFreeCash(ledger), candidate, "put", stockFillToday), candidate.volumeCap);
          if (contracts < 1) continue;
          record("cash_secured_put", candidate, contracts, candidates.length, `baseline: the put with the highest premium yield (no call sold), ${baseline.putBudgetPctPerDte}% of the account per day to expiry`, { name: "costCeiling", value: averageNow }, false, { putBudgetDollars: budget, accountValue });
          putSold = true;
          break;
        }
        if (!putSold) summaries.push(`${symbol}: no put (${candidates.length > 0 ? `${candidates.length} within the rules, none fits the budget or the cash` : describeRejections(rejections) || "no quotes"})`);
      }
    }

    // 4. The put ladder: held lots without a call and no call qualifying, in a cycle (unless its put was sold before the calls).
    if (ladderReady && !anyCallCandidate && !ladderPutChosen) {
      const plan = planLadderPuts();
      if (plan) sellLadderPuts(plan, "no call qualifies");
    }
  }

  const summary = summaries.length === 0 ? "No action: fully invested" : actions.length === 0 ? `No action: ${summaries.join(" | ")}` : summaries.join(" · ");
  return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [], fitIssueBySymbol: new Map(), scoredBySymbol: new Map(), llmCalls: { asked: 0, fromCache: 0 } };
}
