import { valueContract, yieldOnExposure } from "../../lib/contractValuation.js";
import { blackScholesDelta, impliedVolatilityFromPrice, parityImpliedForward, yearsBetweenIsoDates } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { frictionDollarsPerContract } from "../../lib/signalCandidates.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { varianceSessionsToExpiry } from "../../lib/varianceClock.js";
import { selectModelVolatilityForecast, type ModelVolatilityForecast } from "../../lib/volatilityEdge.js";
import type { ValuationGroup, VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import { openCandidateId } from "../../pluto/candidateFilters.js";
import type { BacktestAction, BacktestBaselineSettings } from "../backtestTypes.js";
import { toOhlcvBars } from "./backtestBarHistory.js";
import { computeSaleFillPrice, sharesPerContract } from "./backtestBook.js";
import type { BacktestLookContext, BacktestLookResult, BacktestOptionSale } from "./backtestLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { captureLookTimeEt, earningsNotYetReported, forecastBarRowCount, lookInstantMs } from "./backtestTickerInputs.js";
import { buyBackCoveredCallKeepingShares, buyBackPut, closeCoveredCall, openCashSecuredPut, openCoveredCall, sellShares } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, optionPurchaseFillPrice, stockCommissionDollars, stockPurchaseFillPrice, stockSaleFillPrice } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerFreeCash, ledgerFreeShares, ledgerNetLiquidationValue, ledgerOpenCycleSummary } from "./ledger/ledgerSelectors.js";
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
//      cycle's cost per share acquired, or its break-even after its premium; on as many lots as the volume limit allows.
//      With callStrike "none", no call: the shares are held uncovered;
//   2. free cash goes into the entry with the highest premium yield in the same ranges: a cash-secured put, or 100
//      shares bought with a call sold on them (a buy-write), as many contracts as the cash, the stock's share of the
//      account (maxAccountPctPerStock: its open positions' capital at risk, net of premium) and the volume limit allow.
// With earnings "skip_spanning", no sale whose expiry spans a known earnings date (today ≤ report ≤ expiry); with looks
// "first_look", the session asks only at 10:00. With volatilityEdgeFilter "entries" (or "all_sales"), a new entry (or any
// sale, the calls on held shares too) is sold only when its volatility edge is at least minVolatilityEdgePoints; with
// ranking "edge_yield", the candidates are picked by the Signals model's Edge Yield instead of their premium yield.
// Everything is held to expiry; the session settles it (assignment, call-away) as for any session.
//
//   delta          = Black-76 delta at the quote's own implied volatility (from its mid), on the expiry's put-call parity
//                    forward (spot × e^{rT} when no strike has a usable pair); T = calendar days to expiry ÷ 365
//   fill           = mid − λ × half-spread (the session's fill rule)
//   premium yield  = (fill − intrinsic value) × 100 − commission, ÷ capital at risk, ÷ max(T, 1 day)
//                    capital at risk = (strike − fill) × 100 for a put, (spot − fill) × 100 for a call
//   Out of the money this is the platform's premium yield after costs; in the money only the time value counts, as
//   the intrinsic value is not earned.
//   volatility edge = √(252 × σ_mid² × T ÷ τ) − σ_YZ21: the Signals model's implied volatility (the mid's total variance
//                    on the forecast's clock) less its forecast; τ = variance sessions from the look to the expiry's close
//                    (varianceClock.ts), σ_YZ21 from the daily bars before today
//   Edge Yield     = the Signals model's expected P&L after costs (contractValuation.ts, friction λ × half-spread × 100 +
//                    commission) ÷ capital at risk, annualized on calendar time
// Realism limits, fixed for every baseline session (never tuned): bid at least $0.05, ask above bid, spread at most 15%
// of the mid, at most 20% of the contract's previous-session volume.

export const baselineMinimumBid = 0.05;
export const baselineMaxSpreadFractionOfMid = 0.15;
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
  stockPrice: number;
  /** As a fraction (0.05 = 5%). */
  riskFreeRate: number;
  /** The previous session's volume by contractKey; null when unknown (nothing passes the volume limit). */
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  settings: Pick<BacktestBaselineSettings, "minAbsDelta" | "maxAbsDelta" | "minDte" | "maxDte">;
  /** λ: the share of the half-spread a fill gives up. */
  spreadShareCharged: number;
  isHeld(contract: { expiry: string; strike: number }): boolean;
  /** Calls on held shares under a cost rule: the lowest strike allowed; absent or null when any strike is. */
  minimumStrike?: number | null;
  /** Earnings dates still to come: an expiry on or after one is left out. Absent: earnings are ignored. */
  earningsDatesIso?: readonly string[];
  /** Absent or null: neither the volatility-edge filter nor Edge Yield ranking. */
  model?: BaselineModelInput | null;
}

