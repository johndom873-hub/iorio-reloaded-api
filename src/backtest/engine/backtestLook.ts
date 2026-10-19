import { closeGateVerdictFromState, type CloseGateVerdict } from "../../lib/closeGate.js";
import type { CycleInput } from "../../lib/cycles.js";
import { deriveCloseLiveState, type CloseLiveLeg, type CloseLiveQuote } from "../../lib/closeLiveState.js";
import { flatCommissionEstimator } from "../../lib/commissionEstimate.js";
import { commissionPerContractDollars } from "../../lib/optionFriction.js";
import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { formatSignedDollars } from "../../lib/formatSignedDollars.js";
import { computeOrderNotional, evaluateOrderLimitFigures } from "../../lib/orderLimits.js";
import type { HeldLegScore, OpenShortLeg } from "../../lib/rollSignalCandidates.js";
import type { MacroEvent } from "../../lib/macroEventCalendar.js";
import { heaviestMacroEventBeforeExpiry } from "../../lib/macroEventTiming.js";
import type { SignalCandidate } from "../../lib/signalCandidates.js";
import { contractKey, scoreHeldShareCalls, scoreTicker, type LiveOptionQuote } from "../../lib/signalsLiveScoring.js";
import type { TickerSignals, TickerSignalsInputs } from "../../lib/signalsTypes.js";
import { addCalendarDays } from "../../lib/signalsRoadmap.js";
import type { ElevatedVolatilityFlag } from "../../lib/tiltMeasures.js";
import type { TradingSettings } from "../../lib/tradingSettingsStore.js";
import type { VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import { filterTickerForPluto, type OccupiedContract, type PlutoOpenCandidate, type PlutoRollCandidate, type PlutoTickerFilterResult } from "../../pluto/candidateFilters.js";
import { buildCloseOffersFromBook, countSessionsLeftBeforeEarnings, eventCloseDue, evaluateEventCoveredCallClose, type CloseOffer, type CloseOffersBook, type CloseOffersForTickerInput, type UpcomingEarnings } from "../../pluto/closeActions.js";
import { heldCoveredCallEntry, withStressMove } from "../../pluto/heldPositionMetrics.js";
import { flaggedSymbols, type PlutoDecision } from "../../pluto/decisionSchema.js";
import { computeMoveContext } from "../../pluto/moveContext.js";
import { heldShareCallGate, type CycleBreakEven } from "../../pluto/heldShareCalls.js";
import type { PlutoGateResult } from "../../pluto/ledger.js";
import { computeKellyCap, computeSizingRoom, computeStressCap, midLimitPrice, runHeldShareCallGates, runPostModelGates, stressCapInputFor, tickerCooldownStatus } from "../../pluto/postModelGates.js";
import { countPlutoRejections } from "../../pluto/rejectionSummary.js";
import type { BacktestAction, BacktestActionKind, BacktestBaselineSettings, BacktestOrderShortfall, EffectiveBacktestSettings } from "../backtestTypes.js";
import { toOhlcvBars, type BacktestBarHistory } from "./backtestBarHistory.js";
import { computeSaleFillPrice, sharesPerContract } from "./backtestBook.js";
import { classifyOpenRefusal, orderLimitBreachesOf, type OpenRefusalInput } from "./backtestOpenRefusal.js";
import { decideWithLlm, findOfferedChoice, ivRankFromHistory, type BacktestLlmRound, type BacktestLlmSession, type BacktestLlmTicker } from "./backtestLlmDecider.js";
import { chooseBacktestAction, openClosedAtOnceByEventRule, type BacktestPolicyChoice } from "./backtestPolicy.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { buildHistoricalTickerInputs, captureLookTimeEt, ContractSet, earningsKnownOn, lookInstantMs, selectLookDayQuotes, type BacktestDayMarket, type BacktestTickerProfile } from "./backtestTickerInputs.js";
import type { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import type { BacktestScoringPool } from "./backtestScoringPool.js";
import { buyBackPut, closeCoveredCall, openCashSecuredPut, openCoveredCall, rollLeg, sellShares } from "./ledger/ledgerEvents.js";
import { optionPurchaseFillPrice } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerCashLockedInCashSecuredPuts, ledgerCommittedDollars, ledgerCycleInput, ledgerFreeCash, ledgerFreeShares, ledgerLastFilledActionAt, ledgerNetLiquidationValue, ledgerOpenCycleSummary, ledgerPostModelBook } from "./ledger/ledgerSelectors.js";
import { cycleSplitFactorFor, legsOfPosition, positionsOfSymbol, requireLeg, requirePosition, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

// One look of a backtest day (docs/backtesting/FULL-FIDELITY-DESIGN.md §4): Pluto's passes over every symbol of the
// session on one simulated ledger, at one instant inside its trading window, until a pass takes no action.
//
// What a look scores a symbol from, exactly as live scores it at that instant:
//   - the 10:00 look reads the 10:00 capture itself: its quotes, the surface fitted on them, the 10:00 stock price
//   - a later look keeps the 10:00 surface and reads its own quotes as the day's fresh quotes (source "day", stamped with
//     the look's instant) over the capture's (mergeLiveQuotes, appendMissingContractQuotes); the stock price its quotes
//     imply is the live spot, so the surface follows it by sticky moneyness (scaleSlicesToLiveSpot) and each expiry
//     takes the median gap between its fresh mids and the surface (computeExpiryIvShifts); the scoring instant is the
//     look's (variance left, macro events still ahead); the day change is the look's price against the previous close.
//     A capture quote the look does not re-quote on both sides stays as it was at 10:00, and Pluto's quote-age rule
//     refuses it.
//
// Each pass, as passRunner.ts runs it:
//   1. every symbol is scored (scoreTicker) with the book's free shares and open short legs on it, the held legs the
//      fresh quotes do not cover quoted from the look's file quotes (as live's appendMissingContractQuotes), then
//      filtered (filterTickerForPluto) with its occupied contracts, its cycle break-even and its ticker cooldown; under
//      market stress (SPY down on the day by the breaker's percentage) every eligible open is refused, rolls and closes
//      stay
//   2. close offers per symbol (buildCloseOffersFromBook) with the close gate derived from the look's own quotes
//      (deriveCloseLiveState, market open); an automatic one (an odd lot in profit, a close before earnings) is sent at
//      once, before anything is chosen, and the pass starts again on the changed book; so is, after them, the call code
//      sells on a symbol's free shares (selectHeldShareCall, runHeldShareCallGates; Marcelo 2026-10-12), unless market
//      stress bars opens. A covered call written on shares already held is left through earnings (no P3b close).
//   3. the decision rules stand in for the AI model (backtestPolicy.ts): one offer across all symbols, or nothing; in
//      LLM mode the model decides instead, through the live agent's rounds and change check (backtestLlmDecider.ts),
//      and its own decision (confidence, data concerns) goes through the gates
//   4. an open or a roll goes through the post-model gates on the shared book (runPostModelGates: budget, order size,
//      open positions, ticker and sector exposure, cash reserve) and the order gate's three limits
//      (evaluateOrderLimitFigures); a close through the close gate again, as the close route does
//   5. the order fills at once and the ledger takes the event (ledger/ledgerEvents.ts)
// A pass in which nothing is chosen ends the look; so does the session's actions cap, counted across all symbols and
// all the looks of the day. A choice the gates refuse is recorded with the gate that refused it, and then, by the
// session's rule (afterBlockedChoice), either ends the look (stop) or is left out for the rest of it while the rules
// choose again (try_next). Choosing again, a refused open whose refusal says the account has no room (backtestOpenRefusal.ts)
// also ends the opens where there is none: on its ticker (the ticker's exposure limits, its cooldown) or on every
// ticker (the budget, the cash reserve, the open-positions cap). Rolls and closes are still tried.
//
// A symbol's scoring is kept until its own book changes. A fill on another symbol changes only the free cash, which
// scoring reads for one thing (a put the cash cannot secure is flagged): the scoring is redone only when that flag
// would change on one of the symbol's candidates.
//
// Fills, at the look's own quotes: an option sold at mid − spread cost share × half-spread, bought back at mid + the
// same; shares bought at the look's stock price + $0.01, sold at − $0.01 (the stock is quoted price ∓ $0.01 wherever a
// rule reads its bid and ask). A held leg is bought back only on a quote of this look.
//
// What live Pluto checks that a replay on a fixed grid cannot, and how it is neutralised:
//   - quote age: a look decides at the instant of its quotes, so they are 0 minutes old
//   - the fresh re-score and edge drift before the order: the re-score is the same look's data, so it passes unchanged
//   - the model's confidence and data concerns: always confident, no concerns
//   - working orders, in-flight notional: fills are immediate
// The daily-loss breaker, the trading window and SPY's day change are the session's (runBacktestSession.ts): it runs a
// look only inside the window while the breaker holds, and tells it when market stress bars new opens.
//
// Scales: Pluto sees today's chain (prices, strikes and 100-share contracts as traded today); the ledger holds a
// symbol's open cycle on the scale of its first day. With r = F(cycle) ÷ F(today), a price goes to the ledger × r and a
// share count ÷ r, and comes back the other way. r is 1 unless a split fell inside the open cycle.

/** One symbol at a look: its day (the 10:00 capture and what was known that morning) and, after 10:00, the look's own quotes. */
export interface BacktestLookSymbol {
  profile: BacktestTickerProfile;
  /** The ticker's daily bars on today's traded scale. */
  bars: BacktestBarHistory;
  /** The 10:00 capture. */
  market: BacktestDayMarket;
  /** Precomputed elevated-volatility flag for the day; computed from the bars when absent. */
  elevatedVolatility?: ElevatedVolatilityFlag | null;
  /** The major macro events from today on, as the calendar held them that day; none when absent. */
  macroEvents?: readonly MacroEvent[];
  /** A look after 10:00: its quotes and the stock price they imply. Absent at the 10:00 look, which reads the capture. */
  intraday?: {
    quotes: readonly SymbolFileQuote[];
    stockPrice: number;
    /** The look's day quotes when the caller selected them already (selectLookDayQuotes on these quotes, this price and the look's instant). */
    dayQuotes?: LiveOptionQuote[];
  };
  /** Today's cumulative split factor. */
  splitFactorToday: number;
  /** False when the open cycle spans a split whose contracts do not fit its share scale: no option order is simulated on the ticker until it ends. */
  optionContractsRepresentable: boolean;
  /** IBKR's split-adjusted daily closes before today, ascending. */
  adjustedDailyClosesBeforeToday: readonly { date: string; close: number }[];
}

/** What a symbol's looks of one day share: the Signals inputs built from the 10:00 capture (the surface fit among them) and its calendar figures. */
export interface BacktestPreparedSymbolDay {
  inputs: TickerSignalsInputs;
  fitIssue: string | null;
  referenceVolatility: number | null;
  /** The contracts of the 10:00 capture. */
  capturedContracts: ContractSet;
  earnings: UpcomingEarnings | null;
  sessionsLeftBeforeEarnings: number | null;
  /** IBKR's daily closes before today on a cycle's scale. */
  dailyClosesOnCycleScale(cycleSplitFactor: number): { date: string; close: number }[];
}

/** One ticker of a session of per-ticker pots: its baseline settings (the session's with its own values) and its weight, its pot ÷ every pot. */
export interface BacktestTickerSetup {
  baseline: BacktestBaselineSettings;
  weight: number;
}

export interface BacktestLookContext {
  todayIso: string;
  /** The look's time, "HH:MM" Eastern; 10:00 when absent. */
  lookTimeEt?: string;
  /** The symbols scored at this look (those with a file day, a 10:00 stock price and, after 10:00, a price from the look's quotes), in the session's order. */
  symbols: readonly BacktestLookSymbol[];
  /** Kept by the caller across the looks of one day, by symbol: a look prepares the symbols it lacks. */
  preparedDayBySymbol?: Map<string, BacktestPreparedSymbolDay>;
  /** Builds each symbol's day and scores it on worker threads, the symbols of a pass in parallel (backtestScoringPool.ts); on this thread when absent. */
  scoringPool?: BacktestScoringPool | null;
  /** With a scoring pool: called once the look's first scoring requests are on the workers, so the caller can prepare the next look meanwhile. */
  onFirstScoresSent?: () => void;
  /** Actions filled at the day's earlier looks: the actions cap counts the whole day. 0 when absent. */
  filledActionsEarlierToday?: number;
  /** Why no open may be sent at this look (market stress); rolls and closes stay. */
  opensBlockedBecause?: string | null;
  /** The sector of every symbol of the session, scored today or not: sector exposure counts all of them. */
  sectorBySymbol: ReadonlyMap<string, string | null>;
  calendar: BacktestTradingCalendar;
  settings: EffectiveBacktestSettings;
  /** A session of per-ticker pots: each ticker's own baseline settings and its weight. Absent when the tickers share one account and the session's settings. */
  tickerSetupBySymbol?: ReadonlyMap<string, BacktestTickerSetup>;
  modelTables: VolatilityModelTables;
  ledger: SimulatedLedger;
  /** The session day before today; null on the first. */
  previousSessionDateIso: string | null;
  /** The 10:00 mark per share of every open leg, on its cycle's scale. The look adds the legs it opens. */
  priceByLegId: Map<string, number>;
  nextActionId(): string;
  /**
   * LLM mode: the session's model state, the rounds of this look (forced ones first, then the look's own), the day's
   * window end and SPY's day change at the look. Absent in rules mode.
   */
  llm?: { session: BacktestLlmSession; rounds: readonly BacktestLlmRound[]; windowEndEt: string; spyDayChangePercent: number | null };
}

/** Bars loadBarsForTilt reads (the move context's history). */
const moveContextBarCount = 1500;

/** One option sold in the look, as traded: what the session's per-option trade row is built from. */
export interface BacktestOptionSale {
  legId: string;
  actionId: string;
  symbol: string;
  openedOn: string;
  strategyKey: "cash_secured_put" | "covered_call";
  expiry: string;
  strike: number;
  optionRight: "C" | "P";
  contracts: number;
  bid: number;
  ask: number;
  fillPrice: number;
  commissionDollars: number;
  spotAtOpen: number;
  sharePriceAtOpen: number | null;
  exposureDollars: number;
  dte: number;
  delta: number | null;
  /** The model's figures; null for a baseline wheel's sale (no model). */
  grade: string | null;
  edgeMargin: number | null;
  expectedPnlDollars: number | null;
  calibratedExpectedPnlDollars: number | null;
  edgeYield: number | null;
  histYield: number | null;
  kellyContracts: number | null;
  stressContracts: number | null;
  /** r on the opening day: the ledger's prices ÷ this are the prices as traded that day. */
  priceToCycleScale: number;
}

export interface BacktestLookResult {
  /** Filled and refused, in order. */
  actions: BacktestAction[];
  optionSales: BacktestOptionSale[];
  /** One line on the look: what was done, or why nothing was, symbol by symbol, then where opens were stopped. */
  summary: string;
  /** The same without where opens were stopped, and those apart ("no further opens on SMCI: no ticker room"): a day of several looks says each once. */
  summaryOfActions: string;
  opensStopped: string[];
  /** Per symbol: why no surface was fitted (skip reason or "error: ..."), null when one was. */
  fitIssueBySymbol: Map<string, string | null>;
  /** Per symbol: the last scoring, for diagnostics. */
  scoredBySymbol: Map<string, TickerSignals>;
  /** LLM mode: the model calls the look made, and how many the cache answered. */
  llmCalls: { asked: number; fromCache: number };
  /** The baseline: its orders that left contracts unsold. */
  shortfalls?: BacktestOrderShortfall[];
}

const roundedStrike = (strike: number) => Math.round(strike * 10_000) / 10_000;
/** The rules always choose with full confidence. */
const standInConfidence: Pick<PlutoDecision, "confidence"> = { confidence: 1 };
const roundedShares = (shares: number) => Math.round(shares * 1_000_000) / 1_000_000;
const isWholeNumber = (value: number) => Math.abs(value - Math.round(value)) < 1e-9;
const rightOf = (strategyKey: "cash_secured_put" | "covered_call"): "C" | "P" => (strategyKey === "covered_call" ? "C" : "P");

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/** "grade 40, edge_yield 30" — the rules that rejected the most contracts, most first. */
function describeRejectionCounts(counts: Partial<Record<string, number>>, limit = 4): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, limit)
    .map(([code, count]) => `${code} ${count}`)
    .join(", ");
}

