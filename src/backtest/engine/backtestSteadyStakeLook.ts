import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { regularCloseMinutesEt } from "../../lib/varianceClock.js";
import { openCandidateId } from "../../pluto/candidateFilters.js";
import type { BacktestAction } from "../backtestTypes.js";
import { sharesPerContract } from "./backtestBook.js";
import type { BacktestLookContext, BacktestLookResult, BacktestOptionSale } from "./backtestLook.js";
import { captureLookTimeEt, lookInstantMs } from "./backtestTickerInputs.js";
import { baselineContractsForCash, noteBaselineForwardAnchors, selectBaselineCandidates, type BaselineCandidate, type BaselineCommissions, type BaselineForwardAnchor } from "./baselineSaleSteps.js";
import { buyShares, openCashSecuredPut, openCoveredCall, sellShares } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, stockCommissionDollars } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerFreeCash, ledgerFreeShares, ledgerNetLiquidationValue } from "./ledger/ledgerSelectors.js";
import { cycleSplitFactorFor, legsOfPosition, positionsOfSymbol, requireLeg } from "./ledger/simulatedLedger.js";

/** The flat rates the ledger charges (ledgerFills.ts), for sizing the Puts. */
const steadyStakeCommissions: BaselineCommissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };

// The Steady Stake's look (decision maker "steady_stake"; research of 2026-10-21 in tmp/new-strategy-research/). At the
// 10:00 look only, for every symbol:
//   1. the stake: the ticker's pot P = the account value × its weight (its pot ÷ every pot; in a shared account, 1 ÷ the
//      session's symbols) and its shares' value V = shares held × the look's price. When |V − s × P| > b × P (s the stake,
//      b the rebalancing band), whole shares are bought with the free cash, or uncovered ones sold, back to s × P at the
//      look's price;
//   2. on an expiry day (the look quotes an expiry today), Calls expiring today on c × the free round lots: the contract
//      whose |delta| is nearest the Calls' target first, then the next nearest within the tolerance while the volume
//      limit leaves lots uncovered;
//   3. then Puts expiring today on p × the pot's free cash (P − V − the ticker's open Puts' collateral, at most the
//      account's free cash), the same way.
// Each sale fills at the session's fill rule and is held to that day's close, where the session settles it (assigned
// or called away when in the money by $0.01). A cycle that spans a split whose contracts do not fit its share scale
// sells no options until it ends; its shares are still rebalanced.
// Realism limits as the baseline's (baselineSaleSteps.ts): bid at least $0.05, ask above bid, at most 20% of the
// contract's previous-session volume, spread at most maxSpreadPctOfMid of the mid; delta on the expiry's parity forward,
// T = the hours from the look to that day's close ÷ 8,760.

