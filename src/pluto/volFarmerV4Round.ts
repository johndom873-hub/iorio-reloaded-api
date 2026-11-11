import { db } from "../db/connection.js";
import { readAppEnvironment } from "../lib/appEnvironment.js";
import { followTheMidIsOn } from "../lib/orderLimitPriceChanges.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { sharesPerContract } from "../backtest/engine/backtestBook.js";
import { baselineMinimumBid, baselineQuoteRejection } from "../backtest/engine/baselineSaleSteps.js";
import { chooseVolFarmerV4Leaps, newVolFarmerV4SymbolState, runVolFarmerV4Turn, volFarmerV4BreakEven, volFarmerV4TurnOrder, type VolFarmerV4Market, type VolFarmerV4SymbolState } from "../backtest/engine/volFarmerV4Steps.js";
import type { BacktestVolFarmerV3Settings, VolFarmerV3CallsInTheMoneyAtLastLook } from "../backtest/backtestTypes.js";
import { loadStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { liveExpiryStrikes } from "../ibkr/liveOptionChainLookups.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import { loadBooksLiveState } from "../books/bookFigures.js";
import { fetchPlutoAccountSummary } from "./accountSummaryCache.js";
import { loadCommissionEstimator, loadStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { fetchOpenCycleSummaryRowsByTickerId } from "../lib/cycleBreakEvenQueries.js";
import { formatWholeDollars } from "../lib/formatWholeDollars.js";
import { loadLiveTradingSessions } from "../lib/liveTradingSessions.js";
import { summarizeOpenCycleFromRows } from "../lib/cycleInputRows.js";
import { blackScholesDelta, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { maximumLiveQuoteAgeMs } from "../lib/signalSnapshotLiveQuotes.js";
import { splitSuggestedByPrice } from "../lib/stockSplits.js";
import { loadPreviousClose } from "../lib/tickerCalendarQueries.js";
import { describePriceAdjustment } from "../ibkr/dailyBarSplitCheck.js";
import { noticePlutoTicker } from "./plutoTickerNotices.js";
import { strategyDeltaVerdict, type StrategyDeltaContext } from "../lib/strategyOrderGates.js";
import { daysToExpiry, describeExpiry, describeOptionContract } from "../lib/optionContractLabel.js";
import { optionLimitPriceGivingUpOneCent, optionMidLimitPrice } from "../lib/optionLimitPrice.js";
import { strategyBookCapitalVerdict, loadCommittedCapitalOnSymbols } from "../lib/orderLimits.js";
import { computeTickerExposure } from "../lib/positionExposure.js";
import type { PositionLegFigures } from "../lib/positionSelectors.js";
import { yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { frozenSymbolSet } from "../lib/tickerFreeze.js";
import { isLastSessionBeforeWeekend } from "../lib/tradingWeek.js";
import { loadInFlightNotionals, loadLastFilledPlutoActionAtBySymbol } from "./book.js";
import { executePlutoOrder, watchPlutoOrder, type ExecuteInput, type PlutoFollowTheMid } from "./executor.js";
import { loadPlutoState } from "./stateStore.js";
import { defaultOptionQuoteBandPlannerDependencies } from "./optionQuoteBandPlanLoader.js";
import { nextListedExpiryAfter, optionQuoteBandExpiryContracts, volFarmerV4ExpiryRule } from "./optionQuoteBandPlan.js";
import { loadFinishedOptionQuoteBandCycle, loadOptionQuoteBandQuotes } from "./optionQuoteBandQuotes.js";
import { latestCycleQuotes } from "./latestBandQuotes.js";
import { loadOpenPositionFigures } from "./openPositionFigures.js";
import { loadSafetyLimitBookCounts, plutoOrdersSentToday } from "./safetyLimits.js";
import { recordCommissionCapSkip, recordPlutoAction, recordPlutoEvent, type PlutoActionKind, type PlutoGateResult } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { tickerCooldownStatus } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, tickerPotFraction, type PlutoTickerSettings } from "./tickerSettingsStore.js";
import {
  adoptVolFarmerV4CallsSoldOutside,
  adoptVolFarmerV4Holdings,
  createVolFarmerV4LiveBook,
  pendingVolFarmerV4CallBuyBack,
  pendingVolFarmerV4Order,
  replaceVolFarmerV4LegRef,
  settleVolFarmerV4Order,
  sharesOfPlannedOrder,
  unfilledVolFarmerV4Outcome,
  volFarmerV4BuyBackMinutesBeforeWindowEnd,
  volFarmerV4RulesOf,
  type VolFarmerV4Memory,
  type VolFarmerV4PendingOrder,
  type VolFarmerV4PlannedOrder,
} from "./volFarmerV4LiveBook.js";
import { loadVolFarmerV4LeapsLook, loadVolFarmerV4LeftoverStockLeg, loadVolFarmerV4LegStatuses, loadVolFarmerV4Memory, loadVolFarmerV4OrderOutcomes, loadVolFarmerV4StepImpliedVolatility, saveVolFarmerV4LastRound, saveVolFarmerV4Memory, type VolFarmerV4LeapsLook, type VolFarmerV4RoundFigures } from "./volFarmerV4LookLoader.js";

// One Pluto round under Vol Farmer v4 (Marcelo 2026-10-31; Vol Farmer v2's from 2026-10-27): every enabled ticker gets a
// look at every round (its rules at every look, as the lab's "every look"), on its live book
// (volFarmerV4LiveBook.ts) and the market quote loop's band quotes, and the orders the shared steps place go out within the
// Safety Limits' caps (safetyLimits.ts; Marcelo 2026-10-27, answer d): the
// ticker's working orders, orders a day and open positions, the book's open positions and orders a day, and Pluto's
// capital budget. Each option order is re-quoted live, held to v4's spread limit and |delta| ranges (a LEAPS to its spread
// limit only), priced one cent past the mid (a LEAPS at the mid; optionLimitPrice.ts, Marcelo 2026-11-07) and sent through
// Pluto's executor, a single-leg one then following the mid while it works (executor.ts); one that fails a check, or a cap
// holds, is undone and planned afresh at a later round. While SPY's stress level holds, v4 opens nothing; a sale of LEAPS
// or shares still goes. A LEAPS is quoted when the steps ask for one: the strikes of its expiry (stored, else looked up
// live) whose Black-Scholes |delta| at IBKR's 30-day IV is nearest the LEAPS |delta|, as many as a quote burst takes.
// The tickers share Pluto's budget (Marcelo 2026-10-28), each with its allocation as its pot: they look in the day's turn
// (alphabetical, starting one ticker further each day), a new cycle buys no more lots than the free cash pays for, and
// the LEAPS go last: a second pass looks again at the tickers whose LEAPS purchase or top-up is due and sends only those,
// on the free cash every ticker's first pass left. What the free cash cut is in the ticker's notes.
// v4's share orders (Marcelo 2026-10-31): a look that rebalances (a top-up only on a day it sells a Call, Marcelo 2026-11-03:
// no shares are bought without one, so a flat ticker waits for that day and its shares go with the Call),
// sends that share order alone once no other order of the ticker works, at the mid of Pluto's own stock quote; its option
// orders, planned on the shares after it, are undone and planned again once it ends, and the ticker waits while it works.
// The account is a cash account (Marcelo 2026-10-31): the free cash is also held to the settled cash left, IBKR's settled
// cash less the cash the open Puts hold, the orders in flight and the round's earlier orders; with no settled cash
// reported, nothing is bought and no Put sold, except on the paper account (a margin account), where the total cash stands in.
// v4's buyback (Marcelo 2026-11-02, the lab's callsInTheMoneyAtLastLook): in the trading window's last 2 minutes, on a day
// the setting buys back (every day, or only the last session before a weekend), each of its Calls expiring today with the
// stock at or above its strike is bought back one cent past the mid through the close route, its shares kept, if the settled cash left
// pays for it; nothing else is sent for the ticker in those minutes, so no new Call covers the shares kept. One unfilled
// at the cancel before the close (or after the platform's unfilled-order sweep) is left to be assigned.

/** The expiry v4 sells today under its Options expiry setting (YYYY-MM-DD): today's, when one ends at the close, or the next listed after today. */
export function volFarmerV4SoldExpiry(expirations: readonly string[], todayIso: string, optionsExpiry: BacktestVolFarmerV3Settings["optionsExpiry"]): string | null {
  if (optionsExpiry === "next") return nextListedExpiryAfter(expirations, todayIso);
  return expirations.includes(todayIso.replaceAll("-", "")) ? todayIso : null;
}

/** Why the option quote band has no Call of the expiry v4 sells (it quotes that expiry, optionQuoteBandPlan.ts). */
export function volFarmerV4NoCallQuotedReason(input: {
  todayIso: string;
  /** The stored chain's expiries, YYYYMMDD. */
  expirations: readonly string[];
  strikesByExpiry: ReadonlyMap<string, readonly number[]>;
  /** Whether the band has finished a cycle on the ticker today. */
  bandCycleFinished: boolean;
  optionsExpiry: BacktestVolFarmerV3Settings["optionsExpiry"];
}): string {
  const soldExpiry = volFarmerV4SoldExpiry(input.expirations, input.todayIso, input.optionsExpiry);
  if (soldExpiry === null) return input.optionsExpiry === "next" ? "no Call expiry listed after today" : "no Call expiry ends today";
  const expiry = describeExpiry(soldExpiry, input.todayIso);
  const universe = optionQuoteBandExpiryContracts({ expirations: input.expirations, strikesByExpiry: input.strikesByExpiry, sessionIso: input.todayIso, expiryRule: volFarmerV4ExpiryRule({ volFarmerV4OptionsExpiry: input.optionsExpiry }) });
  if (!universe.some((contract) => contract.right === "C")) return `no ${expiry} Call strike is listed in the stored chain`;
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
  /** Today's trading window end (the session's, clamped before the close): v4's buyback runs in the minutes before it. */
  windowEndAtMs: number | null;
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

/**
 * Whether a round at `nowMs` is in v4's buyback minutes on a day its setting buys back: every day, or only the last session
 * before a weekend (a Friday, or the Thursday before a Friday holiday). Example: with the window ending at 15:30 ET, a
 * Friday round at 15:28:16 is one; one at 15:27:59 is not, nor a Thursday's at 15:29 under "before weekends only".
 */
export function isVolFarmerV4BuyBackRound(input: { callsInTheMoneyAtLastLook: VolFarmerV3CallsInTheMoneyAtLastLook; nowMs: number; windowEndAtMs: number | null; todayIso: string; nextSessionIso: string | undefined }): boolean {
  if (input.callsInTheMoneyAtLastLook === "assigned" || input.windowEndAtMs === null) return false;
  if (input.nowMs < input.windowEndAtMs - volFarmerV4BuyBackMinutesBeforeWindowEnd * 60_000) return false;
  return input.callsInTheMoneyAtLastLook === "bought_back" || isLastSessionBeforeWeekend(input.todayIso, input.nextSessionIso);
}

/**
 * Pure: in v4's buyback minutes on a day its setting does not buy back, why each of its Calls expiring today in the money
 * is left to be assigned; null outside those minutes or with none. Example (bought back before weekends only, a Monday,
 * the window ending 15:30 ET, at 15:29): "the window's last 2 minutes: $41.5 Call · 9 Nov (0DTE) · 11× in the money at
 * 41.78, not bought back (only on the last session before a weekend), left to be assigned".
 */
export function volFarmerV4CallsLeftToBeAssignedNote(input: { callsInTheMoneyAtLastLook: VolFarmerV3CallsInTheMoneyAtLastLook; nowMs: number; windowEndAtMs: number | null; buyBackRound: boolean; calls: readonly VolFarmerV4CallToBuyBack[]; stockPrice: number }): string | null {
  if (input.buyBackRound || input.windowEndAtMs === null || input.calls.length === 0) return null;
  if (input.nowMs < input.windowEndAtMs - volFarmerV4BuyBackMinutesBeforeWindowEnd * 60_000) return null;
  const why = input.callsInTheMoneyAtLastLook === "assigned" ? "the setting leaves Calls in the money to be assigned" : "only on the last session before a weekend";
  const calls = input.calls.map((call) => `${describeOptionContract({ strike: call.strike, right: "C", expiry: call.expiry, dte: 0 })} · ${call.contracts}×`).join(", ");
  return `the window's last ${volFarmerV4BuyBackMinutesBeforeWindowEnd} minutes: ${calls} in the money at ${input.stockPrice.toFixed(2)}, not bought back (${why}), left to be assigned`;
}

/** A Call v4 buys back: its leg, the contracts the leg holds and each position's of them. */
export interface VolFarmerV4CallToBuyBack {
  legId: string;
  expiry: string;
  strike: number;
  contracts: number;
  contractsByPosition: { first: number; second: number };
}

/**
 * The Calls v4 buys back at a buyback round: each open leg of its positions' Calls expiring today with the stock at or
 * above its strike, not already being bought back by an order still pending, for the contracts v4 holds of it (never more
 * than the leg holds: a leg the book has not yet cut after a part fill is not bought back past what is still short). A
 * Call on the ticker that is not v4's stays.
 */
export function volFarmerV4CallsToBuyBack(input: { state: VolFarmerV4SymbolState; openLegs: readonly PositionLegFigures[]; pending: readonly VolFarmerV4PendingOrder[]; stockPrice: number; todayIso: string }): VolFarmerV4CallToBuyBack[] {
  const beingBoughtBack = new Set(input.pending.flatMap((order) => (order.kind === "buy_back_call" && order.boughtBackLegId !== undefined ? [order.boughtBackLegId] : [])));
  const contractsOf = (name: "first" | "second", legId: string) => (input.state[name]?.calls.filter((call) => call.legId === legId).reduce((sum, call) => sum + call.shares, 0) ?? 0) / sharesPerContract;
  return input.openLegs
    .filter((leg) => leg.exitAt === null && leg.legType === "option" && leg.optionType === "call" && leg.side === "short" && leg.expiryDate === input.todayIso && leg.strikePrice !== null && input.stockPrice >= leg.strikePrice && !beingBoughtBack.has(leg.id))
    .map((leg) => {
      const contractsByPosition = { first: contractsOf("first", leg.id), second: contractsOf("second", leg.id) };
      return { legId: leg.id, expiry: leg.expiryDate!, strike: leg.strikePrice!, contracts: Math.min(leg.quantity, contractsByPosition.first + contractsByPosition.second), contractsByPosition };
    })
    .filter((call) => call.contracts > 0);
}

export async function runVolFarmerV4Round(input: VolFarmerV4RoundInput): Promise<VolFarmerV4RoundSummary> {
  const { settings, now } = input;
  const [enabled, frozen, clock, optionCommissions, stockCommissions, books, lastFilledAtBySymbol] = await Promise.all([
    loadEnabledPlutoTickerSettings(),
    frozenSymbolSet(),
    defaultOptionQuoteBandPlannerDependencies.loadClock(input.todayIso),
    loadCommissionEstimator(),
    loadStockCommissionEstimator(),
    // Pluto's book (Marcelo 2026-11-05): Pluto spends only its own cash, measured on its own value (src/books/bookFigures.ts).
    loadBooksLiveState({ fetchSummary: () => fetchPlutoAccountSummary(), now }),
    loadLastFilledPlutoActionAtBySymbol(),
  ]);
  const summary: VolFarmerV4RoundSummary = { looked: [], planned: 0, sent: 0, notes: [] };
  const v4Tickers = enabled.filter((ticker) => input.symbols.length === 0 || input.symbols.includes(ticker.symbol));
  if (v4Tickers.length === 0) return summary;
  if (!books.ready) {
    summary.notes.push("the Pluto and Manual books have not been started yet, so Pluto sends nothing");
    return summary;
  }
  const plutoBook = books.books.pluto;
  // The tickers share Pluto's budget (Marcelo 2026-10-28): they take their turn in the day's order, so the one that finds
  // the free cash short is a different one each day.
  const turnOrder = volFarmerV4TurnOrder(v4Tickers.map((ticker) => ticker.symbol), Math.round(Date.parse(`${input.todayIso}T00:00:00Z`) / 86_400_000));
  const tickers = [...v4Tickers].sort((a, b) => turnOrder.indexOf(a.symbol) - turnOrder.indexOf(b.symbol));
  const allocationBySymbol = effectiveAllocationPctBySymbol(enabled);
  const [bookCounts, bookCommittedAtStart] = await Promise.all([loadSafetyLimitBookCounts(enabled, now), loadCommittedCapitalOnSymbols(enabled.map((ticker) => ticker.symbol))]);
  // What the round's own orders commit is counted once: the book's commitment and the orders in flight are read at its
  // start, and each order it sends adds to them as it goes.
  const round = {
    bookCounts,
    bookCommitted: bookCommittedAtStart,
    /** Cash the round's earlier orders tie up, gone for the next tickers. */
    committedThisRound: 0,
    optionCommissionDollars: (contracts: number) => optionCommissions.perContractDollars("sell", contracts) * contracts,
    stockCommissionDollars: (shares: number) => stockCommissions.perShareDollars("buy") * shares,
    commissions: { option: optionCommissions, stock: stockCommissions },
    plutoBookValue: plutoBook.bookValue,
    plutoAvailableCash: plutoBook.availableCash ?? 0,
    plutoAvailableSettledCash: plutoBook.availableSettledCash,
    /** The cash every opening order must leave (Risk & Limits' min cash reserve, of Pluto's book value): already out of the available cash; a buyback may use it. */
    cashReserveDollars: plutoBook.minCashReserve,
  };
  const lastRounds = new Map<string, LastRound>();
  const potDollarsOf = (ticker: PlutoTickerSettings) => tickerPotFraction(allocationBySymbol.get(ticker.symbol) ?? 0, settings) * plutoBook.bookValue;
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
  optionCommissionDollars(contracts: number): number;
  stockCommissionDollars(shares: number): number;
  commissions: VolFarmerV4Market["commissions"];
  /** Pluto's book value when the round began: its pots' and its budget's base. */
  plutoBookValue: number;
  /** Pluto's available cash when the round began, its own working orders, Puts and reserve already out (0 when IBKR's cash is unknown). */
  plutoAvailableCash: number;
  /** The same on Pluto's settled cash; null when IBKR reported no settled cash. */
  plutoAvailableSettledCash: number | null;
  cashReserveDollars: number;
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
  let settledAnOrder = false;
  if (memory !== null && memory.pending.length > 0) {
    const outcomes = await loadVolFarmerV4OrderOutcomes(memory.pending.map((order) => order.actionId));
    const stillWorking: VolFarmerV4PendingOrder[] = [];
    for (const order of memory.pending) {
      const outcome = outcomes.get(order.actionId) ?? unfilledVolFarmerV4Outcome;
      if (outcome.working) stillWorking.push(order);
      else {
        settledAnOrder = true;
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
    if (openLegs.length === 0) memory = { state: newVolFarmerV4SymbolState(), pending: [] };
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

  // A Call sold outside Pluto (by hand, while the ticker was off) covers shares the memory counts as open: taken in, with no Call
  // of Pluto's still working (a part-filled one has a leg the memory holds as its order) and no order of Pluto's settled at this
  // round (its legs may not be closed in the ledger yet).
  if (!adopted && !settledAnOrder && !memory.pending.some((order) => order.kind === "covered_call" || order.kind === "buy_back_call")) {
    const callContractsTakenIn = adoptVolFarmerV4CallsSoldOutside(memory.state, positions);
    if (callContractsTakenIn > 0) {
      note(`${callContractsTakenIn} open ${callContractsTakenIn === 1 ? "Call" : "Calls"} Pluto did not sell now cover its shares`);
      const first = memory.state.first;
      await recordPlutoEvent("holdings_adopted", {
        passId: input.passId,
        symbol,
        strategy: "vol_farmer_v4",
        shares: (first?.shares ?? 0) + (memory.state.second?.shares ?? 0),
        breakEvenPerShare: first === null ? 0 : (volFarmerV4BreakEven(first) ?? 0),
        callContracts: callContractsTakenIn,
        putContracts: 0,
      });
    }
  }

  // 3. The market and the book at this round.
  const [prices, previousClose, bandQuotes, bandCycle, forwardAnchors, stepImpliedVolatility, chain, inFlight, tickerExposure] = await Promise.all([
    fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol }]),
    loadPreviousClose(tickerId, clock.todayIso),
    loadOptionQuoteBandQuotes(tickerId, clock.todayIso),
    loadFinishedOptionQuoteBandCycle(tickerId, clock.todayIso),
    defaultOptionQuoteBandPlannerDependencies.loadForwardAnchors(tickerId, clock.todayIso),
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
  // The split guard (stockSplits.ts): a price about a known split's factor from the previous close with no split recorded
  // stops every order on the ticker this round, a person told once a day; a real move of that size stops it too.
  const suggestedSplit = previousClose === null ? null : splitSuggestedByPrice(stockPrice, previousClose.close);
  if (suggestedSplit !== null) {
    const stopped = `trades at ${stockPrice.toFixed(2)} against a previous close of ${previousClose!.close.toFixed(2)}, about a ${describePriceAdjustment(suggestedSplit)} with none recorded: Pluto stops on it until a person looks`;
    note(stopped);
    await noticePlutoTicker(symbol, "split_guard", settings, now);
    await saveVolFarmerV4Memory(tickerId, memory, adopted);
    return nothingDue;
  }
  // Pluto's book (Marcelo 2026-11-05): what its tickers commit stays within its book value, and it buys only with its own
  // available cash, settled cash too (a cash account), both already net of its Puts, its working orders and the min cash
  // reserve of its book value (src/books/bookFigures.ts), less what the round's earlier orders took. Example: Pluto worth
  // $600,000 with $110,000 available and $10,000 bought earlier this round has $100,000 to buy with.
  const budgetFree = round.plutoBookValue - round.bookCommitted;
  const accountFree = round.plutoAvailableCash - round.committedThisRound;
  const settledFree = round.plutoAvailableSettledCash === null ? 0 : round.plutoAvailableSettledCash - round.committedThisRound;
  const freeCash = Math.max(0, Math.min(budgetFree, accountFree, settledFree));
  lastRound.figures = { potDollars, committedDollars: tickerExposure + inFlight.tickerNotional, freeCashDollars: freeCash, leapsCapDollars: (potDollars * settings.volFarmerV4LeapsMaxAllocationPct) / 100, putsDollars: (potDollars * (100 - settings.volFarmerV4FirstPositionPct)) / 100, ...(lastRound.figures?.leapsLook === undefined ? {} : { leapsLook: lastRound.figures.leapsLook }) };
  // v4's buyback minutes (Marcelo 2026-11-02): only the Calls in the money are bought back, and nothing else is sent.
  const liveSessions = await loadLiveTradingSessions(now);
  const nextSessionIso = liveSessions.openDays.find((dateIso) => dateIso > clock.todayIso);
  const buyBackRound = isVolFarmerV4BuyBackRound({ callsInTheMoneyAtLastLook: settings.volFarmerV4CallsInTheMoneyAtLastLook, nowMs: now.getTime(), windowEndAtMs: input.windowEndAtMs, todayIso: clock.todayIso, nextSessionIso });
  if (buyBackRound) {
    if (pass === "cycles_calls_puts") await buyBackCallsInTheMoney({ input, ticker, memory, openLegs, stockPrice, clock, round, summary, note });
    await saveVolFarmerV4Memory(tickerId, memory, adopted);
    return nothingDue;
  }
  if (pass === "cycles_calls_puts") {
    const leftToBeAssigned = volFarmerV4CallsLeftToBeAssignedNote({
      callsInTheMoneyAtLastLook: settings.volFarmerV4CallsInTheMoneyAtLastLook,
      nowMs: now.getTime(),
      windowEndAtMs: input.windowEndAtMs,
      buyBackRound,
      calls: volFarmerV4CallsToBuyBack({ state: memory.state, openLegs, pending: memory.pending, stockPrice, todayIso: clock.todayIso }),
      stockPrice,
    });
    if (leftToBeAssigned !== null) note(leftToBeAssigned);
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
  if (round.plutoAvailableSettledCash === null && pass === "cycles_calls_puts") note("IBKR reports no settled cash, so the free cash is 0: nothing is bought and no Put sold");
  const snapshot = {
    legStatusById,
    openOptionContracts: openOptionLegs.map((leg) => ({ expiry: leg.expiryDate!, strike: leg.strikePrice! })),
    flat: openLegs.length === 0,
    freeCash,
    potDollars,
    stockPrice,
    optionCommissionDollars: round.optionCommissionDollars,
    stockCommissionDollars: round.stockCommissionDollars,
  };
  const listedExpiries = chain.expirations
    .map((expiry) => `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`)
    .filter((expiry) => expiry >= clock.todayIso)
    .sort();
  const { farmer, v2, v3 } = volFarmerV4RulesOf(settings, ticker);
  const soldExpiry = volFarmerV4SoldExpiry(chain.expirations, clock.todayIso, v3.optionsExpiry);
  const soldExpiryCallQuoted = soldExpiry !== null && quotes.some((quote) => quote.right === "C" && quote.expiry === soldExpiry);
  const noCallQuotedReason = soldExpiryCallQuoted
    ? undefined
    : volFarmerV4NoCallQuotedReason({ todayIso: clock.todayIso, expirations: chain.expirations, strikesByExpiry: chain.strikesByExpiry, bandCycleFinished: bandCycle !== null, optionsExpiry: v3.optionsExpiry });
  // On an expiry day the steps sell on it even before (or without) a Call of it quoted, as the lab's day does; they word
  // the Calls they find none of, and this says why.
  if (pass === "cycles_calls_puts" && v3.optionsExpiry === "today" && soldExpiry !== null && noCallQuotedReason !== undefined) note(noCallQuotedReason);
  const marketWith = (leapsQuotesByExpiry: ReadonlyMap<string, SymbolFileQuote[]>, missing: Set<string>): VolFarmerV4Market => ({
    symbol,
    todayIso: clock.todayIso,
    // Pluto sells limits at the live quote, re-checked on a live quote just before and at the order route: no size limit (Marcelo 2026-11-05).
    salesSizeLimit: "none",
    stockPrice,
    riskFreeRate: clock.riskFreeRate,
    quotes,
    forwardAnchors,
    previousSessionVolumeByContract: null,
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
    const { book, planned, cashCutNotes, commissionCapSkips } = createVolFarmerV4LiveBook({ state, pending: memory!.pending, snapshot });
    const turn = runVolFarmerV4Turn({ state, market: marketWith(leapsQuotesByExpiry, missing), farmer, v2, v3, book });
    if (pass === "cycles_calls_puts") {
      const turnNote = turn.note();
      return { state, planned, missing, leapsDue: turn.leaps !== null, commissionCapSkips, notes: turnNote === null ? [] : [turnNote.slice(`${symbol}: `.length)] };
    }
    const leapsNote = turn.leaps?.() ?? null;
    return { state, planned, missing, leapsDue: false, commissionCapSkips: [], notes: [...(leapsNote === null ? [] : [leapsNote]), ...cashCutNotes] };
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
  // The LEAPS is a possible next action once the second position holds shares and none is held: its Calls are quoted once a
  // day (unless this round quoted them to buy), for the card to name the contract v4 would pick on them (Marcelo 2026-11-05).
  const secondShares = memory.state.second?.shares ?? 0;
  if (pass === "cycles_calls_puts" && lastRound.figures !== null && secondShares > 0 && memory.state.leaps === null && look.missing.size === 0) {
    lastRound.figures.leapsLook = await leapsLookOfToday({ input, ticker, stockPrice, riskFreeRate: clock.riskFreeRate, impliedVolatility: stepImpliedVolatility, listedExpiries, strikesByExpiry: chain.strikesByExpiry, leapsMinDte: v2.leapsMinDte, absDelta: v2.leapsAbsDelta, maxSpreadPctOfMid: farmer.maxSpreadPctOfMid, spreadShareCharged: v2.leapsSpreadCostChargedPct / 100 });
  }
  for (const { position, candidate, maxShareOfPremium } of look.commissionCapSkips) {
    await recordCommissionCapSkip({ passId: input.passId, symbol, tradingDate: clock.todayIso, position, expiry: candidate.expiry, strike: candidate.strike, dte: candidate.dte, fillPrice: candidate.fillPrice, premiumDollars: candidate.premiumDollars, commissionDollars: candidate.commissionDollars, maxShareOfPremium });
  }

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

/**
 * v4's buyback (Marcelo 2026-11-02): each Call to buy back, quoted live and bought back one cent past the mid (optionLimitPriceGivingUpOneCent) through the
 * close route, its shares kept, if the settled cash left pays for it (contracts × 100 × the limit, with commission). One
 * without a two-sided live quote, or that the settled cash can't pay for, is left to be assigned (tried again at a later
 * round of the minutes); one sent is pending until it settles. Example: 38 $100 Calls, the stock at $101.00, quoted
 * 1.05 / 1.15: bought back at 1.11, $4,218 + $25.84 commission, with $40,000 of settled cash left.
 */
async function buyBackCallsInTheMoney(context: { input: VolFarmerV4RoundInput; ticker: PlutoTickerSettings; memory: VolFarmerV4Memory; openLegs: readonly PositionLegFigures[]; stockPrice: number; clock: { todayIso: string }; round: RoundState; summary: VolFarmerV4RoundSummary; note: (text: string) => void }): Promise<void> {
  const { input, ticker, memory, stockPrice, clock, round, summary, note } = context;
  const { settings } = input;
  const minutes = `the window's last ${volFarmerV4BuyBackMinutesBeforeWindowEnd} minutes`;
  const calls = volFarmerV4CallsToBuyBack({ state: memory.state, openLegs: context.openLegs, pending: memory.pending, stockPrice, todayIso: clock.todayIso });
  if (calls.length === 0) {
    const working = memory.pending.filter((order) => order.kind === "buy_back_call").length;
    note(working > 0 ? `${minutes}: ${working} buyback(s) working, nothing else is sent` : `${minutes}: no Call expiring today is in the money at ${stockPrice.toFixed(2)}, so nothing is bought back and nothing else is sent`);
    return;
  }
  const legRows: { id: string; position_id: string }[] = await db("position_legs").whereIn("id", calls.map((call) => call.legId)).select("id", "position_id");
  const positionIdByLegId = new Map(legRows.map((row) => [row.id, row.position_id]));
  const keptThrough = settings.volFarmerV4CallsInTheMoneyAtLastLook === "bought_back_before_weekends" ? "the weekend" : "the night";
  for (const call of calls) {
    const contract = { expiry: call.expiry, strike: call.strike, right: "C" as const };
    const label = describeOptionContract({ strike: call.strike, right: "C", expiry: call.expiry, dte: 0 });
    const chosenBecause = `a Call expiring today in the money in ${minutes} (the stock at ${stockPrice.toFixed(2)}, the strike ${call.strike}), bought back so its shares stay through ${keptThrough}`;
    summary.planned += 1;
    const [live] = await input.marketWatch.burst(ticker.symbol, [contract]);
    const twoSided = live && live.bid !== null && live.ask !== null && live.bid > 0 && live.ask > live.bid ? { bid: live.bid, ask: live.ask } : null;
    const limitPrice = twoSided ? optionLimitPriceGivingUpOneCent(twoSided.bid, twoSided.ask, "buy") : null;
    const costDollars = limitPrice === null ? 0 : limitPrice * sharesPerContract * call.contracts + round.commissions.option.perContractDollars("buy", call.contracts) * call.contracts;
    // The settled cash left, as the look counts it, less the buybacks this round already sent.
    const settledFree = round.plutoAvailableSettledCash === null ? 0 : round.plutoAvailableSettledCash + round.cashReserveDollars - round.committedThisRound;
    const positionId = positionIdByLegId.get(call.legId);
    const gateResults: PlutoGateResult[] = [
      { gate: "vol_farmer_v4", ok: true, detail: chosenBecause },
      { gate: "live_quote", ok: twoSided !== null, detail: twoSided ? `bid ${twoSided.bid.toFixed(2)}, ask ${twoSided.ask.toFixed(2)}` : "no live two-sided quote" },
      ...(limitPrice !== null ? [{ gate: "settled_cash", ok: costDollars <= settledFree, detail: `the buyback costs ${formatWholeDollars(costDollars)}, the settled cash left is ${formatWholeDollars(Math.max(0, settledFree))}` }] : []),
      ...(positionId === undefined ? [{ gate: "position", ok: false, detail: "the Call's position was not found" }] : []),
    ];
    const ok = gateResults.every((gate) => gate.ok) && limitPrice !== null && positionId !== undefined;
    const actionId = await recordPlutoAction({
      passId: input.passId,
      kind: "close_leg",
      symbol: ticker.symbol,
      tickerId: ticker.tickerId,
      contract: { strategyKey: "covered_call", ...contract },
      candidateScores: { stockPrice, strike: call.strike, bid: twoSided?.bid ?? null, ask: twoSided?.ask ?? null, intrinsic: stockPrice - call.strike },
      deterministicTopPick: null,
      gateResults,
      sizeTier: null,
      quantity: call.contracts,
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
      note(`the buyback of ${call.contracts}× ${label} is not sent (${detail}): the Call is left to be assigned unless a later round of ${minutes} buys it back`);
      continue;
    }
    await recordPlutoEvent("action_validated", { passId: input.passId, actionId, symbol: ticker.symbol, quantity: call.contracts, limitPrice, reasons: [chosenBecause] });
    const result = await executePlutoOrder(input.api, settings, {
      kind: "call_buy_back",
      actionId,
      symbol: ticker.symbol,
      positionId: positionId!,
      legId: call.legId,
      contract: { ...contract, dte: 0 },
      plan: { quantity: call.contracts, limitPrice: limitPrice!, notional: costDollars, fullSizeQuantity: call.contracts },
      reasons: [`Vol Farmer v4: ${chosenBecause}.`],
    });
    if (result.outcome === "confirmed") round.bookCounts.ordersToday += 1;
    if (result.outcome !== "confirmed" || result.orderId === null) {
      note(`the buyback of ${call.contracts}× ${label}: ${result.detail}`);
      continue;
    }
    summary.sent += 1;
    round.committedThisRound += costDollars;
    memory.pending.push(pendingVolFarmerV4CallBuyBack(actionId, call));
    input.trackWatch(
      watchPlutoOrder(input.api, settings, { actionId, orderId: result.orderId, symbol: ticker.symbol, reference: { price: limitPrice!, side: "buy", multiplier: 100 }, description: result.detail, cancelByMs: input.cancelByMs, followTheMid: followTheMidOf(input.marketWatch, ticker.symbol, contract, "buy", null) }),
      result.orderId,
      ticker.symbol,
    );
  }
}

/**
 * Follow the mid for one of v4's single-leg option orders (Marcelo 2026-11-07): the live quote's price one cent past the mid,
 * or null to leave the order where it is (no two-sided quote; a sale whose quote fails v4's bid minimum or spread limit,
 * when `maxSpreadPctOfMid` is given; Pluto off or paused).
 */
/** How a working order follows the mid; undefined where following is off (production, orderLimitPriceChanges.ts). */
function followTheMidOf(marketWatch: Pick<PlutoMarketWatch, "burst">, symbol: string, contract: { expiry: string; strike: number; right: "C" | "P" }, side: "sell" | "buy", maxSpreadPctOfMid: number | null): PlutoFollowTheMid | undefined {
  if (!followTheMidIsOn(readAppEnvironment())) return undefined;
  return {
    priceNow: async () => {
      const state = await loadPlutoState();
      if (state.mode !== "on" || state.paused) return null;
      const [live] = await marketWatch.burst(symbol, [contract]);
      const twoSided = live && live.bid !== null && live.ask !== null && live.bid > 0 && live.ask > live.bid ? { bid: live.bid, ask: live.ask } : null;
      if (twoSided === null) return null;
      if (maxSpreadPctOfMid !== null && baselineQuoteRejection(twoSided, maxSpreadPctOfMid) !== null) return null;
      return optionLimitPriceGivingUpOneCent(twoSided.bid, twoSided.ask, side);
    },
  };
}

/**
 * Follow the mid for a v4 order a new process adopted (the agent restarted while it worked): the same rules it was sent
 * with, rebuilt from its action. A sale of a Call on shares held or a Put follows within v4's spread limit; a buyback
 * follows at any spread; anything else (two legs, LEAPS, shares) does not.
 */
export function followTheMidOfAdoptedOrder(
  marketWatch: Pick<PlutoMarketWatch, "burst">,
  settings: PlutoSettings,
  order: { executionStrategy: string | null; kind: string; symbol: string; contract: unknown; legs: readonly { role: "stock" | "option" }[] },
): PlutoFollowTheMid | undefined {
  if (order.executionStrategy !== "vol_farmer_v4" || order.legs.length !== 1 || order.legs[0]!.role !== "option") return undefined;
  const contract = (order.contract ?? {}) as { expiry?: string; strike?: number; right?: "C" | "P"; strategyKey?: string };
  if (!contract.expiry || contract.strike === undefined) return undefined;
  const right = contract.right ?? (contract.strategyKey === "cash_secured_put" ? "P" : "C");
  const followed = { expiry: contract.expiry, strike: Number(contract.strike), right };
  if (order.kind === "open_covered_call" || order.kind === "open_cash_secured_put") return followTheMidOf(marketWatch, order.symbol, followed, "sell", volFarmerV4RulesOf(settings).farmer.maxSpreadPctOfMid);
  if (order.kind === "close_leg") return followTheMidOf(marketWatch, order.symbol, followed, "buy", null);
  return undefined;
}

/** Every leg reference the state holds. */
function legIdsOf(state: VolFarmerV4SymbolState): string[] {
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
 * One option order: the caps (an opening order), the live quote, v4's checks on it, the limit (a Call or Put one cent past the
 * mid, a LEAPS at the mid), then the executor.
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
  const isLeaps = item.contract.strategyKey === "leaps";
  const limitPrice = twoSided ? (isLeaps ? optionMidLimitPrice : optionLimitPriceGivingUpOneCent)(twoSided.bid, twoSided.ask, item.side) : null;
  const quoteRejection = twoSided ? baselineQuoteRejection(twoSided, farmer.maxSpreadPctOfMid) : null;
  const isPut = item.contract.right === "P";
  // The Calls are held to v4's Calls' range, the Puts to |delta| at most its Put |delta|; a LEAPS has no range.
  const deltaContext: StrategyDeltaContext = { minAbsDelta: isPut ? 0 : farmer.callMinAbsDelta, maxAbsDelta: isPut ? v2.putMaxAbsDelta : farmer.callMaxAbsDelta, forwardAnchor: context.forwardAnchors.get(item.contract.expiry) ?? null, riskFreeRate: clock.riskFreeRate, todayIso: clock.todayIso, closeMinutesEt: clock.closeMinutesEt };
  const verdict = twoSided && !isLeaps ? strategyDeltaVerdict({ ...twoSided, stockPrice, strike: item.contract.strike, expiryIso: item.contract.expiry, isCall: !isPut, putHeldToRange: isPut, now, context: deltaContext }) : null;
  // A sale is held to the steps' bid minimum and spread limit; a LEAPS purchase or sale to a two-sided quote within the spread limit.
  const ruleFailure = twoSided === null ? null : quoteRejection === "noUsableQuote" && item.side === "sell" && !isLeaps ? `the live bid ${twoSided.bid.toFixed(2)} is under the $0.05 minimum` : quoteRejection === "spreadTooWide" ? `the live spread is ${(((twoSided.ask - twoSided.bid) / ((twoSided.bid + twoSided.ask) / 2)) * 100).toFixed(1)}% of the mid, above v4's ${farmer.maxSpreadPctOfMid}%` : null;
  // A Call that opens a cycle, or rebuilds the first position, buys its shares with it.
  const buysShares = item.order.kind === "covered_call" && (item.order.sale.startsCycle || item.order.sale.buysShares === true);
  const notional = limitPrice === null ? 0 : item.contract.strategyKey === "cash_secured_put" ? Math.max(0, item.contract.strike - limitPrice) * 100 * item.contracts : item.contract.strategyKey === "leaps" ? (opening ? limitPrice * 100 * item.contracts : 0) : buysShares ? item.contracts * 100 * Math.max(0, stockPrice - limitPrice) : 0;
  const capital = opening && limitPrice !== null ? strategyBookCapitalVerdict({ committedBeforeDollars: round.bookCommitted, orderNotional: notional, budgetFraction: 1, netLiquidationValue: round.plutoBookValue }) : null;
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
  if (result.outcome === "confirmed") {
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
    watchPlutoOrder(input.api, settings, {
      actionId,
      orderId: result.orderId,
      symbol: ticker.symbol,
      reference: { price: limitPrice!, side: item.side, multiplier: 100, ...(result.otherReferenceLegs ? { otherLegs: result.otherReferenceLegs } : {}) },
      description: result.detail,
      cancelByMs: input.cancelByMs,
      // A Call on shares held or a Put follows the mid; a Call that buys its shares with it (two legs) and a LEAPS do not.
      ...(!isLeaps && !buysShares ? { followTheMid: followTheMidOf(input.marketWatch, ticker.symbol, contract, item.side, farmer.maxSpreadPctOfMid) } : {}),
    }),
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
 * One share order (v4's rebalancing: a top-up on a day it sells a Call, or a trim): a purchase within the caps
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
  // Held to the order route's live-quote rule (signalSnapshotLiveQuotes.ts, Marcelo 2026-11-02), so it never sends a share order the route refuses.
  const fresh = quote !== null && quote.updatedAtMs !== null && nowMs - quote.updatedAtMs <= maximumLiveQuoteAgeMs;
  const twoSided = fresh && quote.bid !== null && quote.ask !== null && quote.bid > 0 && quote.ask >= quote.bid ? { bid: quote.bid, ask: quote.ask } : null;
  const limitPrice = twoSided ? optionMidLimitPrice(twoSided.bid, twoSided.ask, buying ? "buy" : "sell") : null;
  const notional = buying && limitPrice !== null ? limitPrice * shares : 0;
  const capital = buying && limitPrice !== null ? strategyBookCapitalVerdict({ committedBeforeDollars: round.bookCommitted, orderNotional: notional, budgetFraction: 1, netLiquidationValue: round.plutoBookValue }) : null;
  const chosenBecause = buying ? order.order.chosenBecause : order.kind === "sell_shares" ? order.orders[0]!.chosenBecause : "";
  const scores = buying ? order.order.candidateScores : order.kind === "sell_shares" ? order.orders[0]!.candidateScores : {};
  const gateResults: PlutoGateResult[] = [
    { gate: "vol_farmer_v4", ok: true, detail: chosenBecause },
    { gate: "live_quote", ok: twoSided !== null, detail: twoSided ? `stock bid ${twoSided.bid.toFixed(2)}, ask ${twoSided.ask.toFixed(2)}` : `no two-sided stock quote of the last ${maximumLiveQuoteAgeMs / 1000} seconds` },
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
  if (result.outcome === "confirmed") {
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
 * The LEAPS Calls as quoted today: the contract the engine's own pick (chooseVolFarmerV4Leaps) takes on them at today's
 * stock price, or why there is none. One burst a day per ticker: a look already saved for today is kept. Nothing is
 * inferred at another price.
 */
export async function leapsLookOfToday(context: { input: VolFarmerV4RoundInput; ticker: PlutoTickerSettings; stockPrice: number; riskFreeRate: number; impliedVolatility: number | null; listedExpiries: readonly string[]; strikesByExpiry: ReadonlyMap<string, number[]>; leapsMinDte: number; absDelta: number; maxSpreadPctOfMid: number; spreadShareCharged: number }): Promise<VolFarmerV4LeapsLook> {
  const { input, ticker } = context;
  const previous = await loadVolFarmerV4LeapsLook(ticker.tickerId);
  if (previous !== null && previous.tradingDate === input.todayIso) return previous;
  const expiry = context.listedExpiries.find((listed) => daysToExpiry(listed, input.todayIso) >= context.leapsMinDte) ?? null;
  const look = { tradingDate: input.todayIso, quotedAt: new Date().toISOString(), expiry };
  if (expiry === null) return { ...look, contract: null, reason: `no Call expiry ${context.leapsMinDte} or more days out is listed` };
  const quotes = await quoteLeapsExpiry({ input, ticker, expiry, stockPrice: context.stockPrice, riskFreeRate: context.riskFreeRate, impliedVolatility: context.impliedVolatility, heldStrike: null, storedStrikes: context.strikesByExpiry.get(expiry.replaceAll("-", "")) ?? null, absDelta: context.absDelta });
  const chosen = chooseVolFarmerV4Leaps({ quotes, expiry, stockPrice: context.stockPrice, yearsToExpiry: yearsBetweenIsoDates(input.todayIso, expiry), riskFreeRate: context.riskFreeRate, absDelta: context.absDelta, maxSpreadPctOfMid: context.maxSpreadPctOfMid, spreadShareCharged: context.spreadShareCharged });
  if (chosen !== null) return { ...look, contract: { strike: chosen.strike, bid: chosen.bid, ask: chosen.ask }, reason: null };
  if (quotes.length === 0) return { ...look, contract: null, reason: `no strike near |delta| ${context.absDelta} returned a two-sided quote` };
  const failing = quotes.filter((quote) => baselineQuoteRejection(quote, context.maxSpreadPctOfMid) !== null).length;
  return { ...look, contract: null, reason: failing === quotes.length ? `${quotes.length} ${quotes.length === 1 ? "strike" : "strikes"} quoted near |delta| ${context.absDelta}, none with a bid of at least $${baselineMinimumBid.toFixed(2)} and a spread within ${context.maxSpreadPctOfMid}% of the mid` : "no quoted strike gave an implied volatility" };
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