/** Pure: the contracts of one right that pass the baseline's rules, best premium yield (or Edge Yield) first (ties: nearer expiry, then lower strike). */
export function selectBaselineCandidates(input: BaselineCandidateInput): { candidates: BaselineCandidate[]; rejections: BaselineRejections } {
  const rejections: BaselineRejections = { outsideExpiryRange: 0, noUsableQuote: 0, spreadTooWide: 0, tooLittleVolume: 0, noImpliedVolatility: 0, outsideDeltaRange: 0, noTimeValue: 0, alreadyHeld: 0, belowCost: 0, spansEarnings: 0, noForecast: 0, belowVolatilityEdge: 0 };
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
    if (input.minimumStrike !== undefined && input.minimumStrike !== null && quote.strike < input.minimumStrike - 1e-9) {
      rejections.belowCost++;
      continue;
    }
    if (quote.bid === null || quote.ask === null || quote.bid < baselineMinimumBid || !(quote.ask > quote.bid)) {
      rejections.noUsableQuote++;
      continue;
    }
    const mid = (quote.bid + quote.ask) / 2;
    if ((quote.ask - quote.bid) / mid > baselineMaxSpreadFractionOfMid) {
      rejections.spreadTooWide++;
      continue;
    }
    const volume = input.previousSessionVolumeByContract?.get(contractKey(quote)) ?? null;
    const volumeCap = volume === null ? 0 : Math.floor(volume * baselineMaxVolumeShare);
    if (volumeCap < 1) {
      rejections.tooLittleVolume++;
      continue;
    }
    const yearsToExpiry = yearsBetweenIsoDates(input.todayIso, quote.expiry);
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
      premiumYield: yieldOnExposure(earnedDollars, capitalPerShare * sharesPerContract, Math.max(yearsToExpiry, minimumAnnualizationYears)),
      volumeCap,
      volatilityEdge,
      edgeYield,
    });
  }
  const rankOf = (candidate: BaselineCandidate) => (input.model?.rankByEdgeYield ? candidate.edgeYield! : candidate.premiumYield);
  candidates.sort((a, b) => rankOf(b) - rankOf(a) || a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
  return { candidates, rejections };
}