export async function runSteadyStakeLook(context: BacktestLookContext): Promise<BacktestLookResult> {
  const { settings, ledger, todayIso } = context;
  const stake = settings.steadyStake;
  const lookTimeEt = context.lookTimeEt ?? captureLookTimeEt;
  const at = new Date(lookInstantMs(todayIso, lookTimeEt));
  const closeMinutesEt = context.calendar.sessionsBetween(todayIso, todayIso)[0]?.closeMinutesEt ?? regularCloseMinutesEt;
  const [lookHours, lookMinutes] = lookTimeEt.split(":").map(Number);
  const yearsToTodaysClose = Math.max(0, closeMinutesEt - (lookHours! * 60 + lookMinutes!)) / 60 / 8760;
  const spreadShareCharged = settings.trading.spreadCostChargedPct / 100;
  const sessionSymbolCount = Math.max(1, context.sectorBySymbol.size);
  // Every ticker's pot from the account as the look found it, before any of the look's trades.
  const accountValue = ledgerNetLiquidationValue(ledger, context.priceByLegId);
  const actions: BacktestAction[] = [];
  const optionSales: BacktestOptionSale[] = [];
  const summaries: string[] = [];

  for (const lookSymbol of context.symbols) {
    const symbol = lookSymbol.profile.symbol;
    const weight = context.tickerSetupBySymbol?.get(symbol)?.weight ?? 1 / sessionSymbolCount;
    const quotes = lookSymbol.intraday?.quotes ?? lookSymbol.market.quotes;
    const stockPrice = lookSymbol.intraday?.stockPrice ?? lookSymbol.market.stockPrice;
    const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
    const cycleSplitFactor = cycleSplitFactorFor(ledger, symbol, lookSymbol.splitFactorToday, at);
    const priceToCycleScale = cycleSplitFactor / lookSymbol.splitFactorToday;
    const toCyclePrice = (price: number) => price * priceToCycleScale;
    const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
    const openLegsOfSymbol = () => positionsOfSymbol(ledger, symbol).filter((position) => position.status === "open").flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.exitAt === null));
    const sharesHeldToday = () => openLegsOfSymbol().filter((leg) => leg.legType === "stock" && leg.side === "long").reduce((sum, leg) => sum + leg.quantity * priceToCycleScale, 0);
    const openPutCollateral = () => openLegsOfSymbol().filter((leg) => leg.legType === "option" && leg.optionType === "put" && leg.side === "short").reduce((sum, leg) => sum + leg.strikePrice! * leg.quantity * leg.multiplier, 0);
    const markNewLegs = (legIds: readonly string[], optionMid: number | null) => {
      for (const legId of legIds) context.priceByLegId.set(legId, toCyclePrice(requireLeg(ledger, legId).legType === "stock" ? stockPrice : optionMid!));
    };
    const potValue = accountValue * weight;
    const stakeOf = (sharesValue: number) => (potValue > 0 ? `${((sharesValue / potValue) * 100).toFixed(1)}%` : "—");
    const sharesNote = (fromValue: number, toValue: number) => `stake ${stakeOf(fromValue)} → ${stakeOf(toValue)} of the ${formatDollars(potValue)} pot, target ${stake.stakePct}% ± ${stake.rebalanceBandPct}`;

    // 1. The stake.
    const targetValue = (stake.stakePct / 100) * potValue;
    const bandValue = (stake.rebalanceBandPct / 100) * potValue;
    const sharesValueBefore = sharesHeldToday() * stockPrice;
    if (sharesValueBefore < targetValue - bandValue) {
      const affordableToday = ledgerFreeCash(ledger) / (stockPrice + stockCommissionDollars(1));
      const ledgerShares = Math.floor(Math.min((targetValue - sharesValueBefore) / stockPrice, affordableToday) / priceToCycleScale + 1e-9);
      if (ledgerShares > 0) {
        const actionId = context.nextActionId();
        const bought = buyShares(ledger, { symbol, shares: ledgerShares, fillPrice: toCyclePrice(stockPrice), at, actionId, splitFactorToday: lookSymbol.splitFactorToday, tradedSharesPerLedgerShare: priceToCycleScale });
        markNewLegs([bought.legId], null);
        const sharesToday = Math.round(ledgerShares * priceToCycleScale);
        const description = `${symbol} Buy ${sharesToday} shares @ ${stockPrice.toFixed(2)} (${sharesNote(sharesValueBefore, sharesHeldToday() * stockPrice)})`;
        actions.push(shareAction({ actionId, kind: "buy_shares", symbol, todayIso, at, lookTimeEt, description, shares: sharesToday, stockPrice, positionIds: [bought.positionId], targetValue, sharesValueBefore, potValue }));
        summaries.push(description);
      }
    } else if (sharesValueBefore > targetValue + bandValue) {
      const ledgerShares = Math.min(ledgerFreeShares(ledger, symbol), Math.floor((sharesValueBefore - targetValue) / stockPrice / priceToCycleScale + 1e-9));
      const holder = positionsOfSymbol(ledger, symbol).find((position) => position.status === "open" && position.strategyKey === "unstructured");
      if (ledgerShares > 0 && holder) {
        const actionId = context.nextActionId();
        sellShares(ledger, { positionId: holder.id, shares: ledgerShares, fillPrice: toCyclePrice(stockPrice), at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
        const sharesToday = Math.round(ledgerShares * priceToCycleScale);
        const description = `${symbol} Sell ${sharesToday} shares @ ${stockPrice.toFixed(2)} (${sharesNote(sharesValueBefore, sharesHeldToday() * stockPrice)})`;
        actions.push(shareAction({ actionId, kind: "close_shares", symbol, todayIso, at, lookTimeEt, description, shares: sharesToday, stockPrice, positionIds: [holder.id], targetValue, sharesValueBefore, potValue }));
        summaries.push(description);
      }
    }

    // 2–3. Today's Calls and Puts, on an expiry day.
    if (!quotes.some((quote) => quote.expiry === todayIso)) continue;
    if (!lookSymbol.optionContractsRepresentable) {
      summaries.push(`${symbol}: no option orders while the open cycle spans a split`);
      continue;
    }
    const forwardAnchors = new Map<string, BaselineForwardAnchor>();
    noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate });
    const heldKey = (contract: { expiry: string; strike: number }) => `${contract.expiry}|${Math.round(contract.strike * 10_000) / 10_000}`;
    const heldContracts = new Set(openLegsOfSymbol().filter((leg) => leg.legType === "option").map((leg) => heldKey({ expiry: leg.expiryDate!, strike: leg.strikePrice! / priceToCycleScale })));
    const nearestFirst = (right: "C" | "P", targetAbsDelta: number): BaselineCandidate[] => {
      const { candidates } = selectBaselineCandidates({
        quotes,
        forwardAnchors,
        commissions: steadyStakeCommissions,
        right,
        todayIso,
        yearsToTodaysClose,
        stockPrice,
        riskFreeRate,
        previousSessionVolumeByContract: lookSymbol.market.previousSessionVolumeByContract,
        settings: { minAbsDelta: Math.max(0.0001, targetAbsDelta - stake.deltaTolerance), maxAbsDelta: Math.min(1, targetAbsDelta + stake.deltaTolerance), minDte: 0, maxDte: 0, maxSpreadPctOfMid: stake.maxSpreadPctOfMid },
        spreadShareCharged,
        isHeld: (contract) => heldContracts.has(heldKey(contract)),
      });
      const distance = (candidate: BaselineCandidate) => Math.abs(Math.abs(candidate.delta) - targetAbsDelta);
      return candidates.sort((a, b) => distance(a) - distance(b) || b.premiumYield - a.premiumYield || a.strike - b.strike);
    };
    const recordSale = (strategyKey: "covered_call" | "cash_secured_put", candidate: BaselineCandidate, contracts: number, chosenBecause: string) => {
      const actionId = context.nextActionId();
      const mid = (candidate.bid + candidate.ask) / 2;
      let legIds: string[];
      let positionIds: string[];
      let optionLegId: string;
      if (strategyKey === "covered_call") {
        const opened = openCoveredCall(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts, callFillPrice: toCyclePrice(candidate.fillPrice), stockFillPrice: null, at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale, tradedSharesPerLedgerShare: priceToCycleScale });
        const leftoverLegIds = opened.leftoverPositionId === null ? [] : legsOfPosition(ledger, opened.leftoverPositionId).filter((leg) => leg.exitAt === null).map((leg) => leg.id);
        legIds = [opened.callLegId, opened.stockLegId, ...leftoverLegIds];
        positionIds = [opened.positionId, ...(opened.leftoverPositionId === null ? [] : [opened.leftoverPositionId])];
        optionLegId = opened.callLegId;
      } else {
        const opened = openCashSecuredPut(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts, fillPrice: toCyclePrice(candidate.fillPrice), at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale });
        legIds = [opened.legId];
        positionIds = [opened.positionId];
        optionLegId = opened.legId;
      }
      heldContracts.add(heldKey(candidate));
      markNewLegs(legIds, mid);
      const contractLabel = describeOptionContract({ strike: candidate.strike, right: candidate.right, expiry: candidate.expiry, dte: candidate.dte });
      const description = `${symbol} Sell ${contractLabel}${describeOrderSize(contracts, candidate.fillPrice)}${strategyKey === "covered_call" ? " on held shares" : ""} (delta ${Math.abs(candidate.delta).toFixed(2)}, IV ${(candidate.impliedVolatility * 100).toFixed(0)}%, premium yield ${(candidate.premiumYield * 100).toFixed(0)}%)`;
      actions.push({
        actionId,
        tradingDate: todayIso,
        at: at.toISOString(),
        lookTimeEt,
        passNumber: 1,
        symbol,
        kind: strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put",
        candidateId: openCandidateId(symbol, { strategyKey, expiry: candidate.expiry, strike: candidate.strike }),
        description,
        automatic: false,
        chosenBecause,
        outcome: "filled",
        blockReason: null,
        gateResults: [{ gate: "steady_stake", ok: true, detail: `${contracts} contract(s): volume allows ${candidate.volumeCap}` }],
        contract: { strategyKey, expiry: candidate.expiry, strike: candidate.strike, right: candidate.right },
        candidateScores: { premiumYield: candidate.premiumYield, delta: candidate.delta, impliedVolatility: candidate.impliedVolatility, timeValue: candidate.timeValue, dte: candidate.dte, bid: candidate.bid, ask: candidate.ask, volumeCap: candidate.volumeCap },
        quantity: contracts,
        limitPrice: candidate.fillPrice,
        fillPrice: candidate.fillPrice,
        positionIds,
      });
      optionSales.push({
        legId: optionLegId,
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
        exposureDollars: ledgerCapitalAtRisk(ledger, requireLeg(ledger, optionLegId).positionId) ?? ((strategyKey === "covered_call" ? stockPrice : candidate.strike) - candidate.fillPrice) * sharesPerContract * contracts,
        dte: candidate.dte,
        delta: candidate.delta,
        grade: null,
        edgeMargin: null,
        expectedPnlDollars: null,
        calibratedExpectedPnlDollars: null,
        edgeYield: null,
        histYield: null,
        kellyContracts: null,
        stressContracts: null,
        priceToCycleScale,
      });
      summaries.push(description);
    };

    if (stake.callCoveragePct > 0) {
      const freeLots = Math.floor((ledgerFreeShares(ledger, symbol) * priceToCycleScale) / sharesPerContract + 1e-9);
      let lotsLeft = Math.floor((freeLots * stake.callCoveragePct) / 100 + 1e-9);
      for (const candidate of lotsLeft > 0 ? nearestFirst("C", stake.callAbsDelta) : []) {
        if (lotsLeft <= 0) break;
        const contracts = Math.min(lotsLeft, candidate.volumeCap);
        recordSale("covered_call", candidate, contracts, `steady stake: today's Call nearest |delta| ${stake.callAbsDelta} on ${stake.callCoveragePct}% of the free round lots`);
        lotsLeft -= contracts;
      }
    }
    if (stake.putCashPct > 0) {
      const potFreeCash = Math.max(0, Math.min(ledgerFreeCash(ledger), potValue - sharesHeldToday() * stockPrice - openPutCollateral()));
      let cashLeft = (potFreeCash * stake.putCashPct) / 100;
      for (const candidate of cashLeft > 0 ? nearestFirst("P", stake.putAbsDelta) : []) {
        const contracts = Math.min(baselineContractsForCash(cashLeft, candidate, "put", stockPrice, steadyStakeCommissions), candidate.volumeCap);
        if (contracts <= 0) continue;
        recordSale("cash_secured_put", candidate, contracts, `steady stake: today's Put nearest |delta| ${stake.putAbsDelta} on ${stake.putCashPct}% of the pot's free cash`);
        cashLeft -= (candidate.strike - candidate.fillPrice) * sharesPerContract * contracts + optionCommissionDollars(contracts);
      }
    }
  }

  const summary = summaries.length === 0 ? "No action: the stake is within its band" : summaries.join(" · ");
  return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [], fitIssueBySymbol: new Map(), scoredBySymbol: new Map(), llmCalls: { asked: 0, fromCache: 0 } };
}

