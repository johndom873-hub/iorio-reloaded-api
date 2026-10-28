import { db } from "../db/connection.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { baselineQuoteRejection } from "../backtest/engine/baselineSaleSteps.js";
import { newVolFarmerV2SymbolState, runVolFarmerV2Turn, volFarmerV2TurnOrder, type VolFarmerV2Market, type VolFarmerV2SymbolState } from "../backtest/engine/volFarmerV2Steps.js";
import { loadStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { liveExpiryStrikes } from "../ibkr/liveOptionChainLookups.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import { accountContextFromTotalCash } from "../lib/accountContext.js";
import { loadCommissionEstimator, loadStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { fetchOpenCycleSummaryRowsByTickerId } from "../lib/cycleBreakEvenQueries.js";
import { summarizeOpenCycleFromRows } from "../lib/cycleInputRows.js";
import { blackScholesDelta, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { ladderDeltaVerdict, type LadderDeltaContext } from "../lib/ladderOrderGates.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import { optionMidLimitPrice } from "../lib/optionLimitPrice.js";
import { ladderBookCapitalVerdict, loadCommittedCapitalOnSymbols } from "../lib/orderLimits.js";
import { computeTickerExposure } from "../lib/positionExposure.js";
import { yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { frozenSymbolSet } from "../lib/tickerFreeze.js";
import { loadInFlightNotionals, loadInFlightNotionalsBySymbol, loadLastFilledPlutoActionAtBySymbol } from "./book.js";
import { executePlutoOrder, watchPlutoOrder, type ExecuteInput } from "./executor.js";
import { defaultLadderBandPlannerDependencies } from "./ladderBandPlanLoader.js";
import { loadLadderBandQuotes } from "./ladderBandQuotes.js";
import { latestCycleQuotes } from "./ladderLook.js";
import { loadOpenPositionFigures } from "./ladderLookSnapshot.js";
import { ladderOrdersSentToday, loadLadderBookOrderCounts } from "./ladderOrders.js";
import { recordPlutoAction, recordPlutoEvent, type PlutoActionKind, type PlutoGateResult } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { tickerCooldownStatus } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, effectivePlutoStrategy, loadEnabledPlutoTickerSettings, tickerPotFraction, type PlutoTickerSettings } from "./tickerSettingsStore.js";
import {
  adoptVolFarmerV2Holdings,
  createVolFarmerV2LiveBook,
  pendingVolFarmerV2Order,
  replaceVolFarmerV2LegRef,
  settleVolFarmerV2Order,
  unfilledVolFarmerV2Outcome,
  volFarmerV2RulesOf,
  type VolFarmerV2PendingOrder,
  type VolFarmerV2PlannedOrder,
} from "./volFarmerV2LiveBook.js";
import { loadVolFarmerV2LegStatuses, loadVolFarmerV2Memory, loadVolFarmerV2OrderOutcomes, loadVolFarmerV2StepImpliedVolatility, saveVolFarmerV2LastRound, saveVolFarmerV2Memory, type VolFarmerV2RoundFigures } from "./volFarmerV2LookLoader.js";

// One Pluto round under Vol Farmer v2 (Marcelo 2026-10-27): every enabled ticker running v2 gets a look at every round
// (its rules at every look, as the lab's "every look"), on its live book (volFarmerV2LiveBook.ts) and the market quote
// loop's band quotes, and the orders the shared steps place go out within the caps the CC + Put Ladder's orders count
// under too (Marcelo 2026-10-27, answer d): the ticker's working orders, orders a day and open positions, the book's open
// positions and orders a day, and Pluto's capital budget. Each order is re-quoted live, held to v2's spread limit and
// |delta| ranges (a LEAPS to its spread limit only), priced at the mid on the option's tick and sent through Pluto's
// executor; one that fails a check, or a cap holds, is undone and planned afresh at a later round. While SPY's stress
// level holds, v2 opens nothing; a LEAPS sale still goes. A LEAPS is quoted when the steps ask for one: the strikes of its
// expiry (stored, else looked up live) whose Black-Scholes |delta| at IBKR's 30-day IV is nearest the LEAPS |delta|, as
// many as a quote burst takes.
// The tickers share Pluto's budget (Marcelo 2026-10-28), each with its allocation as its pot: they look in the day's turn
// (alphabetical, starting one ticker further each day), a new cycle buys no more lots than the free cash pays for, and
// the LEAPS go last: a second pass looks again at the tickers whose LEAPS purchase or top-up is due and sends only those,
// on the free cash every ticker's first pass left. What the free cash cut is in the ticker's notes.

export interface VolFarmerV2RoundInput {
  passId: string;
  settings: PlutoSettings;
  api: InternalApiClient;
  marketWatch: PlutoMarketWatch;
  trackWatch: (promise: Promise<unknown>, orderId: string, symbol: string) => void;
  now: Date;
  todayIso: string;
  totalCashValue: number | null;
  netLiquidationValue: number;
  cancelByMs: number | null;
  /** Only these symbols (a round about some tickers); empty = every enabled ticker. */
  symbols: string[];
  /** SPY's stress level holds: no opening order, a LEAPS sale only. */
  stressed: boolean;
}

export interface VolFarmerV2RoundSummary {
  looked: string[];
  planned: number;
  sent: number;
  notes: string[];
}

/** An order the round sends, ready for the executor: what it is, its live price and its record. */
interface VolFarmerV2OrderToSend {
  order: VolFarmerV2PlannedOrder;
  kind: PlutoActionKind;
  contract: { strategyKey: "covered_call" | "cash_secured_put" | "leaps"; expiry: string; strike: number; right: "C" | "P" };
  contracts: number;
  chosenBecause: string;
  scores: Record<string, number | null>;
  side: "sell" | "buy";
  /** A LEAPS sale: the leg sold and its position. */
  leg?: { legId: string; positionId: string };
}

export async function runVolFarmerV2Round(input: VolFarmerV2RoundInput): Promise<VolFarmerV2RoundSummary> {
  const { settings, now } = input;
  const [enabled, frozen, clock, optionCommissions, stockCommissions, account, lastFilledAtBySymbol] = await Promise.all([
    loadEnabledPlutoTickerSettings(),
    frozenSymbolSet(),
    defaultLadderBandPlannerDependencies.loadClock(input.todayIso),
    loadCommissionEstimator(),
    loadStockCommissionEstimator(),
    accountContextFromTotalCash(input.totalCashValue),
    loadLastFilledPlutoActionAtBySymbol(),
  ]);
  const summary: VolFarmerV2RoundSummary = { looked: [], planned: 0, sent: 0, notes: [] };
  const v2Tickers = enabled.filter((ticker) => effectivePlutoStrategy(ticker) === "vol_farmer_v2" && (input.symbols.length === 0 || input.symbols.includes(ticker.symbol)));
  if (v2Tickers.length === 0) return summary;
  // The tickers share Pluto's budget (Marcelo 2026-10-28): they take their turn in the day's order, so the one that finds
  // the free cash short is a different one each day.
  const turnOrder = volFarmerV2TurnOrder(v2Tickers.map((ticker) => ticker.symbol), Math.round(Date.parse(`${input.todayIso}T00:00:00Z`) / 86_400_000));
  const tickers = [...v2Tickers].sort((a, b) => turnOrder.indexOf(a.symbol) - turnOrder.indexOf(b.symbol));
  const allocationBySymbol = effectiveAllocationPctBySymbol(enabled);
  const [bookCounts, bookCommittedAtStart, inFlightAtStart] = await Promise.all([loadLadderBookOrderCounts(enabled, now), loadCommittedCapitalOnSymbols(enabled.map((ticker) => ticker.symbol)), loadInFlightNotionalsBySymbol()]);
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
      const cooldown = tickerCooldownStatus(lastFilledAtBySymbol.get(ticker.symbol) ?? null, now.getTime(), settings.ladderTickerCooldownMinutes);
      if (settings.ladderTickerCooldownMinutes > 0 && !cooldown.cooledDown) {
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
      await saveVolFarmerV2LastRound(ticker.tickerId, { at: now, notes: lastRound.notes, figures: lastRound.figures });
    }
  }
  return summary;
}

/** What the round said about a ticker and the figures the screen's warnings read, saved for the Pluto screen. */
interface LastRound {
  notes: string[];
  figures: VolFarmerV2RoundFigures | null;
}

type RoundState = {
  bookCounts: Awaited<ReturnType<typeof loadLadderBookOrderCounts>>;
  bookCommitted: number;
  committedThisRound: number;
  /** The notional of every order in flight on the account when the round began. */
  accountInFlightAtStart: number;
  optionCommissionDollars(contracts: number): number;
  stockCommissionDollars(shares: number): number;
  commissions: VolFarmerV2Market["commissions"];
  accountFreeCash: number;
};

/**
 * A ticker's look at one of the round's passes: "cycles_calls_puts" runs v2's steps 1 to 3 and sends their orders,
 * answering whether its LEAPS (a purchase or a top-up) is due; "leaps" looks again, after every ticker's first pass, and
 * sends only the LEAPS, on the free cash left then.
 */
async function lookAtTicker(context: { input: VolFarmerV2RoundInput; ticker: PlutoTickerSettings; potDollars: number; clock: Awaited<ReturnType<typeof defaultLadderBandPlannerDependencies.loadClock>>; round: RoundState; summary: VolFarmerV2RoundSummary; lastRound: LastRound; pass: "cycles_calls_puts" | "leaps" }): Promise<{ leapsDue: boolean }> {
  const { input, ticker, potDollars, clock, round, summary, lastRound, pass } = context;
  const { settings, now } = input;
  const { symbol, tickerId } = ticker;
  const note = (text: string) => lastRound.notes.push(text);
  const nothingDue = { leapsDue: false };

  // 1. The orders sent at earlier rounds that are done replace their plan with their fills.
  let memory = await loadVolFarmerV2Memory(tickerId);
  if (memory !== null && memory.pending.length > 0) {
    const outcomes = await loadVolFarmerV2OrderOutcomes(memory.pending.map((order) => order.actionId));
    const stillWorking: VolFarmerV2PendingOrder[] = [];
    for (const order of memory.pending) {
      const outcome = outcomes.get(order.actionId) ?? unfilledVolFarmerV2Outcome;
      if (outcome.working) stillWorking.push(order);
      else {
        const settled = settleVolFarmerV2Order(memory.state, order, outcome);
        if (settled !== null) note(settled);
      }
    }
    memory.pending = stillWorking;
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
      const adoption = adoptVolFarmerV2Holdings({ positions, cycleBreakEvenPerShare: cycle?.breakEvenPerShare ?? null, potDollars });
      if ("waiting" in adoption) {
        note(adoption.waiting);
        return nothingDue;
      }
      memory = { state: adoption.state, pending: [] };
      adopted = true;
      await recordPlutoEvent("warning", { passId: input.passId, symbol, message: `Vol Farmer v2 adopted ${symbol}'s holdings: ${adoption.state.first!.shares} shares at the cycle's break-even ${adoption.state.first!.costPerShare.toFixed(2)}, ${adoption.state.first!.calls.length} open Call leg(s), ${adoption.state.second?.puts.length ?? 0} open Put leg(s)` });
    }
  }

  // 3. The market and the book at this round.
  const [prices, bandQuotes, forwardAnchors, previousSessionVolumeByContract, stepImpliedVolatility, chain, inFlight, tickerExposure] = await Promise.all([
    fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol }]),
    loadLadderBandQuotes(tickerId, clock.todayIso),
    defaultLadderBandPlannerDependencies.loadForwardAnchors(tickerId, clock.todayIso),
    defaultLadderBandPlannerDependencies.loadPreviousSessionVolume(tickerId, clock.todayIso),
    loadVolFarmerV2StepImpliedVolatility(tickerId, clock.todayIso),
    loadStoredOptionChain(tickerId),
    loadInFlightNotionals(symbol),
    computeTickerExposure(symbol),
  ]);
  const stockPrice = prices["stock"] ?? null;
  if (stockPrice === null || !(stockPrice > 0)) {
    note("no live stock price");
    await saveVolFarmerV2Memory(tickerId, memory, adopted);
    return nothingDue;
  }
  const { quotes, stale } = latestCycleQuotes(bandQuotes, now, settings.maxQuoteAgeMinutes);
  if (stale) {
    note(`the band's latest quotes are older than ${settings.maxQuoteAgeMinutes} minutes, so nothing is planned`);
    await saveVolFarmerV2Memory(tickerId, memory, adopted);
    return nothingDue;
  }
  const memoryLegIds = legIdsOf(memory.state).filter((legId) => !legId.startsWith("action:") && !legId.startsWith("planned:"));
  const openOptionLegs = openLegs.filter((leg) => leg.legType === "option" && leg.expiryDate !== null && leg.strikePrice !== null);
  const legStatusById = await loadVolFarmerV2LegStatuses([...new Set([...memoryLegIds, ...openOptionLegs.map((leg) => leg.id)])]);
  const budgetFree = (settings.capitalBudgetPct / 100) * input.netLiquidationValue - round.bookCommitted;
  const accountFree = round.accountFreeCash - round.accountInFlightAtStart - round.committedThisRound;
  const snapshot = {
    legStatusById,
    openOptionContracts: openOptionLegs.map((leg) => ({ expiry: leg.expiryDate!, strike: leg.strikePrice! })),
    flat: openLegs.length === 0,
    freeCash: Math.max(0, Math.min(budgetFree, accountFree)),
    potDollars,
    stockPrice,
    optionCommissionDollars: round.optionCommissionDollars,
    stockCommissionDollars: round.stockCommissionDollars,
  };
  lastRound.figures = { potDollars, committedDollars: tickerExposure + inFlight.tickerNotional, freeCashDollars: snapshot.freeCash, leapsCapDollars: (potDollars * settings.volFarmerV2LeapsMaxAllocationPct) / 100 };
  const listedExpiries = chain.expirations
    .map((expiry) => `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`)
    .filter((expiry) => expiry >= clock.todayIso)
    .sort();
  const { farmer, v2 } = volFarmerV2RulesOf(settings);
  const marketWith = (leapsQuotesByExpiry: ReadonlyMap<string, SymbolFileQuote[]>, missing: Set<string>): VolFarmerV2Market => ({
    symbol,
    todayIso: clock.todayIso,
    stockPrice,
    riskFreeRate: clock.riskFreeRate,
    quotes,
    forwardAnchors,
    previousSessionVolumeByContract,
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
    priceToCycleScale: 1,
    optionContractsRepresentable: true,
    spreadShareCharged: 0,
    commissions: round.commissions,
    optionCommissionDollars: round.optionCommissionDollars,
    stockCommissionDollars: round.stockCommissionDollars,
    leapsCapBaseLabel: "the ticker's pot",
    capsLeapsAtAskSize: false,
  });
  // The first pass says what steps 1 to 3 did and leaves the LEAPS to the second, which says what only the LEAPS did (and
  // the free cash cut).
  const runOnce = (leapsQuotesByExpiry: ReadonlyMap<string, SymbolFileQuote[]>) => {
    const state = structuredClone(memory!.state);
    const missing = new Set<string>();
    const { book, planned, cashCutNotes } = createVolFarmerV2LiveBook({ state, pending: memory!.pending, snapshot });
    const turn = runVolFarmerV2Turn({ state, market: marketWith(leapsQuotesByExpiry, missing), farmer, v2, book });
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
  // The second pass sends the LEAPS only: what steps 1 to 3 plan again went out at the first (or waits for a later round).
  const sendsOrder = (order: VolFarmerV2PlannedOrder) => pass === "cycles_calls_puts" || order.kind === "buy_leaps";
  summary.planned += look.planned.filter(sendsOrder).length;

  // 4. The orders, in the steps' order: each one not sent is undone, as if never placed.
  const state = look.state;
  const pending = [...memory.pending];
  const undo = (order: VolFarmerV2PlannedOrder) => {
    const unsent = pendingVolFarmerV2Order(state, order, `unsent-${order.ref}`, round.optionCommissionDollars);
    replaceVolFarmerV2LegRef(state, order.ref, unsent.ref);
    settleVolFarmerV2Order(state, unsent, unfilledVolFarmerV2Outcome);
  };
  const tickerCounts = { working: pending.length, ordersToday: Number(((await ladderOrdersSentToday(now, symbol)) as { count?: string | number } | undefined)?.count ?? 0), openPositions: positions.length };
  for (const order of look.planned) {
    if (!sendsOrder(order)) {
      undo(order);
      continue;
    }
    if (input.stressed && order.kind !== "sell_leaps") {
      note(`market stress: ${describePlanned(order)} is not sent while SPY is down`);
      undo(order);
      continue;
    }
    const toSend = await ordersToSend(order);
    if (toSend.length === 0) {
      note(`${describePlanned(order)}: no LEAPS leg found to sell`);
      undo(order);
      continue;
    }
    const sent: VolFarmerV2PendingOrder[] = [];
    for (const item of toSend) {
      const result = await sendOrder({ input, ticker, item, stockPrice, forwardAnchors, clock, round, tickerCounts, farmer, v2 });
      if (result.actionId === null) {
        note(result.detail);
        continue;
      }
      const pendingOrder = pendingVolFarmerV2Order(state, order, result.actionId, round.optionCommissionDollars);
      sent.push(item.leg ? { ...pendingOrder, contracts: item.contracts } : pendingOrder);
      if (!result.sent) note(result.detail);
      else summary.sent += 1;
    }
    if (sent.length === 0) {
      undo(order);
      continue;
    }
    // The order's legs in the state take the reference of its first action; a LEAPS sale of several legs has one per leg.
    replaceVolFarmerV2LegRef(state, order.ref, sent[0]!.ref);
    pending.push(...sent);
  }
  await saveVolFarmerV2Memory(tickerId, { state, pending }, adopted);
  return { leapsDue: look.leapsDue };
}

