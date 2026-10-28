import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { formatWholeDollars } from "../../lib/formatWholeDollars.js";
import { openCandidateId } from "./candidateIds.js";
import type { BacktestBarHistory } from "./backtestBarHistory.js";
import type { BacktestAction, BacktestBreakEvenLevel } from "../backtestTypes.js";
import { sharesPerContract } from "./backtestBook.js";
import type { BacktestLookContext, BacktestLookResult, BacktestLookSymbol, BacktestOptionSale } from "./backtestLookTypes.js";
import { markOfTwoSidedQuote } from "./backtestOptionMarks.js";
import { captureLookTimeEt, lookInstantMs } from "./backtestTickerInputs.js";
import { noteBaselineForwardAnchors, roundedStrike, type BaselineCommissions, type BaselineForwardAnchor } from "./baselineSaleSteps.js";
import { buyLeapsCall, expirySettlementInstant, openCashSecuredPut, openCoveredCall, sellLeapsCall } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, stockCommissionDollars } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerFreeCash, ledgerNetLiquidationValue } from "./ledger/ledgerSelectors.js";
import { cycleSplitFactorFor, cycleStartSplitFactor, isSymbolFlat, legsOfPosition, positionsOfSymbol, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";
import { newVolFarmerV2SymbolState, runVolFarmerV2Steps, stepImpliedVolatilityLookbackSessions, volFarmerV2BreakEven, type VolFarmerV2Book, type VolFarmerV2Market, type VolFarmerV2Position, type VolFarmerV2SymbolState } from "./volFarmerV2Steps.js";

// Vol Farmer v2 in the backtest: the shared steps (volFarmerV2Steps.ts, where the rules are) on the simulated ledger, at
// the 10:00 look only or at every look (volFarmerV2.looks; a later look reads its own quotes and price). The pot of a new
// cycle is the account's free cash (one-symbol sessions), the LEAPS cap a share of the account's value at the look
// (positions marked). Each order the steps place is filled on the ledger at once and recorded as the session's action
// and, for an option sold, its trade row.

/** The flat rates the ledger charges (ledgerFills.ts), for ranking the options. */
const volFarmerV2Commissions: BaselineCommissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };
const millisecondsPerYear = 365 * 86_400_000;

const stateByLedger = new WeakMap<SimulatedLedger, Map<string, VolFarmerV2SymbolState>>();

function stateOf(ledger: SimulatedLedger, symbol: string): VolFarmerV2SymbolState {
  let bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) stateByLedger.set(ledger, (bySymbol = new Map()));
  let state = bySymbol.get(symbol);
  if (!state) bySymbol.set(symbol, (state = newVolFarmerV2SymbolState()));
  return state;
}

/** IBKR's 30-day implied volatility of the latest daily bar before `todayIso`, within the last 10 sessions; null when none. */
export function impliedVolatilityBefore(bars: BacktestBarHistory, todayIso: string): number | null {
  const recent = bars.rowsBefore(todayIso, stepImpliedVolatilityLookbackSessions);
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const impliedVolatility = recent[index]!.impliedVolatility;
    if (impliedVolatility !== null && impliedVolatility > 0) return impliedVolatility;
  }
  return null;
}

/** The Vol Farmer v2 look (runBacktestSession.ts skips the looks after 10:00 when its looks are the first only). */
export async function runVolFarmerV2Look(context: BacktestLookContext): Promise<BacktestLookResult> {
  const { settings, ledger, todayIso } = context;
  const lookTimeEt = context.lookTimeEt ?? captureLookTimeEt;
  const at = new Date(lookInstantMs(todayIso, lookTimeEt));
  const actions: BacktestAction[] = [];
  const optionSales: BacktestOptionSale[] = [];
  const summaries: string[] = [];
  const breakEvenLevels: BacktestBreakEvenLevel[] = [];
  for (const lookSymbol of context.symbols) {
    const market = marketOf(context, lookSymbol, at);
    const book = ledgerBook({ context, lookSymbol, market, at, lookTimeEt, actions, optionSales });
    const summary = runVolFarmerV2Steps({ state: stateOf(ledger, lookSymbol.profile.symbol), market, farmer: settings.volFarmer, v2: settings.volFarmerV2, book });
    if (summary !== null) summaries.push(summary);
    const level = breakEvenLevelAfterLook(ledger, lookSymbol, at);
    if (level !== null) breakEvenLevels.push({ tradingDate: todayIso, at: at.toISOString(), lookTimeEt, ...level });
  }
  const summary = summaries.length === 0 ? "No action" : summaries.join(" · ");
  return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [], breakEvenLevels };
}

