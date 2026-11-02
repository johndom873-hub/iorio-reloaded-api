import { db } from "../db/connection.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { sharesPerContract } from "../backtest/engine/backtestBook.js";
import { baselineQuoteRejection } from "../backtest/engine/baselineSaleSteps.js";
import { newVolFarmerV2SymbolState, runVolFarmerV2Turn, volFarmerV2TurnOrder, type VolFarmerV2Market, type VolFarmerV2SymbolState } from "../backtest/engine/volFarmerV2Steps.js";
import type { BacktestVolFarmerV3Settings } from "../backtest/backtestTypes.js";
import { loadStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { liveExpiryStrikes } from "../ibkr/liveOptionChainLookups.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import { accountContextFromTotalCash } from "../lib/accountContext.js";
import { loadCommissionEstimator, loadStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { fetchOpenCycleSummaryRowsByTickerId } from "../lib/cycleBreakEvenQueries.js";
import { formatWholeDollars } from "../lib/formatWholeDollars.js";
import { loadLiveTradingSessions } from "../lib/liveTradingSessions.js";
import { summarizeOpenCycleFromRows } from "../lib/cycleInputRows.js";
import { blackScholesDelta, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { strategyDeltaVerdict, type StrategyDeltaContext } from "../lib/strategyOrderGates.js";
import { daysToExpiry, describeExpiry } from "../lib/optionContractLabel.js";
import { optionMidLimitPrice } from "../lib/optionLimitPrice.js";
import { strategyBookCapitalVerdict, loadCommittedCapitalOnSymbols } from "../lib/orderLimits.js";
import { computeTickerExposure } from "../lib/positionExposure.js";
import { yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { frozenSymbolSet } from "../lib/tickerFreeze.js";
import { loadInFlightNotionals, loadInFlightNotionalsBySymbol, loadLastFilledPlutoActionAtBySymbol } from "./book.js";
import { executePlutoOrder, watchPlutoOrder, type ExecuteInput } from "./executor.js";
import { defaultOptionQuoteBandPlannerDependencies } from "./optionQuoteBandPlanLoader.js";
import { expiriesWithoutPreviousSessionVolume, nextListedExpiryAfter, optionQuoteBandDayUniverse, volFarmerV4ExpiryRule } from "./optionQuoteBandPlan.js";
import { loadFinishedOptionQuoteBandCycle, loadOptionQuoteBandQuotes } from "./optionQuoteBandQuotes.js";
import { latestCycleQuotes } from "./latestBandQuotes.js";
import { loadOpenPositionFigures } from "./openPositionFigures.js";
import { loadSafetyLimitBookCounts, plutoOrdersSentToday } from "./safetyLimits.js";
import { recordPlutoAction, recordPlutoEvent, type PlutoActionKind, type PlutoGateResult } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { tickerCooldownStatus } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, tickerPotFraction, type PlutoTickerSettings } from "./tickerSettingsStore.js";
import {
  adoptVolFarmerV4Holdings,
  createVolFarmerV4LiveBook,
  pendingVolFarmerV4Order,
  replaceVolFarmerV4LegRef,
  settleVolFarmerV4Order,
  sharesOfPlannedOrder,
  unfilledVolFarmerV4Outcome,
  volFarmerV4RulesOf,
  type VolFarmerV4PendingOrder,
  type VolFarmerV4PlannedOrder,
} from "./volFarmerV4LiveBook.js";
import { loadVolFarmerV4LeftoverStockLeg, loadVolFarmerV4LegStatuses, loadVolFarmerV4Memory, loadVolFarmerV4OrderOutcomes, loadVolFarmerV4StepImpliedVolatility, saveVolFarmerV4LastRound, saveVolFarmerV4Memory, type VolFarmerV4RoundFigures } from "./volFarmerV4LookLoader.js";

// One Pluto round under Vol Farmer v4 (Marcelo 2026-10-31; Vol Farmer v2's from 2026-10-27): every enabled ticker gets a
// look at every round (its rules at every look, as the lab's "every look"), on its live book
// (volFarmerV4LiveBook.ts) and the market quote loop's band quotes, and the orders the shared steps place go out within the
// Safety Limits' caps (safetyLimits.ts; Marcelo 2026-10-27, answer d): the
// ticker's working orders, orders a day and open positions, the book's open positions and orders a day, and Pluto's
// capital budget. Each option order is re-quoted live, held to v4's spread limit and |delta| ranges (a LEAPS to its spread
// limit only), priced at the mid on the option's tick and sent through Pluto's executor; one that fails a check, or a cap
// holds, is undone and planned afresh at a later round. While SPY's stress level holds, v4 opens nothing; a sale of LEAPS
// or shares still goes. A LEAPS is quoted when the steps ask for one: the strikes of its expiry (stored, else looked up
// live) whose Black-Scholes |delta| at IBKR's 30-day IV is nearest the LEAPS |delta|, as many as a quote burst takes.
// The tickers share Pluto's budget (Marcelo 2026-10-28), each with its allocation as its pot: they look in the day's turn
// (alphabetical, starting one ticker further each day), a new cycle buys no more lots than the free cash pays for, and
// the LEAPS go last: a second pass looks again at the tickers whose LEAPS purchase or top-up is due and sends only those,
// on the free cash every ticker's first pass left. What the free cash cut is in the ticker's notes.
// v4's share orders (Marcelo 2026-10-31): a look that rebalances, or buys a first position on a day it sells no option,
// sends that share order alone once no other order of the ticker works, at the mid of Pluto's own stock quote; its option
// orders, planned on the shares after it, are undone and planned again once it ends, and the ticker waits while it works.
// The account is a cash account (Marcelo 2026-10-31): the free cash is also held to the settled cash left, IBKR's settled
// cash less the cash the open Puts hold, the orders in flight and the round's earlier orders; with no settled cash
// reported, nothing is bought and no Put sold.

/** The expiry v4 sells today under its Options expiry setting (YYYY-MM-DD): today's, when one ends at the close, or the next listed after today. */
export function volFarmerV4SoldExpiry(expirations: readonly string[], todayIso: string, optionsExpiry: BacktestVolFarmerV3Settings["optionsExpiry"]): string | null {
  if (optionsExpiry === "next") return nextListedExpiryAfter(expirations, todayIso);
  return expirations.includes(todayIso.replaceAll("-", "")) ? todayIso : null;
}

/**
 * Why the option quote band has no Call of the expiry v4 sells (it quotes that expiry, optionQuoteBandPlan.ts). An expiry
 * without the previous session's volume is quoted whole (the 20% rule is lifted on it), so only a captured expiry can lack
 * a Call that traded enough. Example: a 30 Oct (2DTE) Call that traded 4 contracts the day before is under the 5 one
 * contract needs.
 */
export function volFarmerV4NoCallQuotedReason(input: {
  todayIso: string;
  /** The stored chain's expiries, YYYYMMDD. */
  expirations: readonly string[];
  strikesByExpiry: ReadonlyMap<string, readonly number[]>;
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  /** Whether the band has finished a cycle on the ticker today. */
  bandCycleFinished: boolean;
  optionsExpiry: BacktestVolFarmerV3Settings["optionsExpiry"];
}): string {
  const soldExpiry = volFarmerV4SoldExpiry(input.expirations, input.todayIso, input.optionsExpiry);
  if (soldExpiry === null) return input.optionsExpiry === "next" ? "no Call expiry listed after today" : "no Call expiry ends today";
  const expiry = describeExpiry(soldExpiry, input.todayIso);
  const universe = optionQuoteBandDayUniverse({ expirations: input.expirations, strikesByExpiry: input.strikesByExpiry, sessionIso: input.todayIso, expiryRule: volFarmerV4ExpiryRule({ volFarmerV4OptionsExpiry: input.optionsExpiry }), previousSessionVolumeByContract: input.previousSessionVolumeByContract });
  if (!universe.some((contract) => contract.right === "C")) return `no ${expiry} Call traded enough in the previous session to sell one (the 20% volume rule needs a volume of 5 or more)`;
  if (!input.bandCycleFinished) return `no ${expiry} option is quoted yet today`;
  return `no ${expiry} Call is near v4's Call |delta| range at this price, so none is quoted`;
}

export interface VolFarmerV4RoundInput {
  passId: string;
  settings: PlutoSettings;
  api: InternalApiClient;
  marketWatch: PlutoMarketWatch;
  trackWatch: (promise: Promise<unknown>, orderId: string, symbol: string) => void;
  now: Date;
  todayIso: string;
  totalCashValue: number | null;
  /** IBKR's settled cash (the cash account's): null when IBKR reported none, and then nothing is bought. */
  settledCashValue: number | null;
  netLiquidationValue: number;
  cancelByMs: number | null;
  /** Only these symbols (a round about some tickers); empty = every enabled ticker. */
  symbols: string[];
  /** SPY's stress level holds: no opening order, a sale of LEAPS or shares only. */
  stressed: boolean;
}

export interface VolFarmerV4RoundSummary {
  looked: string[];
  planned: number;
  sent: number;
  notes: string[];
}

/** An option order the round sends, ready for the executor: what it is, its live price and its record. */
interface VolFarmerV4OrderToSend {
  order: VolFarmerV4PlannedOrder;
  kind: PlutoActionKind;
  contract: { strategyKey: "covered_call" | "cash_secured_put" | "leaps"; expiry: string; strike: number; right: "C" | "P" };
  contracts: number;
  chosenBecause: string;
  scores: Record<string, number | null>;
  side: "sell" | "buy";
  /** A LEAPS sale: the leg sold and its position. */
  leg?: { legId: string; positionId: string };
}

const isShareOrder = (order: VolFarmerV4PlannedOrder) => order.kind === "buy_shares" || order.kind === "sell_shares";

export async function runVolFarmerV4Round(input: VolFarmerV4RoundInput): Promise<VolFarmerV4RoundSummary> {
  const { settings, now } = input;
  const [enabled, frozen, clock, optionCommissions, stockCommissions, account, settledAccount, lastFilledAtBySymbol] = await Promise.all([
    loadEnabledPlutoTickerSettings(),
    frozenSymbolSet(),
    defaultOptionQuoteBandPlannerDependencies.loadClock(input.todayIso),
    loadCommissionEstimator(),
    loadStockCommissionEstimator(),
    accountContextFromTotalCash(input.totalCashValue),
    accountContextFromTotalCash(input.settledCashValue),
    loadLastFilledPlutoActionAtBySymbol(),
  ]);
  const summary: VolFarmerV4RoundSummary = { looked: [], planned: 0, sent: 0, notes: [] };
  const v4Tickers = enabled.filter((ticker) => input.symbols.length === 0 || input.symbols.includes(ticker.symbol));
  if (v4Tickers.length === 0) return summary;
  // The tickers share Pluto's budget (Marcelo 2026-10-28): they take their turn in the day's order, so the one that finds
  // the free cash short is a different one each day.
  const turnOrder = volFarmerV2TurnOrder(v4Tickers.map((ticker) => ticker.symbol), Math.round(Date.parse(`${input.todayIso}T00:00:00Z`) / 86_400_000));
  const tickers = [...v4Tickers].sort((a, b) => turnOrder.indexOf(a.symbol) - turnOrder.indexOf(b.symbol));
  const allocationBySymbol = effectiveAllocationPctBySymbol(enabled);
  const [bookCounts, bookCommittedAtStart, inFlightAtStart] = await Promise.all([loadSafetyLimitBookCounts(enabled, now), loadCommittedCapitalOnSymbols(enabled.map((ticker) => ticker.symbol)), loadInFlightNotionalsBySymbol()]);
  // What the round's own orders commit is counted once: the book's commitment and the orders in flight are read at its
  // start, and each order it sends adds to them as it goes.
  const round = {
    bookCounts,
    bookCommitted: bookCommittedAtStart,
    /** Cash the round's earlier orders tie up, gone for the next tickers. */
    committedThisRound: 0,
    accountInFlightAtStart: inFlightAtStart.totalNotional,
    optionCommissionDollars: (contracts: number) => optionCommissions.perContractDollars("sell", contracts) * contracts,
    stockCommissionDollars: (shares: number) => stockCommissions.perShareDollars("buy") * shares,
    commissions: { option: optionCommissions, stock: stockCommissions },
    accountFreeCash: account.freeCash,
    settledFreeCash: input.settledCashValue === null ? null : settledAccount.freeCash,
  };
  const lastRounds = new Map<string, LastRound>();
  const potDollarsOf = (ticker: PlutoTickerSettings) => tickerPotFraction(allocationBySymbol.get(ticker.symbol) ?? 0, settings) * input.netLiquidationValue;
  const leapsDue: PlutoTickerSettings[] = [];
  try {
    // Every ticker's new cycle, Calls and Puts first; then, in the same order, the LEAPS due, on the free cash left.
    for (const ticker of tickers) {
      const lastRound: LastRound = { notes: [], figures: null };
      lastRounds.set(ticker.symbol, lastRound);
      if (frozen.has(ticker.symbol)) {
        lastRound.notes.push("frozen (a split is pending), not traded");
        continue;
      }
      const cooldown = tickerCooldownStatus(lastFilledAtBySymbol.get(ticker.symbol) ?? null, now.getTime(), settings.safetyTickerCooldownMinutes);
      if (settings.safetyTickerCooldownMinutes > 0 && !cooldown.cooledDown) {
        lastRound.notes.push(`ticker cooldown, ${cooldown.detail}`);
        continue;
      }
      const looked = await lookAtTicker({ input, ticker, potDollars: potDollarsOf(ticker), clock, round, summary, lastRound, pass: "cycles_calls_puts" });
      if (looked.leapsDue) leapsDue.push(ticker);
    }
    for (const ticker of leapsDue) await lookAtTicker({ input, ticker, potDollars: potDollarsOf(ticker), clock, round, summary, lastRound: lastRounds.get(ticker.symbol)!, pass: "leaps" });
  } finally {
    for (const ticker of tickers) {
      const lastRound = lastRounds.get(ticker.symbol);
      if (lastRound === undefined) continue;
      summary.notes.push(...lastRound.notes.map((text) => `${ticker.symbol}: ${text}`));
      await saveVolFarmerV4LastRound(ticker.tickerId, { at: now, notes: lastRound.notes, figures: lastRound.figures });
    }
  }
  return summary;
}

/** What the round said about a ticker and the figures the screen's warnings read, saved for the Pluto screen. */
interface LastRound {
  notes: string[];
  figures: VolFarmerV4RoundFigures | null;
}

type RoundState = {
  bookCounts: Awaited<ReturnType<typeof loadSafetyLimitBookCounts>>;
  bookCommitted: number;
  committedThisRound: number;
  /** The notional of every order in flight on the account when the round began. */
  accountInFlightAtStart: number;
  optionCommissionDollars(contracts: number): number;
  stockCommissionDollars(shares: number): number;
  commissions: VolFarmerV2Market["commissions"];
  accountFreeCash: number;
  /** IBKR's settled cash less the cash the open Puts hold; null when IBKR reported no settled cash. */
  settledFreeCash: number | null;
};

/** The ticker's caps an opening order counts under: why it waits, or null when they leave room for it. */
type TickerCounts = { working: number; ordersToday: number; openPositions: number };

function capHolding(settings: PlutoSettings, tickerCounts: TickerCounts, round: RoundState): string | null {
  const caps: [number, string][] = [
    [settings.safetyMaxWorkingOrdersPerTicker - tickerCounts.working, `${tickerCounts.working} of the ticker's orders are working, at most ${settings.safetyMaxWorkingOrdersPerTicker} at once`],
    [settings.safetyMaxOrdersPerTickerPerDay - tickerCounts.ordersToday, `${tickerCounts.ordersToday} of the ticker's ${settings.safetyMaxOrdersPerTickerPerDay} orders a day are sent`],
    [settings.safetyMaxOpenPositionsPerTicker - tickerCounts.openPositions - tickerCounts.working, `the ticker has ${tickerCounts.openPositions} open position(s) and ${tickerCounts.working} working order(s), at most ${settings.safetyMaxOpenPositionsPerTicker} positions`],
    [settings.safetyMaxOpenPositions - round.bookCounts.openPositions - round.bookCounts.workingOrders, `Pluto's tickers have ${round.bookCounts.openPositions} open position(s) and ${round.bookCounts.workingOrders} working order(s), at most ${settings.safetyMaxOpenPositions}`],
    [settings.safetyMaxOrdersPerDay - round.bookCounts.ordersToday, `${round.bookCounts.ordersToday} of Pluto's ${settings.safetyMaxOrdersPerDay} orders a day are sent`],
  ];
  return caps.find(([room]) => room < 1)?.[1] ?? null;
}

/**
 * A ticker's look at one of the round's passes: "cycles_calls_puts" runs v4's steps 1 to 3 and sends their orders,
 * answering whether its LEAPS (a purchase or a top-up) is due; "leaps" looks again, after every ticker's first pass, and
 * sends only the LEAPS, on the free cash left then.
 */
async function lookAtTicker(context: { input: VolFarmerV4RoundInput; ticker: PlutoTickerSettings; potDollars: number; clock: Awaited<ReturnType<typeof defaultOptionQuoteBandPlannerDependencies.loadClock>>; round: RoundState; summary: VolFarmerV4RoundSummary; lastRound: LastRound; pass: "cycles_calls_puts" | "leaps" }): Promise<{ leapsDue: boolean }> {
  const { input, ticker, potDollars, clock, round, summary, lastRound, pass } = context;
  const { settings, now } = input;
  const { symbol, tickerId } = ticker;
  const note = (text: string) => lastRound.notes.push(text);
  const nothingDue = { leapsDue: false };

  // 1. The orders sent at earlier rounds that are done replace their plan with their fills.
  let memory = await loadVolFarmerV4Memory(tickerId);
  if (memory !== null && memory.pending.length > 0) {
    const outcomes = await loadVolFarmerV4OrderOutcomes(memory.pending.map((order) => order.actionId));
    const stillWorking: VolFarmerV4PendingOrder[] = [];
    for (const order of memory.pending) {
      const outcome = outcomes.get(order.actionId) ?? unfilledVolFarmerV4Outcome;
      if (outcome.working) stillWorking.push(order);
      else {
        const settled = settleVolFarmerV4Order(memory.state, order, outcome);
        if (settled !== null) note(settled);
      }
    }
    memory.pending = stillWorking;
  }
  // A share order still working: the ticker waits for it, its options to be planned on the shares it ends with.
  const workingShareOrder = memory?.pending.find((order) => order.kind === "buy_shares" || order.kind === "sell_shares");
  if (memory !== null && workingShareOrder !== undefined) {
    if (pass === "cycles_calls_puts") note(`waits for its ${workingShareOrder.kind === "buy_shares" ? "purchase" : "sale"} of ${workingShareOrder.shares ?? 0} shares to end`);
    await saveVolFarmerV4Memory(tickerId, memory, false);
    return nothingDue;
  }

  // 2. The ticker's holdings: a first look adopts them (or starts afresh when flat).
  const positions = await loadOpenPositionFigures(tickerId);
  const openLegs = positions.flatMap((position) => position.legs.filter((leg) => leg.exitAt === null));
  let adopted = false;
  if (memory === null) {
    if (openLegs.length === 0) memory = { state: newVolFarmerV2SymbolState(), pending: [] };
    else {
      const cycleRows = (await fetchOpenCycleSummaryRowsByTickerId([tickerId])).get(tickerId);
      const cycle = cycleRows ? summarizeOpenCycleFromRows(tickerId, cycleRows) : null;
      const adoption = adoptVolFarmerV4Holdings({ positions, cycleBreakEvenPerShare: cycle?.breakEvenPerShare ?? null, potDollars });
      if ("waiting" in adoption) {
        note(adoption.waiting);
        return nothingDue;
      }
      memory = { state: adoption.state, pending: [] };
      adopted = true;
      const contractsOf = (entries: readonly { shares: number }[]) => Math.round(entries.reduce((sum, entry) => sum + entry.shares, 0) / sharesPerContract);
      await recordPlutoEvent("holdings_adopted", {
        passId: input.passId,
        symbol,
        strategy: "vol_farmer_v4",
        shares: adoption.state.first!.shares,
        breakEvenPerShare: adoption.state.first!.costPerShare,
        callContracts: contractsOf(adoption.state.first!.calls),
        putContracts: contractsOf(adoption.state.second?.puts ?? []),
      });
    }
  }

  // 3. The market and the book at this round.
  const [prices, bandQuotes, bandCycle, forwardAnchors, previousSessionVolumeByContract, stepImpliedVolatility, chain, inFlight, tickerExposure] = await Promise.all([
    fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol }]),
    loadOptionQuoteBandQuotes(tickerId, clock.todayIso),
    loadFinishedOptionQuoteBandCycle(tickerId, clock.todayIso),
    defaultOptionQuoteBandPlannerDependencies.loadForwardAnchors(tickerId, clock.todayIso),
    defaultOptionQuoteBandPlannerDependencies.loadPreviousSessionVolume(tickerId, clock.todayIso),
    loadVolFarmerV4StepImpliedVolatility(tickerId, clock.todayIso),
    loadStoredOptionChain(tickerId),
    loadInFlightNotionals(symbol),
    computeTickerExposure(symbol),
  ]);
  const stockPrice = prices["stock"] ?? null;
  if (stockPrice === null || !(stockPrice > 0)) {
    note("no live stock price");
    await saveVolFarmerV4Memory(tickerId, memory, adopted);
    return nothingDue;
  }
  const { quotes, stale } = latestCycleQuotes(bandQuotes, bandCycle, now, settings.maxQuoteAgeMinutes);
  if (stale) {
    note(`the band's latest quotes are older than ${settings.maxQuoteAgeMinutes} minutes, so nothing is planned`);
    await saveVolFarmerV4Memory(tickerId, memory, adopted);
    return nothingDue;
  }
  const memoryLegIds = legIdsOf(memory.state).filter((legId) => !legId.startsWith("action:") && !legId.startsWith("planned:"));
  const openOptionLegs = openLegs.filter((leg) => leg.legType === "option" && leg.expiryDate !== null && leg.strikePrice !== null);
  const legStatusById = await loadVolFarmerV4LegStatuses([...new Set([...memoryLegIds, ...openOptionLegs.map((leg) => leg.id)])]);
  const budgetFree = (settings.capitalBudgetPct / 100) * input.netLiquidationValue - round.bookCommitted;
  const accountFree = round.accountFreeCash - round.accountInFlightAtStart - round.committedThisRound;
  // The cash account's settled cash left (Marcelo 2026-10-31): IBKR's settled cash less what the open Puts hold, the
  // orders in flight and the round's earlier orders. Example: $40,000 settled, a $5,000 purchase working and $10,000
  // bought earlier this round leave $25,000.
  const settledFree = round.settledFreeCash === null ? 0 : round.settledFreeCash - round.accountInFlightAtStart - round.committedThisRound;
  if (round.settledFreeCash === null && pass === "cycles_calls_puts") note("IBKR reports no settled cash, so the free cash is 0: nothing is bought and no Put sold");
  const snapshot = {
    legStatusById,
    openOptionContracts: openOptionLegs.map((leg) => ({ expiry: leg.expiryDate!, strike: leg.strikePrice! })),
    flat: openLegs.length === 0,
    freeCash: Math.max(0, Math.min(budgetFree, accountFree, settledFree)),
    potDollars,
    stockPrice,
    optionCommissionDollars: round.optionCommissionDollars,
    stockCommissionDollars: round.stockCommissionDollars,
  };
  lastRound.figures = { potDollars, committedDollars: tickerExposure + inFlight.tickerNotional, freeCashDollars: snapshot.freeCash, leapsCapDollars: (potDollars * settings.volFarmerV4LeapsMaxAllocationPct) / 100, putsDollars: (potDollars * (100 - settings.volFarmerV4FirstPositionPct)) / 100 };
  const listedExpiries = chain.expirations
    .map((expiry) => `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`)
    .filter((expiry) => expiry >= clock.todayIso)
    .sort();
  const { farmer, v2, v3 } = volFarmerV4RulesOf(settings);
  // The expiry v4 sells, without the previous session's volume: the 20% volume rule is lifted on it for the day.
  const soldExpiry = volFarmerV4SoldExpiry(chain.expirations, clock.todayIso, v3.optionsExpiry);
  const volumeLimitLiftedExpiries = expiriesWithoutPreviousSessionVolume(soldExpiry === null ? [] : [soldExpiry], previousSessionVolumeByContract);
  if (pass === "cycles_calls_puts" && soldExpiry !== null && volumeLimitLiftedExpiries.has(soldExpiry)) note(`no previous-session volume for ${describeExpiry(soldExpiry, clock.todayIso)}: the 20% volume rule is off for it today`);
  const soldExpiryCallQuoted = soldExpiry !== null && quotes.some((quote) => quote.right === "C" && quote.expiry === soldExpiry);
  const noCallQuotedReason = soldExpiryCallQuoted
    ? undefined
    : volFarmerV4NoCallQuotedReason({ todayIso: clock.todayIso, expirations: chain.expirations, strikesByExpiry: chain.strikesByExpiry, previousSessionVolumeByContract, bandCycleFinished: bandCycle !== null, optionsExpiry: v3.optionsExpiry });
  // On an expiry day the steps sell on it even before (or without) a Call of it quoted, as the lab's day does; they word
  // the Calls they find none of, and this says why.
  if (pass === "cycles_calls_puts" && v3.optionsExpiry === "today" && soldExpiry !== null && noCallQuotedReason !== undefined) note(noCallQuotedReason);
  const liveSessions = await loadLiveTradingSessions(now);
  const marketWith = (leapsQuotesByExpiry: ReadonlyMap<string, SymbolFileQuote[]>, missing: Set<string>): VolFarmerV2Market => ({
    symbol,
    todayIso: clock.todayIso,
    stockPrice,
    riskFreeRate: clock.riskFreeRate,
    quotes,
    forwardAnchors,
    previousSessionVolumeByContract,
    volumeLimitLiftedExpiries,
    yearsToTodaysClose: yearsToSessionClose(now, clock.closeMinutesEt),
    yearsToExpiry: (expiry) => yearsBetweenIsoDates(clock.todayIso, expiry),
    leapsCallQuotes: {
      listedExpiries: () => listedExpiries,
      quotesOf: (expiry) => {
        const known = leapsQuotesByExpiry.get(expiry);
        if (known === undefined) missing.add(expiry);
        return known ?? [];
      },
    },
    stepImpliedVolatility: () => stepImpliedVolatility,
    tradingSessionsThrough: liveSessions.sessionsHeldTo,
    priceToCycleScale: 1,
    optionContractsRepresentable: true,
    spreadShareCharged: 0,
    commissions: round.commissions,
    optionCommissionDollars: round.optionCommissionDollars,
    stockCommissionDollars: round.stockCommissionDollars,
    leapsCapBaseLabel: "the ticker's pot",
    capsLeapsAtAskSize: false,
    noCallQuotedReason,
    expiryEndsToday: v3.optionsExpiry === "today" ? soldExpiry !== null : undefined,
  });
  // The first pass says what steps 1 to 3 did and leaves the LEAPS to the second, which says what only the LEAPS did (and
  // the free cash cut).
  const runOnce = (leapsQuotesByExpiry: ReadonlyMap<string, SymbolFileQuote[]>) => {
    const state = structuredClone(memory!.state);
    const missing = new Set<string>();
    const { book, planned, cashCutNotes } = createVolFarmerV4LiveBook({ state, pending: memory!.pending, snapshot });
    const turn = runVolFarmerV2Turn({ state, market: marketWith(leapsQuotesByExpiry, missing), farmer, v2, v3, book });
    if (pass === "cycles_calls_puts") {
      const turnNote = turn.note();
      return { state, planned, missing, leapsDue: turn.leaps !== null, notes: turnNote === null ? [] : [turnNote.slice(`${symbol}: `.length)] };
    }
    const leapsNote = turn.leaps?.() ?? null;
    return { state, planned, missing, leapsDue: false, notes: [...(leapsNote === null ? [] : [leapsNote]), ...cashCutNotes] };
  };
  // The steps ask for a LEAPS expiry's quotes only when they buy, top up or sell one: quoted then, and the look run again.
  let look = runOnce(new Map());
  if (look.missing.size > 0) {
    const leapsQuotesByExpiry = new Map<string, SymbolFileQuote[]>();
    for (const expiry of look.missing) leapsQuotesByExpiry.set(expiry, await quoteLeapsExpiry({ input, ticker, expiry, stockPrice, riskFreeRate: clock.riskFreeRate, impliedVolatility: stepImpliedVolatility, heldStrike: memory.state.leaps?.expiry === expiry ? memory.state.leaps.strike : null, storedStrikes: chain.strikesByExpiry.get(expiry.replaceAll("-", "")) ?? null, absDelta: v2.leapsAbsDelta }));
    look = runOnce(leapsQuotesByExpiry);
  }
  if (pass === "cycles_calls_puts") summary.looked.push(symbol);
  lastRound.notes.push(...look.notes);

  // 4. The orders, in the steps' order: each one not sent is undone, as if never placed. The second pass sends the LEAPS
  // only: what steps 1 to 3 plan again went out at the first (or waits for a later round). A look that trades shares sends
  // that order alone, once no other order of the ticker works: its option orders were planned on the shares after it.
  const state = look.state;
  const pending = [...memory.pending];
  const undo = (order: VolFarmerV4PlannedOrder) => {
    const unsent = pendingVolFarmerV4Order(state, order, `unsent-${order.ref}`, round.optionCommissionDollars);
    replaceVolFarmerV4LegRef(state, order.ref, unsent.ref);
    settleVolFarmerV4Order(state, unsent, unfilledVolFarmerV4Outcome);
  };
  const shareOrder = pass === "cycles_calls_puts" ? look.planned.find(isShareOrder) : undefined;
  const toSend = shareOrder !== undefined ? (pending.length === 0 ? [shareOrder] : []) : look.planned.filter((order) => (pass === "cycles_calls_puts" ? !isShareOrder(order) : order.kind === "buy_leaps"));
  // Undone last first: undoing a share sale restores the positions it started from, so the orders planned on them go before it.
  for (const order of [...look.planned].reverse()) if (!toSend.includes(order)) undo(order);
  if (shareOrder !== undefined) {
    if (toSend.length === 0) note(`${describePlanned(shareOrder)} waits for the ticker's ${pending.length} working order(s) to end`);
    if (look.planned.length > 1) note("its option orders are planned again once the share order ends");
  }
  summary.planned += toSend.length;
  const tickerCounts: TickerCounts = { working: pending.length, ordersToday: Number(((await plutoOrdersSentToday(now, symbol)) as { count?: string | number } | undefined)?.count ?? 0), openPositions: positions.length };
  for (const order of toSend) {
    const opening = order.kind !== "sell_leaps" && order.kind !== "sell_shares";
    if (input.stressed && opening) {
      note(`market stress: ${describePlanned(order)} is not sent while SPY is down`);
      undo(order);
      continue;
    }
    if (isShareOrder(order)) {
      const result = await sendShareOrder({ input, ticker, order, clock, round, tickerCounts });
      if (result.actionId === null) {
        note(result.detail);
        undo(order);
        continue;
      }
      if (!result.sent) note(result.detail);
      else summary.sent += 1;
      pending.push(pendingVolFarmerV4Order(state, order, result.actionId, round.optionCommissionDollars));
      continue;
    }
    const items = await ordersToSend(order);
    if (items.length === 0) {
      note(`${describePlanned(order)}: no LEAPS leg found to sell`);
      undo(order);
      continue;
    }
    const sent: VolFarmerV4PendingOrder[] = [];
    for (const item of items) {
      const result = await sendOrder({ input, ticker, item, stockPrice, forwardAnchors, clock, round, tickerCounts, farmer, v2 });
      if (result.actionId === null) {
        note(result.detail);
        continue;
      }
      const pendingOrder = pendingVolFarmerV4Order(state, order, result.actionId, round.optionCommissionDollars);
      sent.push(item.leg ? { ...pendingOrder, contracts: item.contracts } : pendingOrder);
      if (!result.sent) note(result.detail);
      else summary.sent += 1;
    }
    if (sent.length === 0) {
      undo(order);
      continue;
    }
    // The order's legs in the state take the reference of its first action; a LEAPS sale of several legs has one per leg.
    replaceVolFarmerV4LegRef(state, order.ref, sent[0]!.ref);
    pending.push(...sent);
  }
  await saveVolFarmerV4Memory(tickerId, { state, pending }, adopted);
  return { leapsDue: look.leapsDue && shareOrder === undefined };
}