/** Every leg reference the state holds. */
function legIdsOf(state: VolFarmerV2SymbolState): string[] {
  return [...[state.first, state.second].flatMap((position) => (position === null ? [] : [...position.calls, ...position.puts].map((entry) => entry.legId))), ...(state.leaps?.legIds ?? [])];
}

function describePlanned(order: VolFarmerV2PlannedOrder): string {
  if (order.kind === "buy_leaps" || order.kind === "sell_leaps") return order.kind === "buy_leaps" ? order.purchase.description : order.sale.description;
  return order.sale.description;
}

/** What a planned order sends: one order, or for a LEAPS sale one per leg still held (a purchase and its top-ups). */
async function ordersToSend(order: VolFarmerV2PlannedOrder): Promise<VolFarmerV2OrderToSend[]> {
  if (order.kind === "covered_call" || order.kind === "cash_secured_put") {
    const { candidate, contracts, chosenBecause, candidateScores } = order.sale;
    const isCall = order.kind === "covered_call";
    return [{ order, kind: isCall ? "open_covered_call" : "open_cash_secured_put", contract: { strategyKey: order.kind, expiry: candidate.expiry, strike: candidate.strike, right: isCall ? "C" : "P" }, contracts, chosenBecause, scores: candidateScores, side: "sell" }];
  }
  if (order.kind === "buy_leaps") {
    const { purchase } = order;
    return [{ order, kind: "buy_leaps", contract: { strategyKey: "leaps", expiry: purchase.expiry, strike: purchase.strike, right: "C" }, contracts: purchase.contracts, chosenBecause: purchase.chosenBecause, scores: purchase.candidateScores, side: "buy" }];
  }
  const legs: { id: string; position_id: string; quantity: number; exit_at: Date | null }[] = await db("position_legs").whereIn("id", order.sale.legIds).select("id", "position_id", "quantity", "exit_at");
  return legs
    .filter((leg) => leg.exit_at === null)
    .map((leg) => ({ order, kind: "sell_leaps" as const, contract: { strategyKey: "leaps" as const, expiry: order.sale.expiry, strike: order.sale.strike, right: "C" as const }, contracts: leg.quantity, chosenBecause: order.sale.chosenBecause, scores: order.sale.candidateScores, side: "sell" as const, leg: { legId: leg.id, positionId: leg.position_id } }));
}