/** "spread 40, volume 12": the rules that left contracts out, most first. */
function describeRejections(rejections: BaselineRejections): string {
  const labels: Record<keyof BaselineRejections, string> = { outsideExpiryRange: "expiry", noUsableQuote: "quote", spreadTooWide: "spread", tooLittleVolume: "volume", noImpliedVolatility: "IV", outsideDeltaRange: "delta", noTimeValue: "time value", alreadyHeld: "held", belowCost: "below cost", spansEarnings: "earnings", noForecast: "no forecast", belowVolatilityEdge: "IV not above forecast" };
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
    const select = (right: "C" | "P", minimumStrike: number | null = null, forEntry = true) =>
      selectBaselineCandidates({ quotes, right, todayIso, stockPrice, riskFreeRate, previousSessionVolumeByContract: lookSymbol.market.previousSessionVolumeByContract, settings: forEntry ? baseline : callsSettings, spreadShareCharged, isHeld, minimumStrike, ...(earningsDatesIso ? { earningsDatesIso } : {}), model: forEntry ? model : callsModel });
    let quoteIndex: Map<string, SymbolFileQuote> | null = null;
    const quoteOf = (contract: { expiry: string; strike: number; right: "C" | "P" }) => (quoteIndex ??= new Map(quotes.map((quote) => [contractKey({ expiry: quote.expiry, strike: roundedStrike(quote.strike), right: quote.right }), quote]))).get(contractKey(contract));

    const record = (strategyKey: "cash_secured_put" | "covered_call", candidate: BaselineCandidate, contracts: number, eligibleCount: number, chosenBecause: string) => {
      const actionId = context.nextActionId();
      const stockFillToday = stockPurchaseFillPrice(stockPrice);
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
        const opened = openCoveredCall(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts, callFillPrice: toCyclePrice(candidate.fillPrice), stockFillPrice: toCyclePrice(stockFillToday), at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale, tradedSharesPerLedgerShare: priceToCycleScale });
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
        candidateScores: { premiumYield: candidate.premiumYield, delta: candidate.delta, impliedVolatility: candidate.impliedVolatility, timeValue: candidate.timeValue, dte: candidate.dte, bid: candidate.bid, ask: candidate.ask, volumeCap: candidate.volumeCap, eligibleCount, volatilityEdge: candidate.volatilityEdge, edgeYield: candidate.edgeYield },
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

    // 1. Calls on the free round lots.
    const freeLots = Math.floor((ledgerFreeShares(ledger, symbol) * priceToCycleScale) / sharesPerContract + 1e-9);
    let uncoveredLots = freeLots;
    let minimumCallStrike: number | null = null;
    if (freeLots >= 1 && baseline.callStrike !== "delta_range" && baseline.callStrike !== "none") {
      const cycle = ledgerOpenCycleSummary(ledger, symbol);
      const perShareOnCycleScale = baseline.callStrike === "above_share_cost" ? (cycle && cycle.sharesAcquired > 0 ? cycle.acquisitionCost / cycle.sharesAcquired : null) : (cycle?.breakEvenPerShare ?? null);
      minimumCallStrike = perShareOnCycleScale === null ? Number.POSITIVE_INFINITY : perShareOnCycleScale / priceToCycleScale;
    }
    if (freeLots >= 1 && baseline.callStrike !== "none") {
      const { candidates, rejections } = select("C", minimumCallStrike, false);
      const best = candidates[0];
      if (best) {
        const contracts = Math.min(freeLots, best.volumeCap);
        record("covered_call", best, contracts, candidates.length, `baseline: the call with the highest ${baseline.ranking === "edge_yield" ? "Edge Yield" : "premium yield"} on the free shares`);
        uncoveredLots -= contracts;
      } else summaries.push(`${symbol}: no call for ${freeLots * sharesPerContract} free shares (${describeRejections(rejections) || "no quotes"})`);
    }

    // 2. The entry with the free cash. A buy-write waits while free round lots are still uncovered.
    if (baseline.entry === "buy_write" && uncoveredLots >= 1) continue;
    const entryRight = baseline.entry === "put" ? "P" : "C";
    const { candidates, rejections } = select(entryRight);
    const best = candidates[0];
    if (!best) {
      summaries.push(`${symbol}: no ${baseline.entry === "put" ? "put" : "buy-write"} (${describeRejections(rejections) || "no quotes"})`);
      continue;
    }
    const byCash = baselineContractsForCash(ledgerFreeCash(ledger), best, baseline.entry, stockPurchaseFillPrice(stockPrice));
    let byRoom = Number.POSITIVE_INFINITY;
    if (baseline.maxAccountPctPerStock < 100) {
      const exposure = positionsOfSymbol(ledger, symbol).filter((position) => position.status === "open").reduce((sum, position) => sum + (ledgerCapitalAtRisk(ledger, position.id) ?? 0), 0);
      const room = (ledgerNetLiquidationValue(ledger, context.priceByLegId) * baseline.maxAccountPctPerStock) / 100 - exposure;
      const perContract = ((baseline.entry === "put" ? best.strike : stockPurchaseFillPrice(stockPrice)) - best.fillPrice) * sharesPerContract;
      byRoom = room > 0 && perContract > 0 ? Math.floor(room / perContract) : 0;
    }
    const contracts = Math.min(byCash, byRoom, best.volumeCap);
    if (contracts >= 1) record(baseline.entry === "put" ? "cash_secured_put" : "covered_call", best, contracts, candidates.length, `baseline: the ${baseline.entry === "put" ? "put" : "buy-write"} with the highest ${baseline.ranking === "edge_yield" ? "Edge Yield" : "premium yield"}`);
  }

  const summary = summaries.length === 0 ? "No action: fully invested" : actions.length === 0 ? `No action: ${summaries.join(" | ")}` : summaries.join(" · ");
  return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [], fitIssueBySymbol: new Map(), scoredBySymbol: new Map(), llmCalls: { asked: 0, fromCache: 0 } };
}