/** Every leg reference the state holds. */
function legIdsOf(state: VolFarmerV2SymbolState): string[] {
  return [...[state.first, state.second].flatMap((position) => (position === null ? [] : [...position.calls, ...position.puts].map((entry) => entry.legId))), ...(state.leaps?.legIds ?? [])];
}

function describePlanned(order: VolFarmerV4PlannedOrder): string {
  if (order.kind === "buy_shares") return order.order.description;
  if (order.kind === "sell_shares") return order.orders.map((part) => part.description).join(" · ");
  if (order.kind === "buy_leaps") return order.purchase.description;
  return order.sale.description;
}

/** What a planned option order sends: one order, or for a LEAPS sale one per leg still held (a purchase and its top-ups). */
async function ordersToSend(order: VolFarmerV4PlannedOrder): Promise<VolFarmerV4OrderToSend[]> {
  if (order.kind === "covered_call" || order.kind === "cash_secured_put") {
    const { candidate, contracts, chosenBecause, candidateScores } = order.sale;
    const isCall = order.kind === "covered_call";
    return [{ order, kind: isCall ? "open_covered_call" : "open_cash_secured_put", contract: { strategyKey: order.kind, expiry: candidate.expiry, strike: candidate.strike, right: isCall ? "C" : "P" }, contracts, chosenBecause, scores: candidateScores, side: "sell" }];
  }
  if (order.kind === "buy_leaps") {
    const { purchase } = order;
    return [{ order, kind: "buy_leaps", contract: { strategyKey: "leaps", expiry: purchase.expiry, strike: purchase.strike, right: "C" }, contracts: purchase.contracts, chosenBecause: purchase.chosenBecause, scores: purchase.candidateScores, side: "buy" }];
  }
  if (order.kind !== "sell_leaps") return [];
  const { sale } = order;
  const legs: { id: string; position_id: string; quantity: number; exit_at: Date | null }[] = await db("position_legs").whereIn("id", sale.legIds).select("id", "position_id", "quantity", "exit_at");
  return legs
    .filter((leg) => leg.exit_at === null)
    .map((leg) => ({ order, kind: "sell_leaps" as const, contract: { strategyKey: "leaps" as const, expiry: sale.expiry, strike: sale.strike, right: "C" as const }, contracts: leg.quantity, chosenBecause: sale.chosenBecause, scores: sale.candidateScores, side: "sell" as const, leg: { legId: leg.id, positionId: leg.position_id } }));
}