/** The look's market as the steps read it: the 10:00 capture, or a later look's own quotes and price. */
function marketOf(context: BacktestLookContext, lookSymbol: BacktestLookSymbol, at: Date): VolFarmerV2Market {
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const stockPrice = lookSymbol.intraday?.stockPrice ?? lookSymbol.market.stockPrice;
  const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
  const quotes = lookSymbol.intraday?.quotes ?? lookSymbol.market.quotes;
  const yearsToTodaysClose = Math.max(0, expirySettlementInstant(todayIso).getTime() - at.getTime()) / millisecondsPerYear;
  const forwardAnchors = new Map<string, BaselineForwardAnchor>();
  noteBaselineForwardAnchors(forwardAnchors, { quotes, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate });
  return {
    symbol,
    todayIso,
    stockPrice,
    riskFreeRate,
    quotes,
    forwardAnchors,
    previousSessionVolumeByContract: lookSymbol.market.previousSessionVolumeByContract,
    yearsToTodaysClose,
    yearsToExpiry: (expiry) => Math.max(0, expirySettlementInstant(expiry).getTime() - at.getTime()) / millisecondsPerYear,
    leapsCallQuotes: lookSymbol.leapsCallQuotes,
    stepImpliedVolatility: () => impliedVolatilityBefore(lookSymbol.bars, todayIso),
    priceToCycleScale: cycleSplitFactorFor(ledger, symbol, lookSymbol.splitFactorToday, at) / lookSymbol.splitFactorToday,
    optionContractsRepresentable: lookSymbol.optionContractsRepresentable,
    spreadShareCharged: context.settings.trading.spreadCostChargedPct / 100,
    commissions: volFarmerV2Commissions,
    optionCommissionDollars,
    stockCommissionDollars,
    leapsCapBaseLabel: "the account",
    capsLeapsAtAskSize: true,
  };
}

/** Both positions' break-evens as traded once the look is done (the price chart's B-E and B-E2); null when neither holds shares. */
function breakEvenLevelAfterLook(ledger: SimulatedLedger, lookSymbol: BacktestLookSymbol, at: Date): Pick<BacktestBreakEvenLevel, "symbol" | "splitFactor" | "firstBreakEven" | "secondBreakEven"> | null {
  const symbol = lookSymbol.profile.symbol;
  const state = stateOf(ledger, symbol);
  const priceToCycleScale = cycleSplitFactorFor(ledger, symbol, lookSymbol.splitFactorToday, at) / lookSymbol.splitFactorToday;
  const asTraded = (position: VolFarmerV2Position | null) => {
    const breakEven = position === null || position.shares <= 0 ? null : volFarmerV2BreakEven(position);
    return breakEven === null ? null : breakEven / priceToCycleScale;
  };
  const firstBreakEven = asTraded(state.first);
  const secondBreakEven = asTraded(state.second);
  if (firstBreakEven === null && secondBreakEven === null) return null;
  return { symbol, splitFactor: lookSymbol.splitFactorToday, firstBreakEven, secondBreakEven };
}

function openOptionLegsOf(ledger: SimulatedLedger, symbol: string): LedgerLeg[] {
  return positionsOfSymbol(ledger, symbol).flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.exitAt === null && leg.legType === "option" && leg.expiryDate !== null && leg.strikePrice !== null));
}