/** Why the pass offered no open, in the day's words. */
function describeNoEligibleOpen(scored: TickerSignals, filtered: PlutoTickerFilterResult, fitIssue: string | null): string {
  if (filtered.tickerBlocks.length > 0) return filtered.tickerBlocks.join("; ") + (fitIssue ? ` (${fitIssue})` : "");
  if (scored.candidates.length === 0) {
    const reason = scored.noCandidatesReason;
    const detail = reason ? `${reason.kind === "filtered" ? "all filtered by the trading settings" : "nothing scorable"}: delta below ${reason.deltaTargetMin} ${reason.belowMinDeltaCount}, above ${reason.deltaTargetMax} ${reason.aboveMaxDeltaCount}, yield below ${reason.minAnnualizedYieldPct}% ${reason.belowMinYieldCount}${reason.spansEarningsExpiries.length > 0 ? `, ${reason.spansEarningsExpiries.length} expiries span earnings ${reason.earningsDateIso ?? ""}` : ""}${reason.surfaceFitRejectedExpiries.length > 0 ? `, ${reason.surfaceFitRejectedExpiries.length} expiries without a usable fit` : ""}` : "";
    return `no candidates${detail ? ` (${detail.trim()})` : ""}`;
  }
  const counts = countPlutoRejections(filtered.rejected);
  return `${scored.candidates.length} candidates, none eligible (rejected by ${describeRejectionCounts(counts.rejectedBy)}; only blocker ${describeRejectionCounts(counts.onlyBlocker) || "none"})`;
}

/** The figures of a candidate worth keeping with an action. */
function summarizeCandidate(candidate: SignalCandidate): Record<string, unknown> {
  const model = candidate.model;
  return {
    strategyKey: candidate.strategyKey,
    expiry: candidate.expiry,
    strike: candidate.strike,
    dte: candidate.dte,
    delta: candidate.delta,
    bid: candidate.bid,
    ask: candidate.ask,
    spreadPercent: candidate.spreadPercent,
    openInterest: candidate.openInterest,
    volume: candidate.volume,
    surfaceImpliedVolatility: candidate.surfaceImpliedVolatility,
    midImpliedVolatility: candidate.midImpliedVolatility,
    model: model ? { grade: model.grade, edgeMargin: model.edgeMargin, fairPrice: model.fairPrice, expectedPnlDollars: model.expectedPnlDollars, calibratedExpectedPnlDollars: model.calibratedExpectedPnlDollars, expectedAnnualizedReturn: model.expectedAnnualizedReturn, calibratedAnnualizedReturn: model.calibratedAnnualizedReturn, premiumYield: model.premiumYield, capitalAtRiskDollars: model.capitalAtRiskDollars } : null,
  };
}

/** The next earnings announcement still to come and known that day (earningsKnownOn), as closeActions.ts loadUpcomingEarnings reads it. */
function upcomingEarnings(profile: BacktestTickerProfile, todayIso: string): UpcomingEarnings | null {
  const event = earningsKnownOn(profile.earnings, todayIso).find((entry) => entry.dateIso >= todayIso && !(entry.dateIso === todayIso && entry.eventTime === "-1"));
  return event ? { dateIso: event.dateIso, time: event.eventTime } : null;
}

/** What the looks of a day share for one symbol, from its 10:00 capture. */
export function prepareBacktestSymbolDay(lookSymbol: BacktestLookSymbol, calendar: BacktestTradingCalendar): BacktestPreparedSymbolDay {
  const built = buildHistoricalTickerInputs({ profile: lookSymbol.profile, bars: lookSymbol.bars, market: lookSymbol.market, calendar, elevatedVolatility: lookSymbol.elevatedVolatility, macroEvents: lookSymbol.macroEvents });
  return completePreparedSymbolDay(built, lookSymbol, calendar);
}