/**
 * One option order: the caps (an opening order), the live quote, v4's checks on it, the mid on the tick, then the executor.
 * Answers the action recorded (null when the caps held it before any action), whether an order went to IBKR, and why not.
 */
async function sendOrder(context: {
  input: VolFarmerV4RoundInput;
  ticker: PlutoTickerSettings;
  item: VolFarmerV4OrderToSend;
  stockPrice: number;
  forwardAnchors: ReadonlyMap<string, { forward: number; spotPrice: number }>;
  clock: { todayIso: string; closeMinutesEt: number; riskFreeRate: number };
  round: RoundState;
  tickerCounts: TickerCounts;
  farmer: ReturnType<typeof volFarmerV4RulesOf>["farmer"];
  v2: ReturnType<typeof volFarmerV4RulesOf>["v2"];
}): Promise<{ actionId: string | null; sent: boolean; detail: string }> {
  const { input, ticker, item, stockPrice, clock, round, tickerCounts, farmer, v2 } = context;
  const { settings } = input;
  const opening = item.kind !== "sell_leaps";
  const description = `${item.side === "buy" ? "Buy" : "Sell"} ${item.contracts}× ${item.contract.strike} ${item.contract.right === "C" ? "Call" : "Put"} ${item.contract.expiry}`;

  // The caps Pluto's opening orders count under; a LEAPS sale only reduces what is held.
  if (opening) {
    const held = capHolding(settings, tickerCounts, round);
    if (held !== null) return { actionId: null, sent: false, detail: `${description} waits for a later round: ${held}` };
  }

  const contract = { expiry: item.contract.expiry, strike: item.contract.strike, right: item.contract.right };
  const [live] = await input.marketWatch.burst(ticker.symbol, [contract]);
  const now = new Date();
  const twoSided = live && live.bid !== null && live.ask !== null && live.bid > 0 && live.ask > live.bid ? { bid: live.bid, ask: live.ask } : null;
  const limitPrice = twoSided ? optionMidLimitPrice(twoSided.bid, twoSided.ask, item.side) : null;
  const quoteRejection = twoSided ? baselineQuoteRejection(twoSided, farmer.maxSpreadPctOfMid) : null;
  const isLeaps = item.contract.strategyKey === "leaps";
  const isPut = item.contract.right === "P";
  // The Calls are held to v4's Calls' range, the Puts to |delta| at most its Put |delta|; a LEAPS has no range.
  const deltaContext: StrategyDeltaContext = { minAbsDelta: isPut ? 0 : farmer.callMinAbsDelta, maxAbsDelta: isPut ? v2.putMaxAbsDelta : farmer.callMaxAbsDelta, forwardAnchor: context.forwardAnchors.get(item.contract.expiry) ?? null, riskFreeRate: clock.riskFreeRate, todayIso: clock.todayIso, closeMinutesEt: clock.closeMinutesEt };
  const verdict = twoSided && !isLeaps ? strategyDeltaVerdict({ ...twoSided, stockPrice, strike: item.contract.strike, expiryIso: item.contract.expiry, isCall: !isPut, putHeldToRange: isPut, now, context: deltaContext }) : null;
  // A sale is held to the steps' bid minimum and spread limit; a LEAPS purchase or sale to a two-sided quote within the spread limit.
  const ruleFailure = twoSided === null ? null : quoteRejection === "noUsableQuote" && item.side === "sell" && !isLeaps ? `the live bid ${twoSided.bid.toFixed(2)} is under the $0.05 minimum` : quoteRejection === "spreadTooWide" ? `the live spread is ${(((twoSided.ask - twoSided.bid) / ((twoSided.bid + twoSided.ask) / 2)) * 100).toFixed(1)}% of the mid, above v4's ${farmer.maxSpreadPctOfMid}%` : null;
  // A Call that opens a cycle, or rebuilds the first position, buys its shares with it.
  const buysShares = item.order.kind === "covered_call" && (item.order.sale.startsCycle || item.order.sale.buysShares === true);
  const notional = limitPrice === null ? 0 : item.contract.strategyKey === "cash_secured_put" ? Math.max(0, item.contract.strike - limitPrice) * 100 * item.contracts : item.contract.strategyKey === "leaps" ? (opening ? limitPrice * 100 * item.contracts : 0) : buysShares ? item.contracts * 100 * Math.max(0, stockPrice - limitPrice) : 0;
  const capital = opening && limitPrice !== null ? strategyBookCapitalVerdict({ committedBeforeDollars: round.bookCommitted, orderNotional: notional, budgetFraction: settings.capitalBudgetPct / 100, netLiquidationValue: input.netLiquidationValue }) : null;
  const gateResults: PlutoGateResult[] = [
    { gate: "vol_farmer_v4", ok: true, detail: item.chosenBecause },
    { gate: "live_quote", ok: twoSided !== null, detail: twoSided ? `bid ${twoSided.bid.toFixed(2)}, ask ${twoSided.ask.toFixed(2)}` : "no live two-sided quote" },
    ...(twoSided ? [{ gate: "vol_farmer_v4_rules", ok: ruleFailure === null, detail: ruleFailure ?? "the live quote passes v4's bid and spread rules" }] : []),
    ...(verdict ? [{ gate: "vol_farmer_v4_delta", ok: verdict.compliant, detail: verdict.reason ?? `own |delta| ${Math.abs(verdict.delta ?? 0).toFixed(3)} inside ${deltaContext.minAbsDelta}–${deltaContext.maxAbsDelta}` }] : []),
    ...(capital ? [bookCapitalGate(capital)] : []),
  ];
  const ok = gateResults.every((gate) => gate.ok) && limitPrice !== null && (verdict === null || verdict.compliant);
  const actionId = await recordPlutoAction({
    passId: input.passId,
    kind: item.kind,
    symbol: ticker.symbol,
    tickerId: ticker.tickerId,
    contract: item.contract,
    candidateScores: item.scores,
    deterministicTopPick: null,
    gateResults,
    sizeTier: null,
    quantity: item.contracts,
    limitPrice,
    outcome: ok ? "validated" : "blocked",
    blockReason: ok ? null : gateResults.filter((gate) => !gate.ok).map((gate) => `${gate.gate}: ${gate.detail}`).join(" | "),
    referenceBid: twoSided?.bid ?? null,
    referenceMid: twoSided ? (twoSided.bid + twoSided.ask) / 2 : null,
    executionStrategy: "vol_farmer_v4",
  });
  if (!ok) {
    const detail = gateResults.filter((gate) => !gate.ok).map((gate) => gate.detail).join("; ");
    await recordPlutoEvent("action_blocked", { passId: input.passId, actionId, symbol: ticker.symbol, stage: "vol_farmer_v4", reason: detail });
    return { actionId, sent: false, detail: `${description} blocked: ${detail}` };
  }
  await recordPlutoEvent("action_validated", { passId: input.passId, actionId, symbol: ticker.symbol, quantity: item.contracts, limitPrice, reasons: [item.chosenBecause] });
  const dte = daysToExpiry(item.contract.expiry, clock.todayIso);
  const plan = { quantity: item.contracts, limitPrice: limitPrice!, notional, fullSizeQuantity: item.contracts };
  const reasons = [`Vol Farmer v4: ${item.chosenBecause}.`];
  const scoresSnapshot = { kind: "vol_farmer_v4", version: "vf4-1", contract: { ...contract, bid: twoSided!.bid, ask: twoSided!.ask, quoteSource: "live", quotedAt: live?.quotedAt ?? null, delta: verdict?.delta ?? null }, order: { contracts: item.contracts, chosenBecause: item.chosenBecause, scores: item.scores } };
  const executeInput: ExecuteInput =
    item.kind === "buy_leaps"
      ? { kind: "leaps_buy", actionId, symbol: ticker.symbol, contract: { expiry: contract.expiry, strike: contract.strike, right: "C", dte }, plan, reasons, scoresSnapshot }
      : item.kind === "sell_leaps"
        ? { kind: "leaps_sell", actionId, symbol: ticker.symbol, positionId: item.leg!.positionId, legId: item.leg!.legId, contract: { expiry: contract.expiry, strike: contract.strike, right: "C", dte }, plan, reasons }
        : { kind: "strategy_open", actionId, symbol: ticker.symbol, strategyKey: item.contract.strategyKey as "covered_call" | "cash_secured_put", contract: { ...contract, dte }, plan, buyEveryShare: buysShares, reasons, scoresSnapshot };
  const result = await executePlutoOrder(input.api, settings, executeInput);
  if (result.orderId !== null) {
    round.bookCounts.ordersToday += 1;
    tickerCounts.ordersToday += 1;
  }
  if (result.outcome !== "confirmed" || result.orderId === null) return { actionId, sent: false, detail: `${description}: ${result.detail}` };
  if (opening) {
    tickerCounts.working += 1;
    round.bookCounts.workingOrders += 1;
    round.bookCommitted += notional;
    round.committedThisRound += item.contract.strategyKey === "cash_secured_put" ? item.contract.strike * 100 * item.contracts : item.contract.strategyKey === "leaps" ? limitPrice! * 100 * item.contracts : buysShares ? stockPrice * 100 * item.contracts : 0;
  }
  input.trackWatch(
    watchPlutoOrder(input.api, settings, { actionId, orderId: result.orderId, symbol: ticker.symbol, reference: { price: limitPrice!, side: item.side, multiplier: 100, ...(result.otherReferenceLegs ? { otherLegs: result.otherReferenceLegs } : {}) }, description: result.detail, cancelByMs: input.cancelByMs }),
    result.orderId,
    ticker.symbol,
  );
  return { actionId, sent: true, detail: result.detail };
}