/** The symbol's book on the simulated ledger: each order filled at once at its fill price, and recorded. */
function ledgerBook(input: { context: BacktestLookContext; lookSymbol: BacktestLookSymbol; market: VolFarmerV2Market; at: Date; lookTimeEt: string; actions: BacktestAction[]; optionSales: BacktestOptionSale[] }): VolFarmerV2Book {
  const { context, lookSymbol, market, at, lookTimeEt, actions, optionSales } = input;
  const { ledger, todayIso } = context;
  const symbol = lookSymbol.profile.symbol;
  const { stockPrice, priceToCycleScale } = market;
  const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
  const legById = (legId: string): LedgerLeg | undefined => ledger.legs.find((leg) => leg.id === legId);
  return {
    isFlat: () => isSymbolFlat(ledger, symbol),
    freeCash: () => ledgerFreeCash(ledger),
    potForNewCycle: () => ledgerFreeCash(ledger),
    leapsCapBaseDollars: () => ledgerNetLiquidationValue(ledger, context.priceByLegId),
    openOptionContracts: () => openOptionLegsOf(ledger, symbol).map((leg) => ({ expiry: leg.expiryDate!, strike: leg.strikePrice! })),
    leg(legId) {
      const leg = legById(legId);
      if (leg === undefined) return undefined;
      // A leg of a cycle that has ended since (its shares called away) is on that cycle's scale, not the look's.
      const legCycleFactor = isSymbolFlat(ledger, symbol) ? cycleStartSplitFactor(ledger, symbol, leg.entryAt) : null;
      return { closed: leg.exitAt !== null, assigned: leg.settledAs === "assigned", strike: leg.strikePrice, contracts: leg.quantity, ...(legCycleFactor === null ? {} : { priceToCycleScale: legCycleFactor / lookSymbol.splitFactorToday }) };
    },

    sellCoveredCall(sale) {
      const call = sale.candidate;
      const actionId = context.nextActionId();
      const opened = openCoveredCall(ledger, {
        symbol,
        expiryDate: call.expiry,
        strike: call.strike * priceToCycleScale,
        contracts: sale.contracts,
        callFillPrice: call.fillPrice * priceToCycleScale,
        stockFillPrice: sale.startsCycle ? stockPrice * priceToCycleScale : null,
        at,
        actionId,
        splitFactorToday: lookSymbol.splitFactorToday,
        sharesPerContract: sharesPerContractOnCycleScale,
        tradedSharesPerLedgerShare: priceToCycleScale,
      });
      context.priceByLegId.set(opened.callLegId, ((call.bid + call.ask) / 2) * priceToCycleScale);
      context.priceByLegId.set(opened.stockLegId, stockPrice * priceToCycleScale);
      if (opened.leftoverPositionId !== null) for (const leg of legsOfPosition(ledger, opened.leftoverPositionId)) context.priceByLegId.set(leg.id, stockPrice * priceToCycleScale);
      actions.push({
        actionId,
        tradingDate: todayIso,
        at: at.toISOString(),
        lookTimeEt,
        passNumber: 1,
        symbol,
        kind: "open_covered_call",
        candidateId: openCandidateId(symbol, { strategyKey: "covered_call", expiry: call.expiry, strike: call.strike }),
        description: sale.description,
        automatic: false,
        chosenBecause: sale.chosenBecause,
        outcome: "filled",
        blockReason: null,
        gateResults: [{ gate: "vol_farmer_v2", ok: true, detail: `${sale.contracts} contract(s): volume allows ${call.volumeCap}` }],
        contract: { strategyKey: "covered_call", expiry: call.expiry, strike: call.strike, right: "C" },
        candidateScores: sale.candidateScores,
        quantity: sale.contracts,
        limitPrice: call.fillPrice,
        fillPrice: call.fillPrice,
        positionIds: [opened.positionId, ...(opened.leftoverPositionId === null ? [] : [opened.leftoverPositionId])],
      });
      optionSales.push({ legId: opened.callLegId, actionId, symbol, openedOn: todayIso, strategyKey: "covered_call", expiry: call.expiry, strike: call.strike, optionRight: "C", contracts: sale.contracts, bid: call.bid, ask: call.ask, fillPrice: call.fillPrice, commissionDollars: optionCommissionDollars(sale.contracts), spotAtOpen: stockPrice, sharePriceAtOpen: stockPrice, exposureDollars: ledgerCapitalAtRisk(ledger, opened.positionId) ?? (stockPrice - call.fillPrice) * sharesPerContract * sale.contracts, dte: call.dte, delta: call.delta, grade: null, edgeMargin: null, expectedPnlDollars: null, calibratedExpectedPnlDollars: null, edgeYield: null, histYield: null, kellyContracts: null, stressContracts: null, priceToCycleScale });
      return opened.callLegId;
    },

    sellCashSecuredPut(sale) {
      const put = sale.candidate;
      const actionId = context.nextActionId();
      const opened = openCashSecuredPut(ledger, { symbol, expiryDate: put.expiry, strike: put.strike * priceToCycleScale, contracts: sale.contracts, fillPrice: put.fillPrice * priceToCycleScale, at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale });
      context.priceByLegId.set(opened.legId, ((put.bid + put.ask) / 2) * priceToCycleScale);
      actions.push({
        actionId,
        tradingDate: todayIso,
        at: at.toISOString(),
        lookTimeEt,
        passNumber: 1,
        symbol,
        kind: "open_cash_secured_put",
        candidateId: openCandidateId(symbol, { strategyKey: "cash_secured_put", expiry: put.expiry, strike: put.strike }),
        description: sale.description,
        automatic: false,
        chosenBecause: sale.chosenBecause,
        outcome: "filled",
        blockReason: null,
        gateResults: [{ gate: "vol_farmer_v2", ok: true, detail: `${sale.contracts} contract(s): volume allows ${put.volumeCap}` }],
        contract: { strategyKey: "cash_secured_put", expiry: put.expiry, strike: put.strike, right: "P" },
        candidateScores: sale.candidateScores,
        quantity: sale.contracts,
        limitPrice: put.fillPrice,
        fillPrice: put.fillPrice,
        positionIds: [opened.positionId],
      });
      optionSales.push({ legId: opened.legId, actionId, symbol, openedOn: todayIso, strategyKey: "cash_secured_put", expiry: put.expiry, strike: put.strike, optionRight: "P", contracts: sale.contracts, bid: put.bid, ask: put.ask, fillPrice: put.fillPrice, commissionDollars: optionCommissionDollars(sale.contracts), spotAtOpen: stockPrice, sharePriceAtOpen: stockPrice, exposureDollars: ledgerCapitalAtRisk(ledger, opened.positionId) ?? (put.strike - put.fillPrice) * sharesPerContract * sale.contracts, dte: put.dte, delta: put.delta, grade: null, edgeMargin: null, expectedPnlDollars: null, calibratedExpectedPnlDollars: null, edgeYield: null, histYield: null, kellyContracts: null, stressContracts: null, priceToCycleScale });
      return opened.legId;
    },

    buyLeaps(purchase) {
      const actionId = context.nextActionId();
      const opened = buyLeapsCall(ledger, { symbol, expiryDate: purchase.expiry, strike: purchase.strike * priceToCycleScale, contracts: purchase.contracts, fillPrice: purchase.fillPrice * priceToCycleScale, at, actionId, sharesPerContract: sharesPerContractOnCycleScale });
      context.priceByLegId.set(opened.legId, markOfTwoSidedQuote(purchase, context.settings.volFarmerV2.leapsSpreadCostChargedPct / 100) * priceToCycleScale);
      actions.push({
        actionId,
        tradingDate: todayIso,
        at: at.toISOString(),
        lookTimeEt,
        passNumber: 1,
        symbol,
        kind: "buy_leaps",
        candidateId: `${symbol}:leaps:${purchase.expiry}:${roundedStrike(purchase.strike)}`,
        description: purchase.description,
        automatic: false,
        chosenBecause: purchase.chosenBecause,
        outcome: "filled",
        blockReason: null,
        gateResults: [{ gate: "vol_farmer_v2", ok: true, detail: `${purchase.contracts} contract(s)` }],
        contract: { strategyKey: "leaps", expiry: purchase.expiry, strike: purchase.strike, right: "C" },
        candidateScores: purchase.candidateScores,
        quantity: purchase.contracts,
        limitPrice: purchase.fillPrice,
        fillPrice: purchase.fillPrice,
        positionIds: [opened.positionId],
      });
      return opened.legId;
    },

    sellLeaps(sale) {
      // One order for every leg of the LEAPS (its purchase and top-ups), each closed whole at the order's fill.
      const legs = sale.legIds.map((legId) => legById(legId)!);
      const actionId = context.nextActionId();
      for (const leg of legs) sellLeapsCall(ledger, { legId: leg.id, contracts: leg.quantity, fillPrice: sale.fillPrice * priceToCycleScale, at, actionId });
      actions.push({
        actionId,
        tradingDate: todayIso,
        at: at.toISOString(),
        lookTimeEt,
        passNumber: 1,
        symbol,
        kind: "sell_leaps",
        candidateId: `${symbol}:leaps:${sale.expiry}:${roundedStrike(sale.strike)}`,
        description: sale.description,
        automatic: true,
        chosenBecause: sale.chosenBecause,
        outcome: "filled",
        blockReason: null,
        gateResults: [{ gate: "vol_farmer_v2", ok: true, detail: `${sale.contracts} contract(s)` }],
        contract: { strategyKey: "leaps", expiry: sale.expiry, strike: sale.strike, right: "C" },
        candidateScores: sale.candidateScores,
        quantity: sale.contracts,
        limitPrice: sale.fillPrice,
        fillPrice: sale.fillPrice,
        positionIds: [...new Set(legs.map((leg) => leg.positionId))],
      });
    },
  };
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
};