/**
 * One order: the caps (an opening order), the live quote, v2's checks on it, the mid on the tick, then the executor.
 * Answers the action recorded (null when the caps held it before any action), whether an order went to IBKR, and why not.
 */
async function sendOrder(context: {
  input: VolFarmerV2RoundInput;
  ticker: PlutoTickerSettings;
  item: VolFarmerV2OrderToSend;
  stockPrice: number;
  forwardAnchors: ReadonlyMap<string, { forward: number; spotPrice: number }>;
  clock: { todayIso: string; closeMinutesEt: number; riskFreeRate: number };
  round: RoundState;
  tickerCounts: { working: number; ordersToday: number; openPositions: number };
  farmer: ReturnType<typeof volFarmerV2RulesOf>["farmer"];
  v2: ReturnType<typeof volFarmerV2RulesOf>["v2"];
}): Promise<{ actionId: string | null; sent: boolean; detail: string }> {
  const { input, ticker, item, stockPrice, clock, round, tickerCounts, farmer, v2 } = context;
  const { settings } = input;
  const opening = item.kind !== "sell_leaps";
  const description = `${item.side === "buy" ? "Buy" : "Sell"} ${item.contracts}× ${item.contract.strike} ${item.contract.right === "C" ? "Call" : "Put"} ${item.contract.expiry}`;

  // The caps the ladder's orders count under; a LEAPS sale only reduces what is held.
  if (opening) {
    const caps: [number, string][] = [
      [settings.ladderMaxWorkingOrdersPerTicker - tickerCounts.working, `${tickerCounts.working} of the ticker's orders are working, at most ${settings.ladderMaxWorkingOrdersPerTicker} at once`],
      [settings.ladderMaxOrdersPerTickerPerDay - tickerCounts.ordersToday, `${tickerCounts.ordersToday} of the ticker's ${settings.ladderMaxOrdersPerTickerPerDay} orders a day are sent`],
      [settings.ladderMaxOpenPositionsPerTicker - tickerCounts.openPositions - tickerCounts.working, `the ticker has ${tickerCounts.openPositions} open position(s) and ${tickerCounts.working} working order(s), at most ${settings.ladderMaxOpenPositionsPerTicker} positions`],
      [settings.ladderMaxOpenPositions - round.bookCounts.openPositions - round.bookCounts.workingOrders, `Pluto's tickers have ${round.bookCounts.openPositions} open position(s) and ${round.bookCounts.workingOrders} working order(s), at most ${settings.ladderMaxOpenPositions}`],
      [settings.ladderMaxOrdersPerDay - round.bookCounts.ordersToday, `${round.bookCounts.ordersToday} of Pluto's ${settings.ladderMaxOrdersPerDay} orders a day are sent`],
    ];
    const held = caps.find(([room]) => room < 1);
    if (held) return { actionId: null, sent: false, detail: `${description} waits for a later round: ${held[1]}` };
  }

  const contract = { expiry: item.contract.expiry, strike: item.contract.strike, right: item.contract.right };
  const [live] = await input.marketWatch.burst(ticker.symbol, [contract]);
  const now = new Date();
  const twoSided = live && live.bid !== null && live.ask !== null && live.bid > 0 && live.ask > live.bid ? { bid: live.bid, ask: live.ask } : null;
  const limitPrice = twoSided ? optionMidLimitPrice(twoSided.bid, twoSided.ask, item.side) : null;
  const quoteRejection = twoSided ? baselineQuoteRejection(twoSided, farmer.maxSpreadPctOfMid) : null;
  const isLeaps = item.contract.strategyKey === "leaps";
  const isPut = item.contract.right === "P";
  // The Calls are held to v2's Calls' range, the Puts to |delta| at most its Put |delta|; a LEAPS has no range.
  const deltaContext: LadderDeltaContext = { minAbsDelta: isPut ? 0 : farmer.callMinAbsDelta, maxAbsDelta: isPut ? v2.putMaxAbsDelta : farmer.callMaxAbsDelta, forwardAnchor: context.forwardAnchors.get(item.contract.expiry) ?? null, riskFreeRate: clock.riskFreeRate, todayIso: clock.todayIso, closeMinutesEt: clock.closeMinutesEt };
  const verdict = twoSided && !isLeaps ? ladderDeltaVerdict({ ...twoSided, stockPrice, strike: item.contract.strike, expiryIso: item.contract.expiry, isCall: !isPut, putHeldToRange: isPut, now, context: deltaContext }) : null;
  // A sale is held to the steps' bid minimum and spread limit; a LEAPS purchase or sale to a two-sided quote within the spread limit.
  const ruleFailure = twoSided === null ? null : quoteRejection === "noUsableQuote" && item.side === "sell" && !isLeaps ? `the live bid ${twoSided.bid.toFixed(2)} is under the $0.05 minimum` : quoteRejection === "spreadTooWide" ? `the live spread is ${(((twoSided.ask - twoSided.bid) / ((twoSided.bid + twoSided.ask) / 2)) * 100).toFixed(1)}% of the mid, above v2's ${farmer.maxSpreadPctOfMid}%` : null;
  const notional = limitPrice === null ? 0 : item.contract.strategyKey === "cash_secured_put" ? Math.max(0, item.contract.strike - limitPrice) * 100 * item.contracts : item.contract.strategyKey === "leaps" ? (opening ? limitPrice * 100 * item.contracts : 0) : item.order.kind === "covered_call" && item.order.sale.startsCycle ? item.contracts * 100 * Math.max(0, stockPrice - limitPrice) : 0;
  const capital = opening && limitPrice !== null ? ladderBookCapitalVerdict({ committedBeforeDollars: round.bookCommitted, orderNotional: notional, budgetFraction: settings.capitalBudgetPct / 100, netLiquidationValue: input.netLiquidationValue }) : null;
  const gateResults: PlutoGateResult[] = [
    { gate: "vol_farmer_v2", ok: true, detail: item.chosenBecause },
    { gate: "live_quote", ok: twoSided !== null, detail: twoSided ? `bid ${twoSided.bid.toFixed(2)}, ask ${twoSided.ask.toFixed(2)}` : "no live two-sided quote" },
    ...(twoSided ? [{ gate: "vol_farmer_v2_rules", ok: ruleFailure === null, detail: ruleFailure ?? "the live quote passes v2's bid and spread rules" }] : []),
    ...(verdict ? [{ gate: "vol_farmer_v2_delta", ok: verdict.compliant, detail: verdict.reason ?? `own |delta| ${Math.abs(verdict.delta ?? 0).toFixed(3)} inside ${deltaContext.minAbsDelta}–${deltaContext.maxAbsDelta}` }] : []),
    ...(capital ? [{ gate: "book_capital", ok: capital.fits, detail: capital.fits ? `Pluto's tickers commit ${capital.committedAfterDollars.toFixed(0)} of ${capital.capDollars.toFixed(0)} after it` : `Pluto's tickers would commit ${capital.committedAfterDollars.toFixed(0)}, above Pluto's capital budget of ${capital.capDollars.toFixed(0)}` }] : []),
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
    executionStrategy: "vol_farmer_v2",
  });
  if (!ok) {
    const detail = gateResults.filter((gate) => !gate.ok).map((gate) => gate.detail).join("; ");
    await recordPlutoEvent("action_blocked", { passId: input.passId, actionId, symbol: ticker.symbol, stage: "vol_farmer_v2", reason: detail });
    return { actionId, sent: false, detail: `${description} blocked: ${detail}` };
  }
  await recordPlutoEvent("action_validated", { passId: input.passId, actionId, symbol: ticker.symbol, quantity: item.contracts, limitPrice, reasons: [item.chosenBecause] });
  const dte = daysToExpiry(item.contract.expiry, clock.todayIso);
  const plan = { quantity: item.contracts, limitPrice: limitPrice!, notional, fullSizeQuantity: item.contracts };
  const reasons = [`Vol Farmer v2: ${item.chosenBecause}.`];
  const scoresSnapshot = { kind: "vol_farmer_v2", version: "vf2-1", contract: { ...contract, bid: twoSided!.bid, ask: twoSided!.ask, quoteSource: "live", quotedAt: live?.quotedAt ?? null, delta: verdict?.delta ?? null }, order: { contracts: item.contracts, chosenBecause: item.chosenBecause, scores: item.scores } };
  const executeInput: ExecuteInput =
    item.kind === "buy_leaps"
      ? { kind: "leaps_buy", actionId, symbol: ticker.symbol, contract: { expiry: contract.expiry, strike: contract.strike, right: "C", dte }, plan, reasons, scoresSnapshot }
      : item.kind === "sell_leaps"
        ? { kind: "leaps_sell", actionId, symbol: ticker.symbol, positionId: item.leg!.positionId, legId: item.leg!.legId, contract: { expiry: contract.expiry, strike: contract.strike, right: "C", dte }, plan, reasons }
        : { kind: "ladder_open", actionId, symbol: ticker.symbol, strategyKey: item.contract.strategyKey as "covered_call" | "cash_secured_put", contract: { ...contract, dte }, plan, buyEveryShare: item.order.kind === "covered_call" && item.order.sale.startsCycle, reasons, scoresSnapshot };
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
    round.committedThisRound += item.contract.strategyKey === "cash_secured_put" ? item.contract.strike * 100 * item.contracts : item.contract.strategyKey === "leaps" ? limitPrice! * 100 * item.contracts : item.order.kind === "covered_call" && item.order.sale.startsCycle ? stockPrice * 100 * item.contracts : 0;
  }
  input.trackWatch(
    watchPlutoOrder(input.api, settings, { actionId, orderId: result.orderId, symbol: ticker.symbol, reference: { price: limitPrice!, side: item.side, multiplier: 100, ...(result.otherReferenceLegs ? { otherLegs: result.otherReferenceLegs } : {}) }, description: result.detail, cancelByMs: input.cancelByMs }),
    result.orderId,
    ticker.symbol,
  );
  return { actionId, sent: true, detail: result.detail };
}

/**
 * A LEAPS expiry's Calls, live: its strikes (stored, else looked up from IBKR for the day), those whose Black-Scholes
 * |delta| at IBKR's 30-day IV (50% without one) is nearest the LEAPS |delta| (and the strike held, for a top-up or a
 * sale), as many as a quote burst takes. Quotes carry no size.
 */
async function quoteLeapsExpiry(context: { input: VolFarmerV2RoundInput; ticker: PlutoTickerSettings; expiry: string; stockPrice: number; riskFreeRate: number; impliedVolatility: number | null; heldStrike: number | null; storedStrikes: number[] | null; absDelta: number }): Promise<SymbolFileQuote[]> {
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