/** The book's capital check as a gate result. */
function bookCapitalGate(capital: ReturnType<typeof strategyBookCapitalVerdict>): PlutoGateResult {
  return { gate: "book_capital", ok: capital.fits, detail: capital.fits ? `Pluto's tickers commit ${capital.committedAfterDollars.toFixed(0)} of ${capital.capDollars.toFixed(0)} after it` : `Pluto's tickers would commit ${capital.committedAfterDollars.toFixed(0)}, above Pluto's capital budget of ${capital.capDollars.toFixed(0)}` };
}

/**
 * One share order (v4's rebalancing, or a first position bought on a day it sells no option): a purchase within the caps
 * and Pluto's capital budget, a sale from the ticker's leftover-stock position, each at the mid of Pluto's own stock
 * quote (bid and ask, no older than the band's quote age), then the executor. Answers as sendOrder does.
 */
async function sendShareOrder(context: { input: VolFarmerV4RoundInput; ticker: PlutoTickerSettings; order: VolFarmerV4PlannedOrder; clock: { todayIso: string }; round: RoundState; tickerCounts: TickerCounts }): Promise<{ actionId: string | null; sent: boolean; detail: string }> {
  const { input, ticker, order, round, tickerCounts } = context;
  const { settings } = input;
  const buying = order.kind === "buy_shares";
  const shares = sharesOfPlannedOrder(order);
  const description = `${buying ? "Buy" : "Sell"} ${shares} shares`;
  if (buying) {
    const held = capHolding(settings, tickerCounts, round);
    if (held !== null) return { actionId: null, sent: false, detail: `${description} waits for a later round: ${held}` };
  }
  // A sale takes the shares from the ticker's leftover-stock position, where the shares no Call covers are.
  const leftover = buying ? null : await loadVolFarmerV4LeftoverStockLeg(ticker.tickerId);
  if (!buying && (leftover === null || leftover.shares < shares)) return { actionId: null, sent: false, detail: `${description}: the leftover-stock position holds ${leftover === null ? "no" : leftover.shares} shares, so none is sold` };

  const quote = input.marketWatch.snapshot(ticker.symbol);
  const nowMs = Date.now();
  const fresh = quote !== null && quote.updatedAtMs !== null && nowMs - quote.updatedAtMs <= settings.maxQuoteAgeMinutes * 60_000;
  const twoSided = fresh && quote.bid !== null && quote.ask !== null && quote.bid > 0 && quote.ask >= quote.bid ? { bid: quote.bid, ask: quote.ask } : null;
  const limitPrice = twoSided ? optionMidLimitPrice(twoSided.bid, twoSided.ask, buying ? "buy" : "sell") : null;
  const notional = buying && limitPrice !== null ? limitPrice * shares : 0;
  const capital = buying && limitPrice !== null ? strategyBookCapitalVerdict({ committedBeforeDollars: round.bookCommitted, orderNotional: notional, budgetFraction: settings.capitalBudgetPct / 100, netLiquidationValue: input.netLiquidationValue }) : null;
  const chosenBecause = buying ? order.order.chosenBecause : order.kind === "sell_shares" ? order.orders[0]!.chosenBecause : "";
  const scores = buying ? order.order.candidateScores : order.kind === "sell_shares" ? order.orders[0]!.candidateScores : {};
  const gateResults: PlutoGateResult[] = [
    { gate: "vol_farmer_v4", ok: true, detail: chosenBecause },
    { gate: "live_quote", ok: twoSided !== null, detail: twoSided ? `stock bid ${twoSided.bid.toFixed(2)}, ask ${twoSided.ask.toFixed(2)}` : `no two-sided stock quote of the last ${settings.maxQuoteAgeMinutes} minutes` },
    ...(capital ? [bookCapitalGate(capital)] : []),
  ];
  const ok = gateResults.every((gate) => gate.ok) && limitPrice !== null;
  const actionId = await recordPlutoAction({
    passId: input.passId,
    kind: buying ? "buy_shares" : "close_shares",
    symbol: ticker.symbol,
    tickerId: ticker.tickerId,
    contract: { strategyKey: "shares" },
    candidateScores: scores,
    deterministicTopPick: null,
    gateResults,
    sizeTier: null,
    quantity: shares,
    limitPrice,
    outcome: ok ? "validated" : "blocked",
    blockReason: ok ? null : gateResults.filter((gate) => !gate.ok).map((gate) => `${gate.gate}: ${gate.detail}`).join(" | "),
    referenceBid: twoSided?.bid ?? null,
    referenceMid: twoSided ? (twoSided.bid + twoSided.ask) / 2 : null,
    executionStrategy: "vol_farmer_v4",
  });
  if (!ok) {
    const detail = gateResults.filter((gate) => !gate.ok).map((gate) => gate.detail).join("; ");
    await recordPlutoEvent("action_blocked", { passId: input.passId, actionId, symbol: ticker.symbol, stage: "vol_farmer_v4", reason: detail });
    return { actionId, sent: false, detail: `${description} blocked: ${detail}` };
  }
  await recordPlutoEvent("action_validated", { passId: input.passId, actionId, symbol: ticker.symbol, quantity: shares, limitPrice, reasons: [chosenBecause] });
  const plan = { quantity: shares, limitPrice: limitPrice!, notional, fullSizeQuantity: shares };
  const reasons = [`Vol Farmer v4: ${chosenBecause}.`];
  const executeInput: ExecuteInput = buying
    ? { kind: "shares_buy", actionId, symbol: ticker.symbol, plan, reasons, scoresSnapshot: { kind: "vol_farmer_v4", version: "vf4-1", stock: { bid: twoSided!.bid, ask: twoSided!.ask, quoteSource: "live", quotedAt: new Date(quote!.updatedAtMs!).toISOString() }, order: { shares, chosenBecause, scores } } }
    : { kind: "shares_sell", actionId, symbol: ticker.symbol, positionId: leftover!.positionId, legId: leftover!.legId, plan, reasons };
  const result = await executePlutoOrder(input.api, settings, executeInput);
  if (result.orderId !== null) {
    round.bookCounts.ordersToday += 1;
    tickerCounts.ordersToday += 1;
  }
  if (result.outcome !== "confirmed" || result.orderId === null) return { actionId, sent: false, detail: `${description}: ${result.detail}` };
  if (buying) {
    tickerCounts.working += 1;
    round.bookCounts.workingOrders += 1;
    round.bookCommitted += notional;
    round.committedThisRound += notional;
  }
  input.trackWatch(watchPlutoOrder(input.api, settings, { actionId, orderId: result.orderId, symbol: ticker.symbol, reference: { price: limitPrice!, side: buying ? "buy" : "sell", multiplier: 1 }, description: result.detail, cancelByMs: input.cancelByMs }), result.orderId, ticker.symbol);
  return { actionId, sent: true, detail: `${result.detail} (${formatWholeDollars(limitPrice! * shares)})` };
}