/** The prepared day from the day's built inputs (built here or on a scoring worker): its calendar figures and closes. */
function completePreparedSymbolDay(built: ReturnType<typeof buildHistoricalTickerInputs>, lookSymbol: BacktestLookSymbol, calendar: BacktestTradingCalendar): BacktestPreparedSymbolDay {
  const { profile, market } = lookSymbol;
  const todayIso = market.todayIso;
  const earnings = upcomingEarnings(profile, todayIso);
  const cycleScaledClosesByFactor = new Map<number, { date: string; close: number }[]>();
  return {
    ...built,
    capturedContracts: ContractSet.of(built.inputs.quotes),
    earnings,
    sessionsLeftBeforeEarnings: earnings && Date.parse(earnings.dateIso) - Date.parse(todayIso) <= 14 * 86_400_000 ? countSessionsLeftBeforeEarnings(todayIso, earnings, calendar.openDaysBetween(todayIso, earnings.dateIso)) : null,
    dailyClosesOnCycleScale: (cycleSplitFactor) => {
      let closes = cycleScaledClosesByFactor.get(cycleSplitFactor);
      if (!closes) {
        closes = lookSymbol.adjustedDailyClosesBeforeToday.map((bar) => ({ date: bar.date, close: bar.close * cycleSplitFactor }));
        cycleScaledClosesByFactor.set(cycleSplitFactor, closes);
      }
      return closes;
    },
  };
}