const formatDollars = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;

function shareAction(input: { actionId: string; kind: "buy_shares" | "close_shares"; symbol: string; todayIso: string; at: Date; lookTimeEt: string; description: string; shares: number; stockPrice: number; positionIds: string[]; targetValue: number; sharesValueBefore: number; potValue: number }): BacktestAction {
  return {
    actionId: input.actionId,
    tradingDate: input.todayIso,
    at: input.at.toISOString(),
    lookTimeEt: input.lookTimeEt,
    passNumber: 1,
    symbol: input.symbol,
    kind: input.kind,
    candidateId: `${input.symbol}:${input.kind}:${input.positionIds[0]}`,
    description: input.description,
    automatic: false,
    chosenBecause: "steady stake: the shares' value outside the band around the stake",
    outcome: "filled",
    blockReason: null,
    gateResults: [{ gate: "steady_stake", ok: true, detail: `shares worth ${formatDollars(input.sharesValueBefore)} against a target of ${formatDollars(input.targetValue)}` }],
    contract: null,
    candidateScores: { potValue: input.potValue, targetValue: input.targetValue, sharesValueBefore: input.sharesValueBefore, stockPrice: input.stockPrice },
    quantity: input.shares,
    limitPrice: input.stockPrice,
    fillPrice: input.stockPrice,
    positionIds: input.positionIds,
  };
}