/**
 * The session note on Vol Farmer v2's cash (Marcelo 2026-10-27, "test that there is cash to spare"): what each half of the
 * pot left unspent once sized (whole lots, whole contracts), and every LEAPS trigger: the free cash then against one
 * contract's cost, and what was bought.
 */
export function describeVolFarmerV2Run(ledger: SimulatedLedger, symbols: readonly string[]): string | null {
  const bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) return null;
  const parts = symbols.flatMap((symbol) => {
    const cash = bySymbol.get(symbol)?.cash;
    if (!cash) return [];
    const left = (values: readonly number[]) => (values.length === 0 ? "none sized" : `median ${formatWholeDollars(median(values)!)} (${formatWholeDollars(Math.min(...values))} to ${formatWholeDollars(Math.max(...values))}, ${values.length}×)`);
    const triggers = cash.leapsTriggers;
    const bought = triggers.filter((trigger) => trigger.boughtOn !== null);
    const unaffordable = triggers.filter((trigger) => trigger.boughtOn === null && trigger.contractCost !== null && trigger.contractCost > trigger.freeCash);
    const leapsPart = triggers.length === 0 ? "no LEAPS trigger" : `${triggers.length} LEAPS trigger(s), ${bought.length} bought (${bought.map((trigger) => `${trigger.contracts}× on ${trigger.boughtOn}`).join(", ") || "none"})${unaffordable.length === 0 ? "" : `, ${unaffordable.length} never affordable (first: free cash ${formatWholeDollars(unaffordable[0]!.freeCash)} on ${unaffordable[0]!.dateIso}, a contract ${formatWholeDollars(unaffordable[0]!.contractCost!)})`}`;
    return [`${symbols.length > 1 ? `${symbol}: ` : ""}${cash.cycles} cycle(s); unspent once sized: first half ${left(cash.firstHalfLeft)}, second half ${left(cash.secondHalfLeft)}; ${leapsPart}`];
  });
  return parts.length === 0 ? null : `Vol Farmer v2 cash: ${parts.join(" · ")}.`;
}