export async function runBacktestLook(context: BacktestLookContext): Promise<BacktestLookResult> {
  const { settings, ledger, calendar, todayIso } = context;
  const pluto = settings.pluto;
  const trading = settings.trading as TradingSettings;
  const lookTimeEt = context.lookTimeEt ?? captureLookTimeEt;
  const nowMs = lookInstantMs(todayIso, lookTimeEt);
  const at = new Date(nowMs);
  const opensBlockedBecause = context.opensBlockedBecause ?? null;
  const filledActionsEarlierToday = context.filledActionsEarlierToday ?? 0;
  const spreadShareCharged = trading.spreadCostChargedPct / 100;
  const sectorBySymbol = new Map(context.sectorBySymbol);
  /** A session of several symbols names the symbol with each reason. */
  const severalSymbols = sectorBySymbol.size > 1;

  const actions: BacktestAction[] = [];
  const optionSales: BacktestOptionSale[] = [];
  const fitIssueBySymbol = new Map<string, string | null>();
  const scoredBySymbol = new Map<string, TickerSignals>();
  if (filledActionsEarlierToday >= pluto.maxActionsPerSession) {
    const summary = `No action: actions cap: ${filledActionsEarlierToday} of ${pluto.maxActionsPerSession} actions a session`;
    return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [], fitIssueBySymbol, scoredBySymbol, llmCalls: { asked: 0, fromCache: 0 } };
  }

  // With a scoring pool, the days not prepared yet are built on the workers, every symbol at once.
  const scoringPool = context.scoringPool ?? null;
  const preparedDayBySymbol = context.preparedDayBySymbol ?? new Map<string, BacktestPreparedSymbolDay>();
  if (scoringPool) {
    const unprepared = context.symbols.filter((lookSymbol) => !preparedDayBySymbol.has(lookSymbol.profile.symbol));
    const built = await Promise.all(
      unprepared.map((lookSymbol) => scoringPool.prepareDay({ symbol: lookSymbol.profile.symbol, splitFactor: lookSymbol.splitFactorToday, market: lookSymbol.market, elevatedVolatility: lookSymbol.elevatedVolatility, macroEvents: lookSymbol.macroEvents })),
    );
    unprepared.forEach((lookSymbol, index) => preparedDayBySymbol.set(lookSymbol.profile.symbol, completePreparedSymbolDay(built[index]!, lookSymbol, calendar)));
  }

  /** One symbol in the look: what does not change while it runs, and the scoring of its book as it stands. */
  const prepareSymbol = (lookSymbol: BacktestLookSymbol) => {
    const { profile, market } = lookSymbol;
    const symbol = profile.symbol;
    let day = preparedDayBySymbol.get(symbol);
    if (!day) {
      day = prepareBacktestSymbolDay(lookSymbol, calendar);
      preparedDayBySymbol.set(symbol, day);
    }
    const { inputs: baseInputs, fitIssue, earnings, sessionsLeftBeforeEarnings, dailyClosesOnCycleScale } = day;
    fitIssueBySymbol.set(symbol, fitIssue);
    // The look's own quotes and the stock price they imply: the capture's at 10:00.
    const lookQuotes = lookSymbol.intraday?.quotes ?? market.quotes;
    const stockPrice = lookSymbol.intraday?.stockPrice ?? market.stockPrice;
    // Shares trade at the look's price itself: its bid and ask are that price.
    const stockQuoteToday = { bid: stockPrice, ask: stockPrice, last: stockPrice };
    // The look's quote of a contract. Read for the held legs only, so the quotes are indexed when first asked for.
    let lookQuoteIndex: Map<string, SymbolFileQuote> | null = null;
    const lookQuoteOfContract = (key: string): SymbolFileQuote | undefined => (lookQuoteIndex ??= new Map(lookQuotes.map((quote) => [contractKey({ expiry: quote.expiry, strike: roundedStrike(quote.strike), right: quote.right }), quote]))).get(key);
    // After 10:00 the look's quotes are the day's fresh quotes over the capture's.
    const lookDayQuotes: LiveOptionQuote[] = lookSymbol.intraday ? (lookSymbol.intraday.dayQuotes ?? selectLookDayQuotes(lookQuotes, day.capturedContracts, todayIso, stockPrice, day.referenceVolatility, at.toISOString())) : [];
    const freshlyQuotedContracts: ContractSet = lookSymbol.intraday ? ContractSet.of(lookDayQuotes) : day.capturedContracts;

    /**
     * The close gate of a position of the symbol as the close route reads it, on a book and its marks: the look's quotes
     * for the position's options, the stock at the look's price, the cycle from the book. The cycle's figures are the same
     * for every position of the symbol until the book changes, so they are read once per reader.
     */
    const closeGateReader = (book: SimulatedLedger, marks: ReadonlyMap<string, number>) => {
      const cycleSplitFactor = cycleSplitFactorFor(book, symbol, lookSymbol.splitFactorToday, at);
      const priceToCycleScale = cycleSplitFactor / lookSymbol.splitFactorToday;
      const toCyclePrice = (price: number) => price * priceToCycleScale;
      const strikeToday = (leg: LedgerLeg) => roundedStrike(leg.strikePrice! / priceToCycleScale);
      const openOptionLegIds = positionsOfSymbol(book, symbol)
        .filter((position) => position.status === "open")
        .flatMap((position) => legsOfPosition(book, position.id).filter((leg) => leg.legType === "option" && leg.exitAt === null).map((leg) => leg.id));
      const optionMarkByLegId = new Map(openOptionLegIds.flatMap((legId) => (marks.has(legId) ? [[legId, marks.get(legId)!] as const] : [])));
      let cycleInput: CycleInput | null = null;
      return (positionId: string): CloseGateVerdict => {
        const position = requirePosition(book, positionId);
        if (position.status !== "open") return { blocked: true, reason: "Closing is blocked: the position is not open.", cycleTotal: null };
        const openLegs = legsOfPosition(book, positionId).filter((leg) => leg.exitAt === null);
        const closeLegs: CloseLiveLeg[] = openLegs.map((leg) => ({
          id: leg.id,
          legType: leg.legType,
          side: leg.side,
          quantity: leg.quantity,
          multiplier: leg.multiplier,
          entryPrice: leg.entryPrice,
          label: leg.legType === "stock" ? `${symbol} stock` : describeOptionContract({ symbol, strike: strikeToday(leg), right: leg.optionType === "call" ? "C" : "P", expiry: leg.expiryDate!, dte: Math.max(0, daysToExpiry(leg.expiryDate!, todayIso)) }),
        }));
        const optionQuotesByLegId: Record<string, CloseLiveQuote | null> = {};
        for (const leg of openLegs) {
          if (leg.legType !== "option") continue;
          const quote = lookQuoteOfContract(contractKey({ expiry: leg.expiryDate!, strike: strikeToday(leg), right: leg.optionType === "call" ? "C" : "P" }));
          optionQuotesByLegId[leg.id] = quote ? { bid: quote.bid === null ? null : toCyclePrice(quote.bid), ask: quote.ask === null ? null : toCyclePrice(quote.ask), last: null } : null;
        }
        cycleInput ??= ledgerCycleInput(book, symbol, { dailyCloses: dailyClosesOnCycleScale(cycleSplitFactor), optionMarkByLegId });
        return closeGateVerdictFromState(deriveCloseLiveState({ symbol, positionId, legs: closeLegs, marketState: "open", optionQuotesByLegId, stockQuote: { bid: toCyclePrice(stockQuoteToday.bid), ask: toCyclePrice(stockQuoteToday.ask), last: toCyclePrice(stockQuoteToday.last) }, cycleInput, todayIso, waitedMs: 0, settleGraceMs: 0 }));
      };
    };

    /** Steps 1 and 2 on the symbol's book as it stands. */
    const scoreBook = async () => {
      // The book as Pluto reads it, on today's scale.
      const cycleSplitFactor = cycleSplitFactorFor(ledger, symbol, lookSymbol.splitFactorToday, at);
      const priceToCycleScale = cycleSplitFactor / lookSymbol.splitFactorToday;
      const toCyclePrice = (price: number) => price * priceToCycleScale;
      const openOptionLegs = positionsOfSymbol(ledger, symbol)
        .filter((position) => position.status === "open")
        .flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.legType === "option" && leg.exitAt === null).map((leg) => ({ leg, position })));
      const contractsToday = (leg: LedgerLeg) => roundedShares((leg.quantity * leg.multiplier * priceToCycleScale) / sharesPerContract);
      const strikeToday = (leg: LedgerLeg) => roundedStrike(leg.strikePrice! / priceToCycleScale);
      const openShortLegs: OpenShortLeg[] = !lookSymbol.optionContractsRepresentable
        ? []
        : openOptionLegs
            .filter(({ leg, position }) => leg.side === "short" && position.strategyKey !== "unstructured" && isWholeNumber(contractsToday(leg)))
            .map(({ leg, position }) => ({ legId: leg.id, positionId: position.id, strategyKey: position.strategyKey as "cash_secured_put" | "covered_call", expiry: leg.expiryDate!, strike: strikeToday(leg), right: leg.optionType === "call" ? ("C" as const) : ("P" as const), quantity: Math.round(contractsToday(leg)), entryPrice: leg.entryPrice / priceToCycleScale, entryAtIso: leg.entryAt.toISOString() }))
            .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
      const occupiedContracts: OccupiedContract[] = openOptionLegs.map(({ leg }) => ({ expiry: leg.expiryDate!, strike: strikeToday(leg), detail: `open position on ${describeOptionContract({ symbol, strike: strikeToday(leg), right: leg.optionType === "call" ? "C" : "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, todayIso) })}` }));
      const freeSharesToday = roundedShares(ledgerFreeShares(ledger, symbol) * priceToCycleScale);
      const heldLegQuotesNotYetRead: LiveOptionQuote[] = openShortLegs.flatMap((leg) => {
        const key = contractKey(leg);
        const quote = freshlyQuotedContracts.has(leg) ? undefined : lookQuoteOfContract(key);
        return quote && quote.bid !== null && quote.ask !== null ? [{ expiry: leg.expiry, strike: leg.strike, right: leg.right, bid: quote.bid, ask: quote.ask }] : [];
      });

      // 1. Score and filter.
      const freeCash = ledgerFreeCash(ledger);
      const inputs = { ...baseInputs, freeShares: freeSharesToday, openShortLegs, dayQuotes: lookDayQuotes };
      const live = { spotPrice: stockPrice, priceSource: "live" as const, liveQuotes: heldLegQuotesNotYetRead };
      const scoringHistory = { modelTables: context.modelTables, scoredAtMs: nowMs };
      const { scored, heldShareCallCandidates } = scoringPool
        ? await scoringPool.score({ symbol, todayIso, freeShares: freeSharesToday, openShortLegs, dayQuotes: lookDayQuotes, freeCash, trading, live, modelTables: context.modelTables, scoredAtMs: nowMs })
        : { scored: scoreTicker(inputs, { freeCash }, trading, live, undefined, scoringHistory), heldShareCallCandidates: scoreHeldShareCalls(inputs, { freeCash }, trading, live, scoringHistory) };
      if (!scoringPool) scoredBySymbol.set(symbol, scored);
      const cooldown = tickerCooldownStatus(ledgerLastFilledActionAt(ledger, symbol), nowMs, pluto.tickerCooldownMinutes);
      const opensBlockedReason = !lookSymbol.optionContractsRepresentable ? "the open cycle spans a split whose contracts do not fit its share scale" : cooldown.cooledDown ? null : `ticker cooldown: ${cooldown.detail}`;
      const needsCycle = scored.freeShares >= sharesPerContract || scored.rolls.some((roll) => roll.strategyKey === "covered_call");
      const cycleSummary = needsCycle ? ledgerOpenCycleSummary(ledger, symbol) : null;
      const cycleBreakEven: CycleBreakEven | null = cycleSummary ? { breakEvenPerShare: cycleSummary.breakEvenPerShare === null ? null : cycleSummary.breakEvenPerShare / priceToCycleScale, unavailableReason: cycleSummary.unavailableReason, sharesAcquired: roundedShares(cycleSummary.sharesAcquired * priceToCycleScale), acquisitionCost: cycleSummary.acquisitionCost } : null;
      const filtered = filterTickerForPluto({ scored, slices: inputs.slices, settings: pluto, todayEasternIso: todayIso, nowMs, botEnabled: true, occupiedContracts, opensBlockedReason, cycleBreakEven, heldShareCallCandidates });
      // Market stress bars every open of the look, as passRunner does after the filters; rolls and closes stay.
      if (opensBlockedBecause !== null) {
        filtered.rejected.push(...filtered.eligible.map((entry) => ({ id: entry.id, reasons: [opensBlockedBecause], codes: ["opens_blocked" as const] })));
        filtered.eligible = [];
      }

      // 2. Close offers, with the close gate read from the look's quotes.
      const closeGateFor = closeGateReader(ledger, context.priceByLegId);
      const lastExpiry = [...scored.heldLegs.map((leg) => leg.expiry), todayIso].reduce((latest, expiry) => (expiry > latest ? expiry : latest));
      const closeInput: CloseOffersForTickerInput = { symbol, heldLegs: scored.heldLegs, rolls: scored.rolls, settings: pluto, stockBid: stockQuoteToday.bid, stockAsk: stockQuoteToday.ask, previousSessionDateIso: context.previousSessionDateIso ?? todayIso, todayIso, spotPrice: scored.spotPrice, forecastVolatility: scored.modelForecast?.annualizedVolatility ?? null, macroEvents: scored.macroEvents, nowMs, openDaysIso: calendar.openDaysBetween(todayIso, addCalendarDays(lastExpiry, 7)), commissionEstimator: flatCommissionEstimator };
      const closeBook: CloseOffersBook = {
        sharePositions: positionsOfSymbol(ledger, symbol)
          .filter((position) => position.status === "open" && position.strategyKey === "unstructured")
          .flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.legType === "stock" && leg.side === "long" && leg.exitAt === null).map((leg) => ({ positionId: position.id, symbol, legId: leg.id, shares: roundedShares(leg.quantity * priceToCycleScale), entryPrice: leg.entryPrice / priceToCycleScale, entryAtIso: leg.entryAt.toISOString() }))),
        openLegsByPositionId: new Map(
          [...new Set(scored.heldLegs.map((leg) => leg.positionId))].map((positionId) => [
            positionId,
            legsOfPosition(ledger, positionId)
              .filter((leg) => leg.exitAt === null)
              .map((leg) => ({ id: leg.id, legType: leg.legType, side: leg.side, quantity: leg.legType === "stock" ? roundedShares(leg.quantity * priceToCycleScale) : Math.round(contractsToday(leg)) })),
          ]),
        ),
        recentUnfilledAutomaticAttemptPositionIds: new Set(),
        activeOrderPositionIds: new Set(),
        openingTradesByLegId: new Map(),
        earnings: scored.heldLegs.length > 0 ? earnings : null,
        sessionsLeftBeforeEarnings: scored.heldLegs.length > 0 ? sessionsLeftBeforeEarnings : null,
        heldShareCallPositionIds: new Set(ledger.shareSources.map((source) => source.positionId)),
      };
      const { offers: closeOffers, heldPositions } = await buildCloseOffersFromBook(closeInput, closeBook, { forPosition: closeGateFor, fromQuotes: (positionId) => closeGateFor(positionId) });
      return { freeCash, priceToCycleScale, toCyclePrice, freeSharesToday, scored, cooldown, cycleBreakEven, filtered, closeGateFor, closeOffers, heldPositions };
    };
    /** The leg's quote at this look, both sides; null when the look has none (a quote left from 10:00 is not traded on). */
    const lookQuoteOfHeldLeg = (leg: Pick<HeldLegScore, "expiry" | "strike" | "right">): { bid: number; ask: number } | null => {
      const quote = lookQuoteOfContract(contractKey({ expiry: leg.expiry, strike: roundedStrike(leg.strike), right: leg.right }));
      return quote && quote.bid !== null && quote.ask !== null && quote.ask > 0 && quote.ask >= quote.bid ? { bid: quote.bid, ask: quote.ask } : null;
    };
    return { lookSymbol, symbol, profile, stockPrice, fitIssue, scoreBook, closeGateReader, lookQuoteOfHeldLeg, scored: null as Awaited<ReturnType<typeof scoreBook>> | null };
  };
  type SymbolLook = ReturnType<typeof prepareSymbol>;
  type ScoredBook = NonNullable<SymbolLook["scored"]>;
  const symbolLooks = context.symbols.map(prepareSymbol);
  const lookOf = (symbol: string): SymbolLook => {
    const found = symbolLooks.find((entry) => entry.symbol === symbol);
    if (!found) throw new Error(`${symbol} ${todayIso}: an offer names a symbol the look does not score.`);
    return found;
  };
  /** A symbol's scoring read at another free cash stays right unless a put's cash flag would differ. */
  const scoringStillHolds = (scoredBook: ScoredBook, freeCash: number) =>
    scoredBook.freeCash === freeCash || scoredBook.scored.candidates.every((candidate) => candidate.strategyKey !== "cash_secured_put" || scoredBook.freeCash < candidate.dollarRisk === freeCash < candidate.dollarRisk);

  let filledActionCount = filledActionsEarlierToday;
  let noActionReason = "";
  /** Offers the gates refused in this look, left out of the next choices when the rule is to choose again. */
  const refusedCandidateIds = new Set<string>();
  /** True when the look goes on after a refused choice. */
  const chooseAgainWithout = (candidateId: string): boolean => {
    if (settings.policy.afterBlockedChoice !== "try_next") return false;
    refusedCandidateIds.add(candidateId);
    return true;
  };
  /** Where a refused open showed the account has no room, and what there is none in: no other open is tried there in this look. */
  const opensStoppedBySymbol = new Map<string, string>();
  let opensStoppedOnBook: string | null = null;
  /** True when the look goes on after a refused open; a refusal for lack of room first ends the opens on its ticker or on the book. */
  const chooseAgainAfterRefusedOpen = (candidateId: string, symbol: string, refusal: OpenRefusalInput): boolean => {
    if (!chooseAgainWithout(candidateId)) return false;
    const { scope, reason } = classifyOpenRefusal(refusal);
    if (scope === "book") opensStoppedOnBook ??= reason;
    else if (scope === "ticker" && !opensStoppedBySymbol.has(symbol)) opensStoppedBySymbol.set(symbol, reason!);
    return true;
  };
  const describeOpensStopped = (): string[] => [
    ...(opensStoppedOnBook === null ? [] : [`no further opens: ${opensStoppedOnBook}`]),
    ...[...opensStoppedBySymbol.entries()].map(([symbol, reason]) => `no further opens on ${symbol}: ${reason}`),
  ];

  /** Opens the rules skipped because their event-close rule would close them at once, with why: the look's declined reasons. */
  const skippedOpens: { id: string; reason: string }[] = [];
  /**
   * Why the rules skip this open (backtestPolicy.ts openClosedAtOnceByEventRule), or null to keep it: the open is applied
   * to a copy of the book, and the position it makes is read as Pluto would show it at the next pass: its F2 figures at
   * the look's quotes and the event close (F3) it would be offered, with the close gate's cycle P&L.
   */
  const eventCloseAtOnceReason = (owner: SymbolLook, open: PlutoOpenCandidate, quantity: number): string | null => {
    const rule = settings.policy.eventClose;
    const candidate = open.candidate;
    // A put sold under its mid cannot be bought back at the ask for a profit at once: no event buyback is offered then.
    if (rule === "never" || candidate.strategyKey !== "covered_call") return null;
    const { scored, priceToCycleScale, toCyclePrice } = owner.scored!;
    const lastExpiry = [...scored.heldLegs.map((leg) => leg.expiry), candidate.expiry, todayIso].reduce((latest, expiry) => (expiry > latest ? expiry : latest));
    const event = heaviestMacroEventBeforeExpiry({ events: scored.macroEvents, nowMs, todayIso, expiryIso: candidate.expiry, openDaysIso: calendar.openDaysBetween(todayIso, addCalendarDays(lastExpiry, 7)) });
    if (!eventCloseDue(withStressMove(event))) return null;
    const bookAfterFill = structuredClone(ledger);
    const marksAfterFill = new Map(context.priceByLegId);
    const opened = openCoveredCall(bookAfterFill, {
      symbol: owner.symbol,
      expiryDate: candidate.expiry,
      strike: toCyclePrice(candidate.strike),
      contracts: quantity,
      callFillPrice: toCyclePrice(computeSaleFillPrice(candidate.bid, candidate.ask, spreadShareCharged)),
      stockFillPrice: toCyclePrice(owner.stockPrice),
      at,
      actionId: null,
      splitFactorToday: owner.lookSymbol.splitFactorToday,
      sharesPerContract: Math.round(sharesPerContract / priceToCycleScale),
      tradedSharesPerLedgerShare: priceToCycleScale,
    });
    const leftoverLegIds = opened.leftoverPositionId === null ? [] : legsOfPosition(bookAfterFill, opened.leftoverPositionId).filter((leg) => leg.exitAt === null).map((leg) => leg.id);
    for (const legId of [opened.stockLegId, ...leftoverLegIds]) marksAfterFill.set(legId, toCyclePrice(owner.stockPrice));
    marksAfterFill.set(opened.callLegId, toCyclePrice((candidate.bid + candidate.ask) / 2));
    const gate = owner.closeGateReader(bookAfterFill, marksAfterFill)(opened.positionId);
    const shares = roundedShares(requireLeg(bookAfterFill, opened.stockLegId).quantity * priceToCycleScale);
    const callLeg: HeldLegScore = {
      legId: opened.callLegId,
      positionId: opened.positionId,
      strategyKey: "covered_call",
      expiry: candidate.expiry,
      strike: candidate.strike,
      right: "C",
      quantity,
      entryPrice: requireLeg(bookAfterFill, opened.callLegId).entryPrice / priceToCycleScale,
      entryAtIso: at.toISOString(),
      dte: candidate.dte,
      delta: candidate.delta,
      bid: candidate.bid,
      ask: candidate.ask,
      mid: (candidate.bid + candidate.ask) / 2,
      surfaceImpliedVolatility: null,
      midImpliedVolatility: null,
      edge: null,
      frictionVolatility: null,
      vega: null,
      holdEdgeDollars: null,
      closeCostDollars: null,
      dollarRisk: null,
      quoteSource: null,
      quotedAt: null,
      flags: [],
      unscoredReason: null,
      model: null,
    };
    const stockBid = owner.stockPrice;
    const stockAsk = owner.stockPrice;
    const entry = heldCoveredCallEntry({ callLeg, shares, entryCredit: callLeg.entryPrice, spot: scored.spotPrice, stockBid, stockAsk, forecastVolatility: scored.modelForecast?.annualizedVolatility ?? null, event, commissionPerContract: flatCommissionEstimator.perContractDollars("buy", quantity), cycleTotal: gate.cycleTotal });
    const offered = evaluateEventCoveredCallClose({ symbol: owner.symbol, positionId: opened.positionId, callLeg, stockLeg: { legId: opened.stockLegId, shares }, entry, stockBid, stockAsk, gateBlockReason: gate.blocked ? gate.reason : null }).offer !== null;
    return openClosedAtOnceByEventRule(rule, entry, offered);
  };

  // LLM mode: the look's rounds, run in order; a fill queues an "order_ended" round over every ticker (agent.ts).
  const llm = context.llm ?? null;
  const pendingRounds: BacktestLlmRound[] = llm ? [...llm.rounds] : [];
  let currentRound: BacktestLlmRound | null = pendingRounds.shift() ?? null;
  const llmCalls = { asked: 0, fromCache: 0 };
  const llmNoActionReasons: string[] = [];
  const queueOrderEnded = (symbol: string) => {
    // One pending every-ticker round already covers any later one; forced rounds run before the look's own round.
    if (pendingRounds.some((round) => round.symbols === null)) return;
    const firstUnforced = pendingRounds.findIndex((round) => !round.force);
    pendingRounds.splice(firstUnforced === -1 ? pendingRounds.length : firstUnforced, 0, { trigger: "order_ended", detail: { symbol, outcome: "filled" }, symbols: null, force: true });
  };
  /** The current round is over: the next one, or none (the look ends). */
  const nextRound = (): boolean => {
    currentRound = pendingRounds.shift() ?? null;
    return currentRound !== null;
  };

  for (let passNumber = 1; ; passNumber++) {
    if (llm && currentRound === null) break;
    if (filledActionCount >= pluto.maxActionsPerSession) {
      noActionReason = `actions cap: ${filledActionCount} of ${pluto.maxActionsPerSession} actions a session`;
      break;
    }
    const freeCashNow = ledgerFreeCash(ledger);
    const scoredLooks: (SymbolLook & { scored: ScoredBook })[] = [];
    if (scoringPool) {
      // Nothing changes the book while the symbols are scored: they are scored at once, and taken in the look's order.
      const toScore = symbolLooks.filter((symbolLook) => symbolLook.scored === null || !scoringStillHolds(symbolLook.scored, freeCashNow));
      const scoring = toScore.map((symbolLook) => symbolLook.scoreBook());
      if (passNumber === 1) context.onFirstScoresSent?.();
      const scoredBooks = await Promise.all(scoring);
      toScore.forEach((symbolLook, index) => {
        symbolLook.scored = scoredBooks[index]!;
        scoredBySymbol.set(symbolLook.symbol, symbolLook.scored.scored);
      });
      scoredLooks.push(...(symbolLooks as (SymbolLook & { scored: ScoredBook })[]));
    } else {
      for (const symbolLook of symbolLooks) {
        if (symbolLook.scored === null || !scoringStillHolds(symbolLook.scored, freeCashNow)) symbolLook.scored = await symbolLook.scoreBook();
        scoredLooks.push(symbolLook as SymbolLook & { scored: ScoredBook });
      }
    }

    const recordAction = (symbol: string, action: Omit<BacktestAction, "actionId" | "tradingDate" | "at" | "lookTimeEt" | "passNumber" | "symbol"> & { actionId?: string }): BacktestAction => {
      const recorded: BacktestAction = { actionId: action.actionId ?? context.nextActionId(), tradingDate: todayIso, at: at.toISOString(), lookTimeEt, passNumber, symbol, ...action };
      actions.push(recorded);
      return recorded;
    };

    /** A close through the close gate, as the close route runs it, then the ledger event. */
    const executeClose = (offer: CloseOffer, chosenBecause: string, decision: Pick<PlutoDecision, "confidence"> = standInConfidence): "filled" | "blocked" => {
      const owner = lookOf(offer.symbol);
      const { scored, closeGateFor, toCyclePrice, priceToCycleScale } = owner.scored!;
      const gate = closeGateFor(offer.positionId);
      const heldLeg = scored.heldLegs.find((leg) => offer.legIds.includes(leg.legId)) ?? null;
      const heldLegLookQuote = offer.kind === "close_shares" || !heldLeg ? null : owner.lookQuoteOfHeldLeg(heldLeg);
      const gateResults: PlutoGateResult[] = [
        ...(offer.automatic
          ? [{ gate: "automatic_close", ok: true, detail: offer.automaticReason ?? "automatic close" }]
          : [
              { gate: "verdict", ok: true, detail: "trade" },
              { gate: "confidence_floor", ok: decision.confidence >= pluto.confidenceFloor, detail: `${decision.confidence.toFixed(2)} vs floor ${pluto.confidenceFloor}` },
              { gate: "offer_fresh", ok: true, detail: "still offered on fresh data" },
              { gate: "working_order", ok: true, detail: "no working Pluto order on the symbol" },
            ]),
        { gate: "close_gate", ok: !gate.blocked, detail: gate.blocked ? (gate.reason ?? "the close gate blocked the close") : `live cycle P&L ${gate.cycleTotal === null ? "unknown" : gate.cycleTotal.toFixed(0)}` },
        ...(offer.kind !== "close_shares" && heldLegLookQuote === null ? [{ gate: "order_build", ok: false, detail: "the option has no two-sided quote at this look to price its buyback" }] : []),
      ];
      const failed = gateResults.filter((entry) => !entry.ok);
      const base = { kind: offer.kind as BacktestActionKind, candidateId: offer.id, description: offer.description, automatic: offer.automatic, chosenBecause, gateResults, contract: offer.contract ?? null, candidateScores: offer.detail, quantity: offer.quantity, limitPrice: offer.limitPrice };
      if (failed.length > 0) {
        recordAction(owner.symbol, { ...base, outcome: "blocked", blockReason: failed.map((entry) => `${entry.gate}: ${entry.detail}`).join(" | "), fillPrice: null, positionIds: [offer.positionId] });
        return "blocked";
      }
      const actionId = context.nextActionId();
      const stockFillToday = owner.stockPrice;
      let fillPrice: number;
      if (offer.kind === "close_shares") {
        const stockLeg = requireLeg(ledger, offer.legIds[0]!);
        sellShares(ledger, { positionId: offer.positionId, shares: stockLeg.quantity, fillPrice: toCyclePrice(stockFillToday), at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
        fillPrice = stockFillToday;
      } else {
        if (!heldLeg || !heldLegLookQuote) throw new Error(`${owner.symbol} ${todayIso} ${lookTimeEt}: the close ${offer.id} was offered without a two-sided quote on its option.`);
        const optionFillToday = optionPurchaseFillPrice(heldLegLookQuote.bid, heldLegLookQuote.ask, spreadShareCharged);
        if (offer.kind === "close_leg") {
          buyBackPut(ledger, { legId: heldLeg.legId, fillPrice: toCyclePrice(optionFillToday), at, actionId });
          fillPrice = optionFillToday;
        } else {
          closeCoveredCall(ledger, { positionId: offer.positionId, callFillPrice: toCyclePrice(optionFillToday), stockFillPrice: toCyclePrice(stockFillToday), at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
          fillPrice = stockFillToday;
        }
      }
      recordAction(owner.symbol, { ...base, actionId, outcome: "filled", blockReason: null, fillPrice, positionIds: [offer.positionId] });
      owner.scored = null;
      filledActionCount += 1;
      return "filled";
    };

    // Automatic closes are code, not a choice: the first one due on any symbol is sent, and the pass starts again.
    const automaticClose = scoredLooks.flatMap((entry) => entry.scored.closeOffers).find((offer) => offer.automatic && !refusedCandidateIds.has(offer.id));
    if (automaticClose) {
      const outcome = executeClose(automaticClose, automaticClose.automaticReason ?? "automatic close");
      if (llm) {
        // Live sends it inside the round and asks the model about the rest; its fill queues an order_ended round.
        if (outcome === "filled") queueOrderEnded(automaticClose.symbol);
        else refusedCandidateIds.add(automaticClose.id);
        continue;
      }
      if (outcome === "blocked" && !chooseAgainWithout(automaticClose.id)) break;
      continue;
    }

    // The call on a symbol's free shares is code too (passRunner.ts sendHeldShareCall): the first symbol with one is sent
    // through the open path below, with its own gates, and the pass starts again. Market stress bars it, as every open.
    const heldShareCallLook = opensBlockedBecause !== null ? undefined : scoredLooks.find((entry) => {
      const chosen = entry.scored.filtered.heldShareCall?.chosen ?? null;
      return chosen !== null && !refusedCandidateIds.has(chosen.id);
    });
    const heldShareCall = heldShareCallLook?.scored.filtered.heldShareCall?.chosen ?? null;
    const heldShareCallChoice: BacktestPolicyChoice | null = heldShareCall
      ? { kind: "open", open: { id: heldShareCall.id, kind: "open_covered_call", symbol: heldShareCallLook!.symbol, candidate: heldShareCall.candidate }, chosenBecause: `code sells calls on held shares: the highest premium yield, ${formatPercent(heldShareCall.premiumYield)} a year; if called away the cycle ends ${formatSignedDollars(heldShareCall.profitIfCalledAway, 0)}` }
      : null;

    // 3. LLM mode: the model decides, as live, and a pass is one round.
    let modelDecision: PlutoDecision | null = null;
    let modelCallSequence: number | null = null;
    let llmChoice: BacktestPolicyChoice | null = null;
    if (llm && !heldShareCallChoice) {
      const round = currentRound!;
      const llmTickers: BacktestLlmTicker[] = scoredLooks.map((entry) => ({
        symbol: entry.symbol,
        scored: entry.scored.scored,
        filtered: entry.scored.filtered,
        closeOffers: entry.scored.closeOffers.filter((offer) => !offer.automatic && !refusedCandidateIds.has(offer.id)),
        heldPositions: entry.scored.heldPositions,
        opensBarred: opensBlockedBecause !== null,
        moveContext: () => {
          const history = entry.lookSymbol.bars.rowsBefore(todayIso, moveContextBarCount);
          const impliedVolatilities = history.flatMap((row) => (row.impliedVolatility === null ? [] : [row.impliedVolatility]));
          return computeMoveContext({ bars: toOhlcvBars(history), forecastVolatility: entry.scored.scored.modelForecast?.annualizedVolatility ?? null, dayChangePct: entry.scored.scored.dayChangePercent, ivRank: ivRankFromHistory(impliedVolatilities) });
        },
      }));
      const netLiquidationValue = ledgerNetLiquidationValue(ledger, context.priceByLegId);
      const openPositions = ledger.positions.filter((position) => position.status === "open");
      const openPositionsBySymbol: Record<string, string[]> = {};
      for (const position of openPositions) (openPositionsBySymbol[position.symbol] ??= []).push(position.strategyKey);
      const lastExpiry = llmTickers.flatMap((ticker) => [...ticker.scored.heldLegs.map((leg) => leg.expiry), ...ticker.scored.candidates.map((candidate) => candidate.expiry), ...ticker.scored.rolls.map((roll) => roll.replacement.expiry)]).reduce((latest, expiry) => (expiry > latest ? expiry : latest), todayIso);
      const asked = await decideWithLlm({
        session: llm.session,
        round,
        settings: pluto,
        spreadCostSharePct: trading.spreadCostChargedPct,
        nowMs,
        todayIso,
        lookTimeEt,
        windowEndEt: llm.windowEndEt,
        spyDayChangePct: llm.spyDayChangePercent,
        tickers: llmTickers,
        account: {
          netLiquidationValue,
          freeCash: ledgerFreeCash(ledger),
          plutoBudgetPct: pluto.capitalBudgetPct,
          plutoBudgetUsedPct: netLiquidationValue > 0 ? (ledgerCommittedDollars(ledger) / netLiquidationValue) * 100 : 0,
          // Simulated orders fill at once: nothing is ever working.
          plutoBudgetInFlightPct: 0,
          managedPositions: openPositions.length,
          maxOpenPositions: pluto.maxOpenPositions,
          actionsToday: filledActionCount,
          maxActionsPerSession: pluto.maxActionsPerSession,
          openPositionsBySymbol,
        },
        // Every simulated position is Pluto's.
        plutoOpenedPositionIds: new Set(ledger.positions.map((position) => position.id)),
        openDaysIso: calendar.openDaysBetween(todayIso, addCalendarDays(lastExpiry, 7)),
      });
      const roundLabel = round.trigger.replaceAll("_", " ");
      if (!asked.asked) {
        llmNoActionReasons.push(`${roundLabel}: not asked, ${asked.reason}`);
        if (!nextRound()) break;
        continue;
      }
      llmCalls.asked += 1;
      if (asked.cacheHit) llmCalls.fromCache += 1;
      if (!asked.decision) {
        llmNoActionReasons.push(`${roundLabel}: ${asked.outcome === "call_failed" ? `the model call failed (${asked.error})` : `the model's answer could not be read (${asked.error})`}`);
        if (!nextRound()) break;
        continue;
      }
      if (asked.decision.decision !== "trade") {
        llmNoActionReasons.push(`${roundLabel}: the model chose ${asked.decision.decision.replaceAll("_", " ")}${asked.decision.reasons[0] ? `: ${asked.decision.reasons[0]}` : ""}`);
        if (!nextRound()) break;
        continue;
      }
      const offered = findOfferedChoice(asked.decision.candidateId!, llmTickers);
      if (!offered) {
        llmNoActionReasons.push(`${roundLabel}: the chosen candidate ${asked.decision.candidateId} is not among the offers`);
        if (!nextRound()) break;
        continue;
      }
      modelDecision = asked.decision;
      modelCallSequence = asked.sequence;
      const chosenBecause = asked.decision.reasons[0] ?? "the model chose it";
      llmChoice = offered.kind === "close" ? { kind: "close", offer: offered.offer, chosenBecause } : offered.kind === "roll" ? { kind: "roll", roll: offered.roll, chosenBecause } : { kind: "open", open: offered.open, chosenBecause };
      // Never trade a ticker the model flagged in the same answer, nor anything when it flagged the whole message (passRunner).
      const chosenSymbol = offered.kind === "close" ? offered.offer.symbol : offered.kind === "roll" ? offered.roll.symbol : offered.open.symbol;
      const flaggedWholeMessage = modelDecision.systemConcerns.some((concern) => concern.symbol === null);
      if (flaggedWholeMessage || flaggedSymbols(modelDecision).has(chosenSymbol)) {
        const failedGate = flaggedWholeMessage ? { gate: "flagged_message", ok: false, detail: "the model flagged the whole message's data in the same answer" } : { gate: "flagged_ticker", ok: false, detail: `the model flagged ${chosenSymbol}'s data in the same answer` };
        const kind: BacktestActionKind = offered.kind === "close" ? (offered.offer.kind as BacktestActionKind) : offered.kind === "roll" ? "roll" : offered.open.kind;
        recordAction(chosenSymbol, { kind, candidateId: modelDecision.candidateId!, description: `${chosenSymbol} ${modelDecision.candidateId}`, automatic: false, chosenBecause, outcome: "blocked", blockReason: `${failedGate.gate}: ${failedGate.detail}`, gateResults: [failedGate], contract: null, candidateScores: null, quantity: null, limitPrice: null, fillPrice: null, positionIds: [] });
        llm.session.recordTradeOutcome(modelCallSequence, "blocked", `${failedGate.gate}: ${failedGate.detail}`);
        if (!nextRound()) break;
        continue;
      }
    }
    /** LLM mode: the chosen action ended (its outcome goes to recent_decisions); a fill queues an order_ended round. True when the look goes on. */
    const afterModelAction = (symbol: string, outcome: "filled" | "blocked"): boolean => {
      const blockReason = outcome === "blocked" ? (actions.at(-1)?.blockReason ?? null) : null;
      llm!.session.recordTradeOutcome(modelCallSequence!, outcome, blockReason);
      if (outcome === "filled") queueOrderEnded(symbol);
      return nextRound();
    };

    // 3. The decision rules stand in for the model, across every symbol.
    const decided = heldShareCallChoice ? { choice: heldShareCallChoice, declined: [] as { id: string; reason: string }[] } : llm ? { choice: llmChoice, declined: [] as { id: string; reason: string }[] } : chooseBacktestAction(
      settings.policy,
      {
        closeOffers: scoredLooks.flatMap((entry) => entry.scored.closeOffers),
        heldPositions: scoredLooks.flatMap((entry) => entry.scored.heldPositions),
        eligibleRolls: scoredLooks.flatMap((entry) => entry.scored.filtered.eligibleRolls),
        eligibleOpens: opensStoppedOnBook !== null ? [] : scoredLooks.flatMap((entry) => (opensStoppedBySymbol.has(entry.symbol) ? [] : entry.scored.filtered.eligible)),
        coolingDownSymbols: new Set(scoredLooks.filter((entry) => !entry.scored.cooldown.cooledDown).map((entry) => entry.symbol)),
        opensBarredBySymbol: new Map(
          scoredLooks.flatMap((entry) => {
            const why = opensBlockedBecause !== null ? "market stress bars new opens" : opensStoppedOnBook !== null ? `no further open is tried at this look (${opensStoppedOnBook})` : opensStoppedBySymbol.has(entry.symbol) ? `no further open is tried on the ticker at this look (${opensStoppedBySymbol.get(entry.symbol)})` : null;
            return why === null ? [] : [[entry.symbol, why] as const];
          }),
        ),
      },
      refusedCandidateIds,
    );
    if (!decided.choice) {
      const declinedBySymbol = (symbol: string) => [...skippedOpens, ...decided.declined].filter((entry) => entry.id.startsWith(`${symbol}:`)).map((entry) => entry.reason);
      noActionReason = scoredLooks
        .map((entry) => {
          const fragments = [describeNoEligibleOpen(entry.scored.scored, entry.scored.filtered, entry.fitIssue)];
          if (entry.scored.filtered.eligibleRolls.length > 0) fragments.push(`${entry.scored.filtered.eligibleRolls.length} eligible roll(s), none taken by the roll rule`);
          fragments.push(...declinedBySymbol(entry.symbol));
          return severalSymbols ? `${entry.symbol}: ${fragments.join("; ")}` : fragments.join("; ");
        })
        .join(" | ");
      break;
    }
    if (decided.choice.kind === "close") {
      const outcome = executeClose(decided.choice.offer, decided.choice.chosenBecause, modelDecision ?? standInConfidence);
      if (llm) {
        if (!afterModelAction(decided.choice.offer.symbol, outcome)) break;
        continue;
      }
      if (outcome === "blocked" && !chooseAgainWithout(decided.choice.offer.id)) break;
      continue;
    }

    // 4. An open or a roll: the post-model gates on the shared book, then the order gate's limits.
    const chosenOpen: PlutoOpenCandidate | null = decided.choice.kind === "open" ? decided.choice.open : null;
    const chosenRoll: PlutoRollCandidate | null = decided.choice.kind === "roll" ? decided.choice.roll : null;
    const owner = lookOf(chosenOpen ? chosenOpen.symbol : chosenRoll!.symbol);
    const { symbol, profile, stockPrice } = owner;
    const { priceToCycleScale, toCyclePrice, freeSharesToday, scored, cycleBreakEven, filtered } = owner.scored!;
    const markNewLegs = (legIds: readonly (string | null)[], optionMidToday: number | null) => {
      for (const legId of legIds) {
        if (legId === null) continue;
        const leg = requireLeg(ledger, legId);
        if (leg.legType === "stock") context.priceByLegId.set(legId, toCyclePrice(stockPrice));
        else if (optionMidToday !== null) context.priceByLegId.set(legId, toCyclePrice(optionMidToday));
      }
    };
    const candidate = chosenOpen ? chosenOpen.candidate : chosenRoll!.roll.replacement;
    const heldLegToRoll: HeldLegScore | null = chosenRoll ? (scored.heldLegs.find((leg) => leg.legId === chosenRoll.roll.legId) ?? null) : null;
    const candidateId = chosenOpen ? chosenOpen.id : chosenRoll!.id;
    const kind: BacktestActionKind = chosenOpen ? chosenOpen.kind : "roll";
    const right = rightOf(candidate.strategyKey);
    // The model's own decision in LLM mode (its confidence meets the floor), the rules' always-confident one otherwise.
    const decision: PlutoDecision = modelDecision ?? { decision: "trade", actionKind: kind, candidateId, confidence: 1, reasons: [decided.choice.chosenBecause], risksAcknowledged: [], systemConcerns: [] };
    const book = { ...ledgerPostModelBook(ledger, { symbol, sector: profile.sector, contract: { expiry: candidate.expiry, strike: toCyclePrice(candidate.strike) }, priceByLegId: context.priceByLegId, sectorBySymbol, spotPrice: stockPrice, todayIso, nowMs }), freeShares: freeSharesToday };
    const stress = stressCapInputFor(scored);
    const automaticHeldShareCall = heldShareCallChoice !== null;
    const gates = automaticHeldShareCall
      ? runHeldShareCallGates({ candidate, settings: pluto, book: { freeShares: freeSharesToday, workingOrderOnSymbol: false, lastFilledActionAt: ledgerLastFilledActionAt(ledger, symbol), nowMs, sameContractConflict: null }, cycleBreakEven, requireLiveQuote: false })
      : runPostModelGates({
          decision,
          candidate: chosenOpen ? candidate : null,
          roll: chosenRoll ? chosenRoll.roll : null,
          freshRejectionReasons: [],
          marginAtDecision: chosenOpen ? candidate.model!.edgeMargin : chosenRoll!.roll.model!.edgeMargin,
          settings: pluto,
          sector: profile.sector,
          book,
          stress,
          kellyFraction: settings.kellyFraction,
        });
    const contract = { strategyKey: candidate.strategyKey, expiry: candidate.expiry, strike: candidate.strike, right, ...(heldLegToRoll ? { fromStrike: heldLegToRoll.strike, fromExpiry: heldLegToRoll.expiry } : {}) };
    const contractLabel = describeOptionContract({ strike: candidate.strike, right, expiry: candidate.expiry, dte: candidate.dte });
    const describeOrder = (quantity: number | null, price: number | null) =>
      heldLegToRoll
        ? `${symbol} Roll ${describeOptionContract({ strike: heldLegToRoll.strike, right: heldLegToRoll.right, expiry: heldLegToRoll.expiry, dte: null })} → ${contractLabel}${quantity === null ? "" : describeOrderSize(quantity, price)}`
        : `${symbol} Sell ${contractLabel}${quantity === null ? "" : describeOrderSize(quantity, price)}`;
    const candidateScores = chosenRoll
      ? { netCreditPerShare: chosenRoll.roll.netCreditPerShare, deltaChange: chosenRoll.roll.deltaChange, dollarRiskChange: chosenRoll.roll.dollarRiskChange, flags: chosenRoll.roll.flags, model: chosenRoll.roll.model, replacement: summarizeCandidate(candidate), heldLeg: heldLegToRoll ? { expiry: heldLegToRoll.expiry, strike: heldLegToRoll.strike, right: heldLegToRoll.right, quantity: heldLegToRoll.quantity, entryPrice: heldLegToRoll.entryPrice, bid: heldLegToRoll.bid, ask: heldLegToRoll.ask, dte: heldLegToRoll.dte, delta: heldLegToRoll.delta } : null }
      : { ...summarizeCandidate(candidate), ...(heldShareCall ? { heldShares: { contracts: heldShareCall.contracts, premiumYield: heldShareCall.premiumYield, breakEvenAfter: heldShareCall.breakEvenAfter, profitIfCalledAway: heldShareCall.profitIfCalledAway } } : {}) };
    const base = { kind, candidateId, automatic: automaticHeldShareCall, chosenBecause: decided.choice.chosenBecause, contract, candidateScores };
    const gateResults: PlutoGateResult[] = [...(automaticHeldShareCall ? [{ gate: heldShareCallGate, ok: true, detail: decided.choice.chosenBecause }] : []), ...gates.gates];
    const blockWith = (quantity: number | null, limitPrice: number | null): "blocked" => {
      recordAction(symbol, { ...base, description: describeOrder(quantity, limitPrice), outcome: "blocked", blockReason: gateResults.filter((entry) => !entry.ok).map((entry) => `${entry.gate}: ${entry.detail}`).join(" | "), gateResults, quantity, limitPrice, fillPrice: null, positionIds: chosenRoll ? [chosenRoll.roll.positionId] : [] });
      return "blocked";
    };
    /** Whether the look goes on after this refusal: a refused roll is only left out; a refused open may end the opens on its ticker or on the book. In LLM mode the round ends (one decision a round). */
    const chooseAgainAfterRefusal = (orderLimits: ReturnType<typeof evaluateOrderLimitFigures> | null): boolean => {
      // A refused call on held shares is code's, like an automatic close: left out for the rest of the look.
      if (automaticHeldShareCall) {
        if (!llm) return chooseAgainWithout(candidateId);
        refusedCandidateIds.add(candidateId);
        return true;
      }
      if (llm) return afterModelAction(symbol, "blocked");
      if (!chosenOpen) return chooseAgainWithout(candidateId);
      // What one more contract commits, as the sizing gate counts it.
      const limitPrice = midLimitPrice(candidate.bid, candidate.ask);
      const dollarsPerContract = ((candidate.strategyKey === "cash_secured_put" ? candidate.strike : stockPrice) - limitPrice) * sharesPerContract;
      return chooseAgainAfterRefusedOpen(candidateId, symbol, {
        failedGates: gateResults.filter((entry) => !entry.ok),
        sizing: { room: computeSizingRoom(pluto, book, profile.sector !== null), dollarsPerContract },
        orderLimitBreaches: orderLimits === null ? null : orderLimitBreachesOf(orderLimits),
      });
    };
    if (!gates.ok || !gates.plan) {
      blockWith(null, null);
      if (!chooseAgainAfterRefusal(null)) break;
      continue;
    }
    const plan = gates.plan;
    const heldLegToRollLookQuote = heldLegToRoll ? owner.lookQuoteOfHeldLeg(heldLegToRoll) : null;
    const rollCloseLimitPrice = heldLegToRollLookQuote ? Math.round(((heldLegToRollLookQuote.bid + heldLegToRollLookQuote.ask) / 2) * 100) / 100 : null;
    if (chosenRoll && rollCloseLimitPrice === null) {
      gateResults.push({ gate: "order_build", ok: false, detail: "the held leg has no two-sided quote at this look to price the buyback" });
      blockWith(plan.quantity, plan.limitPrice);
      if (!chooseAgainAfterRefusal(null)) break;
      continue;
    }
    const orderNotional = computeOrderNotional({ strategyKey: candidate.strategyKey, strike: candidate.strike, quantity: plan.quantity, premium: plan.limitPrice, ...(chosenRoll ? { rollFromStrike: heldLegToRoll!.strike, rollFromPremium: rollCloseLimitPrice! } : {}) }, stockPrice, freeSharesToday);
    const limits = evaluateOrderLimitFigures({ symbol, orderNotional, totalPortfolioValue: book.netLiquidationValue, totalCashValue: ledger.cash, cashLockedInCsps: ledgerCashLockedInCashSecuredPuts(ledger), existingTickerExposure: book.existingTickerExposure, inFlight: { totalNotional: 0, tickerNotional: 0 }, settings: trading });
    gateResults.push({ gate: "order_limits", ok: !limits.blocked, detail: limits.blocked ? limits.reasons.join(" ") : `order notional $${orderNotional.toFixed(0)} within the order gate's limits` });
    if (limits.blocked) {
      blockWith(plan.quantity, plan.limitPrice);
      if (!chooseAgainAfterRefusal(limits)) break;
      continue;
    }

    // Rules mode (Marcelo 2026-10-12): no open that the session's own event-close rule would close at once, judged on
    // the position as Pluto would show it right after the fill (a copy of the book takes the open).
    if (!llm && chosenOpen && !automaticHeldShareCall) {
      const skipReason = eventCloseAtOnceReason(owner, chosenOpen, plan.quantity);
      if (skipReason !== null) {
        refusedCandidateIds.add(candidateId);
        skippedOpens.push({ id: candidateId, reason: `skipped ${describeOrder(plan.quantity, plan.limitPrice)}: ${skipReason}` });
        continue;
      }
    }

    // 5. The fill and the ledger event.
    const actionId = context.nextActionId();
    const fillPrice = computeSaleFillPrice(candidate.bid, candidate.ask, spreadShareCharged);
    const candidateMid = (candidate.bid + candidate.ask) / 2;
    // A whole number whenever option orders are allowed on the ticker (optionContractsRepresentable).
    const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
    const splitFactorToday = owner.lookSymbol.splitFactorToday;
    let newLegId: string;
    let positionIds: string[];
    let sharesNote = "";
    if (chosenRoll) {
      const buybackFill = optionPurchaseFillPrice(heldLegToRollLookQuote!.bid, heldLegToRollLookQuote!.ask, spreadShareCharged);
      const rolled = rollLeg(ledger, { legId: chosenRoll.roll.legId, newExpiryDate: candidate.expiry, newStrike: toCyclePrice(candidate.strike), buybackFillPrice: toCyclePrice(buybackFill), newFillPrice: toCyclePrice(fillPrice), at, actionId });
      markNewLegs([rolled.legId, rolled.stockLegId], candidateMid);
      newLegId = rolled.legId;
      positionIds = [rolled.closedPositionId, rolled.positionId];
      sharesNote = `, buying back at ${buybackFill.toFixed(2)}`;
    } else if (candidate.strategyKey === "cash_secured_put") {
      const opened = openCashSecuredPut(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts: plan.quantity, fillPrice: toCyclePrice(fillPrice), at, actionId, splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale });
      markNewLegs([opened.legId], candidateMid);
      newLegId = opened.legId;
      positionIds = [opened.positionId];
    } else {
      const stockFillToday = stockPrice;
      const opened = openCoveredCall(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts: plan.quantity, callFillPrice: toCyclePrice(fillPrice), stockFillPrice: toCyclePrice(stockFillToday), at, actionId, splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale, tradedSharesPerLedgerShare: priceToCycleScale });
      const leftoverLegIds = opened.leftoverPositionId === null ? [] : legsOfPosition(ledger, opened.leftoverPositionId).filter((leg) => leg.exitAt === null).map((leg) => leg.id);
      markNewLegs([opened.callLegId, opened.stockLegId, ...leftoverLegIds], candidateMid);
      newLegId = opened.callLegId;
      positionIds = [opened.positionId, ...(opened.leftoverPositionId === null ? [] : [opened.leftoverPositionId])];
      const sharesBoughtToday = roundedShares(opened.sharesBought * priceToCycleScale);
      const sharesHeldToday = roundedShares(opened.sharesFromHeld * priceToCycleScale);
      sharesNote = [sharesHeldToday > 0 ? ` on ${sharesHeldToday} held shares` : "", sharesBoughtToday > 0 ? ` with ${sharesBoughtToday} shares bought @ ${stockFillToday.toFixed(2)}` : ""].join("");
    }
    const model = candidate.model!;
    const kellyCap = computeKellyCap(pluto, candidate, book.netLiquidationValue, settings.kellyFraction);
    const stressCap = computeStressCap(pluto, stress, candidate, stockPrice, book.netLiquidationValue);
    optionSales.push({
      legId: newLegId,
      actionId,
      symbol,
      openedOn: todayIso,
      strategyKey: candidate.strategyKey,
      expiry: candidate.expiry,
      strike: candidate.strike,
      optionRight: right,
      contracts: plan.quantity,
      bid: candidate.bid,
      ask: candidate.ask,
      fillPrice,
      commissionDollars: (candidate.commissionPerContractDollars ?? commissionPerContractDollars) * plan.quantity,
      spotAtOpen: stockPrice,
      sharePriceAtOpen: candidate.strategyKey === "covered_call" ? stockPrice : null,
      // EXP $ as Positions shows the new position: what it holds at cost (the strike for a put, the shares' cost in the
      // book for a call) less the premium after its commission.
      exposureDollars: ledgerCapitalAtRisk(ledger, requireLeg(ledger, newLegId).positionId) ?? ((candidate.strategyKey === "covered_call" ? stockPrice : candidate.strike) - fillPrice) * sharesPerContract * plan.quantity,
      dte: candidate.dte,
      delta: candidate.delta,
      grade: model.grade,
      edgeMargin: model.edgeMargin,
      expectedPnlDollars: model.expectedPnlDollars * plan.quantity,
      calibratedExpectedPnlDollars: model.calibratedExpectedPnlDollars * plan.quantity,
      edgeYield: model.expectedAnnualizedReturn,
      histYield: model.calibratedAnnualizedReturn,
      kellyContracts: Number.isFinite(kellyCap.contracts) ? kellyCap.contracts : null,
      stressContracts: Number.isFinite(stressCap.contracts) ? stressCap.contracts : null,
      priceToCycleScale,
    });
    const choiceNote = heldShareCall
      ? `premium yield ${formatPercent(heldShareCall.premiumYield)}, grade ${model.grade}; ${filtered.heldShareCall!.ranked.length} call(s) on the held shares passed`
      : `grade ${model.grade}, Edge Yield ${formatPercent(model.expectedAnnualizedReturn)}, Hist Yield ${formatPercent(model.calibratedAnnualizedReturn)}; ${filtered.eligible.length} of ${scored.candidates.length} eligible`;
    recordAction(symbol, { ...base, actionId, description: `${describeOrder(plan.quantity, fillPrice)}${sharesNote} (${choiceNote})`, outcome: "filled", blockReason: null, gateResults, quantity: plan.quantity, limitPrice: plan.limitPrice, fillPrice, positionIds });
    owner.scored = null;
    filledActionCount += 1;
    // Code's own order does not end the model's round; its fill queues an order_ended round, as an automatic close's.
    if (automaticHeldShareCall) {
      if (llm) queueOrderEnded(symbol);
    } else if (llm && !afterModelAction(symbol, "filled")) break;
  }

  // LLM mode: what each round that took no action ended on.
  if (llm && llmNoActionReasons.length > 0 && noActionReason === "") noActionReason = llmNoActionReasons.join(" | ");
  // An open the rules skipped is named after the look's actions; without any, it is among the declined reasons.
  const summaryOfActions = [summarizeLook(actions, noActionReason), ...(actions.length > 0 ? skippedOpens.map((entry) => entry.reason) : [])].join(" · ");
  const opensStopped = describeOpensStopped();
  return { actions, optionSales, summary: [summaryOfActions, ...opensStopped].join(" · "), summaryOfActions, opensStopped, fitIssueBySymbol, scoredBySymbol, llmCalls };
}

/**
 * The look in one line: every fill, the first refused choice in full, and the further refused ones counted per symbol
 * with the gates that refused them (each is in the session's actions); or why nothing was done.
 */
function summarizeLook(actions: readonly BacktestAction[], noActionReason: string): string {
  if (actions.length === 0) return `No action: ${noActionReason}`;
  const verbOf = (action: BacktestAction) => (action.kind === "roll" ? "Rolled" : action.kind.startsWith("open_") ? "Opened" : "Closed");
  const blockedActions = actions.filter((action) => action.outcome === "blocked");
  const lines = actions.flatMap((action) => (action.outcome === "filled" ? [`${verbOf(action)} ${action.description}${action.automatic ? " (automatic)" : ""}`] : action === blockedActions[0] ? [`Blocked ${action.description}: ${action.blockReason}`] : []));
  const furtherRefusals = blockedActions.slice(1);
  if (furtherRefusals.length > 0) {
    const bySymbol = new Map<string, { count: number; gates: Set<string> }>();
    for (const action of furtherRefusals) {
      const entry = bySymbol.get(action.symbol) ?? { count: 0, gates: new Set<string>() };
      entry.count += 1;
      for (const gate of action.gateResults) if (!gate.ok) entry.gates.add(gate.gate);
      bySymbol.set(action.symbol, entry);
    }
    lines.push(`${furtherRefusals.length} more refused choice(s): ${[...bySymbol.entries()].map(([symbol, entry]) => `${symbol} ${entry.count} (${[...entry.gates].join(", ")})`).join(", ")}`);
  }
  return lines.join(" · ");
}