/**
 * A LEAPS expiry's Calls, live: its strikes (stored, else looked up from IBKR for the day), those whose Black-Scholes
 * |delta| at IBKR's 30-day IV (50% without one) is nearest the LEAPS |delta| (and the strike held, for a top-up or a
 * sale), as many as a quote burst takes. Quotes carry no size.
 */
async function quoteLeapsExpiry(context: { input: VolFarmerV4RoundInput; ticker: PlutoTickerSettings; expiry: string; stockPrice: number; riskFreeRate: number; impliedVolatility: number | null; heldStrike: number | null; storedStrikes: number[] | null; absDelta: number }): Promise<SymbolFileQuote[]> {
  const { input, ticker, expiry, stockPrice, riskFreeRate, heldStrike, absDelta } = context;
  let strikes = context.storedStrikes ?? [];
  if (strikes.length === 0) {
    try {
      strikes = await liveExpiryStrikes({ id: ticker.tickerId, symbol: ticker.symbol }, expiry.replaceAll("-", ""), input.todayIso, "pluto-leaps");
    } catch (error) {
      await recordPlutoEvent("warning", { passId: input.passId, symbol: ticker.symbol, message: `the strikes of ${expiry} could not be looked up for the LEAPS: ${error instanceof Error ? error.message : String(error)}` });
      return [];
    }
  }
  const years = yearsBetweenIsoDates(input.todayIso, expiry);
  if (!(years > 0)) return [];
  const forward = stockPrice * Math.exp(riskFreeRate * years);
  const impliedVolatility = context.impliedVolatility ?? 0.5;
  const nearest = [...strikes].sort((a, b) => Math.abs(blackScholesDelta(forward, a, years, riskFreeRate, impliedVolatility, true) - absDelta) - Math.abs(blackScholesDelta(forward, b, years, riskFreeRate, impliedVolatility, true) - absDelta));
  const chosen = [...new Set([...(heldStrike === null ? [] : [heldStrike]), ...nearest])].slice(0, Math.max(1, input.settings.burstLines));
  const live = await input.marketWatch.burst(ticker.symbol, chosen.map((strike) => ({ expiry, strike, right: "C" as const })));
  return live.map((quote) => ({ expiry, strike: quote.strike, right: "C" as const, bid: quote.bid, ask: quote.ask, bidSize: null, askSize: null }));
}
