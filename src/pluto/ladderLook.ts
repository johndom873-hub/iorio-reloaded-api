import { defaultBacktestBaselineSettings, type BacktestBaselineSettings } from "../backtest/backtestTypes.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { makeBaselineSelector, planBaselineSales, type BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { describePriceAdjustment } from "../ibkr/dailyBarSplitCheck.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import { yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { splitSuggestedByPrice } from "../lib/stockSplits.js";
import type { OptionQuoteBandQuote } from "./optionQuoteBandQuotes.js";
import type { LadderClock } from "./optionQuoteBandPlan.js";
import { nextLadderCycleMemory, type LadderCycleMemory } from "./ladderCycleMemory.js";
import { createLadderLookBook, type LadderLookSnapshot, type PlannedLadderSale } from "./ladderLookBook.js";
import type { LadderBaselineSettings } from "./ladderSettings.js";

// One CC + Put Ladder look at one ticker (Marcelo 2026-10-14/15): the backtest's sale steps (baselineSaleSteps.ts) on the
// ticker's live book, quotes and cycle memory. Pure: the pass reads everything first (ladderLookLoader.ts) and sends the
// planned sales after (ladderOrders.ts).
//
//   1. guard   a price about a split's factor away from the previous close, with no split recorded, stops the ticker
//              (a split IBKR's history does not show yet, or a fall that size: either way a person looks)
//   2. memory  the cycle's start, starting account value and shock (ladderCycleMemory.ts)
//   3. sales   the shared steps: calls on free shares, the entry (a Cash-Secured Put or a Covered Call, whichever ranks
//              higher), ladder Puts; quotes are the option quote band's from the market quote loop's latest cycle on the ticker,
//              priced at the mid (the ladder orders at the mid). A band quote older than Pluto's maxQuoteAgeMinutes is
//              left out; when the latest cycle has none fresher, nothing is planned on the ticker.

export interface LadderLookInput {
  symbol: string;
  now: Date;
  clock: LadderClock;
  stockPrice: number;
  /** The previous session's close (the split guard); null when unknown. */
  previousClose: number | null;
  memory: LadderCycleMemory | null;
  /** The shock a cycle starting today gets, percent: the ticker's override, else the recommended one. */
  shockPctIfStartingToday: number;
  baseline: LadderBaselineSettings;
  book: LadderLookSnapshot;
  /** The ticker's band quotes today (latest per contract). */
  bandQuotes: readonly OptionQuoteBandQuote[];
  /** Pluto's 10:00 forwards by expiry. */
  forwardAnchors: ReadonlyMap<string, BaselineForwardAnchor>;
  /** The previous session's volume per contractKey; null when it was not captured (nothing can be sold). */
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  /** The trading sessions from today's to an expiry's (liveTradingSessions.ts): what the premium yields are annualized over. */
  tradingSessionsThrough(expiry: string): number;
  /** Pluto's maxQuoteAgeMinutes: an older band quote is left out. */
  maxQuoteAgeMinutes: number;
}

/** Why a looked-at ticker can sell nothing this look (Telegram once a day per reason: ladderNotices.ts). */
export type LadderCannotTradeReason = "no_previous_session_volume" | "stale_band_quotes";

export interface LadderLookResult {
  /** Why the ticker is stopped this look (nothing planned), or null. */
  stoppedBecause: string | null;
  /** The memory to save; null when the look stopped before reading it. */
  memory: LadderCycleMemory | null;
  planned: PlannedLadderSale[];
  notes: string[];
  /** Why nothing could be sold on the ticker this look, when it was for want of data; null otherwise. */
  cannotTradeBecause: LadderCannotTradeReason | null;
}

/**
 * The band quotes of the loop's latest cycle on the ticker, as the sale steps take quotes (an older quote may have left
 * the band), without those quoted more than maxQuoteAgeMinutes before `now`. `stale`: the latest cycle had quotes, none of them fresh.
 */
export function latestCycleQuotes(bandQuotes: readonly OptionQuoteBandQuote[], now: Date, maxQuoteAgeMinutes: number): { quotes: SymbolFileQuote[]; stale: boolean } {
  const latestCycle = bandQuotes.reduce((latest, quote) => Math.max(latest, quote.cycleNumber), -1);
  const latest = bandQuotes.filter((quote) => quote.cycleNumber === latestCycle && quote.errorCode === null);
  const fresh = latest.filter((quote) => now.getTime() - quote.quotedAt.getTime() <= maxQuoteAgeMinutes * 60_000);
  return { quotes: fresh.map((quote) => ({ expiry: quote.expiry, strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask, bidSize: null, askSize: null })), stale: latest.length > 0 && fresh.length === 0 };
}

export function runLadderLook(input: LadderLookInput): LadderLookResult {
  const suggestedSplit = input.previousClose === null ? null : splitSuggestedByPrice(input.stockPrice, input.previousClose);
  if (suggestedSplit !== null) {
    return { stoppedBecause: `${input.symbol} trades at ${input.stockPrice.toFixed(2)} against a previous close of ${input.previousClose!.toFixed(2)}, about a ${describePriceAdjustment(suggestedSplit)} with none recorded: the ladder stops on it until a person looks`, memory: null, planned: [], notes: [], cannotTradeBecause: null };
  }
  const book = createLadderLookBook(input.book);
  const sharesHeld = book.book.heldSharesToday() > 0;
  const cycleOpen = sharesHeld || input.book.positions.some((position) => position.status === "open" && position.legs.some((leg) => leg.exitAt === null));
  const memory = nextLadderCycleMemory(input.memory, { cycleOpen, sharesHeld, accountValue: input.book.accountValue, todayIso: input.clock.todayIso, shockPctIfStartingToday: input.shockPctIfStartingToday });
  const baseline: BacktestBaselineSettings = { ...defaultBacktestBaselineSettings, ...input.baseline };
  const { quotes, stale } = latestCycleQuotes(input.bandQuotes, input.now, input.maxQuoteAgeMinutes);
  if (stale) return { stoppedBecause: null, memory, planned: [], notes: [`${input.symbol}: the band's latest quotes are older than ${input.maxQuoteAgeMinutes} minutes, so nothing is planned`], cannotTradeBecause: "stale_band_quotes" };
  const forwardAnchors = new Map(input.forwardAnchors);
  const yearsToTodaysClose = yearsToSessionClose(input.now, input.clock.closeMinutesEt);
  const select = makeBaselineSelector({
    quotes,
    forwardAnchors,
    commissions: input.book.commissions,
    todayIso: input.clock.todayIso,
    yearsToTodaysClose,
    stockPrice: input.stockPrice,
    riskFreeRate: input.clock.riskFreeRate,
    previousSessionVolumeByContract: input.previousSessionVolumeByContract ?? new Map(),
    baseline,
    spreadShareCharged: 0,
    isHeld: book.book.isHeld,
    earningsDatesIso: undefined,
    model: null,
    tradingSessionsThrough: input.tradingSessionsThrough,
  });
  const notes: string[] = [];
  if (input.previousSessionVolumeByContract === null) notes.push(`${input.symbol}: no previous-session option volume was captured, so nothing can be sold (the 20% rule)`);
  const ladderState = { startedOn: memory.startedOn, accountValueAtStart: memory.accountValueAtStart, shock: memory.shock ?? 0 };
  planBaselineSales({ symbol: input.symbol, commissions: input.book.commissions, todayIso: input.clock.todayIso, atMs: input.now.getTime(), stockPrice: input.stockPrice, priceToCycleScale: 1, baseline, select, book: book.book, ladderState, notes });
  // A same-day expiry is sold only while it still has time to the close.
  const planned = book.planned.filter((sale) => daysToExpiry(sale.expiry, input.clock.todayIso) > 0 || yearsToTodaysClose > 0);
  return { stoppedBecause: null, memory, planned, notes, cannotTradeBecause: input.previousSessionVolumeByContract === null ? "no_previous_session_volume" : null };
}
