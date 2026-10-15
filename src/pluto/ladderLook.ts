import { defaultBacktestBaselineSettings, type BacktestBaselineSettings } from "../backtest/backtestTypes.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { makeBaselineSelector, planBaselineSales, type BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { describePriceAdjustment } from "../ibkr/dailyBarSplitCheck.js";
import { daysToExpiry } from "../lib/optionContractLabel.js";
import { yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { splitSuggestedByPrice } from "../lib/stockSplits.js";
import type { LadderBandQuote } from "./ladderBandQuotes.js";
import type { LadderClock } from "./ladderBandPlan.js";
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
//   3. sales   the shared steps: calls on free shares, Covered Call entries, ladder Puts; quotes are the ladder band's
//              from the Day Signals loop's latest cycle on the ticker, priced at the mid (the ladder orders at the mid)

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
  bandQuotes: readonly LadderBandQuote[];
  /** Pluto's 10:00 forwards by expiry. */
  forwardAnchors: ReadonlyMap<string, BaselineForwardAnchor>;
  /** The previous session's volume per contractKey; null when it was not captured (nothing can be sold). */
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
}

export interface LadderLookResult {
  /** Why the ticker is stopped this look (nothing planned), or null. */
  stoppedBecause: string | null;
  /** The memory to save; null when the look stopped before reading it. */
  memory: LadderCycleMemory | null;
  planned: PlannedLadderSale[];
  notes: string[];
}

/** The band quotes of the loop's latest cycle on the ticker, as the sale steps take quotes (an older quote may have left the band). */
export function latestCycleQuotes(bandQuotes: readonly LadderBandQuote[]): SymbolFileQuote[] {
  const latestCycle = bandQuotes.reduce((latest, quote) => Math.max(latest, quote.cycleNumber), -1);
  return bandQuotes.filter((quote) => quote.cycleNumber === latestCycle && quote.errorCode === null).map((quote) => ({ expiry: quote.expiry, strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask, bidSize: null, askSize: null }));
}

export function runLadderLook(input: LadderLookInput): LadderLookResult {
  const suggestedSplit = input.previousClose === null ? null : splitSuggestedByPrice(input.stockPrice, input.previousClose);
  if (suggestedSplit !== null) {
    return { stoppedBecause: `${input.symbol} trades at ${input.stockPrice.toFixed(2)} against a previous close of ${input.previousClose!.toFixed(2)}, about a ${describePriceAdjustment(suggestedSplit)} with none recorded: the ladder stops on it until a person looks`, memory: null, planned: [], notes: [] };
  }
  const book = createLadderLookBook(input.book);
  const cycleOpen = book.book.heldSharesToday() > 0 || input.book.positions.some((position) => position.status === "open" && position.legs.some((leg) => leg.exitAt === null));
  const memory = nextLadderCycleMemory(input.memory, { cycleOpen, accountValue: input.book.accountValue, todayIso: input.clock.todayIso, shockPctIfStartingToday: input.shockPctIfStartingToday });
  const baseline: BacktestBaselineSettings = { ...defaultBacktestBaselineSettings, ...input.baseline };
  const quotes = latestCycleQuotes(input.bandQuotes);
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
  });
  const notes: string[] = [];
  if (input.previousSessionVolumeByContract === null) notes.push(`${input.symbol}: no previous-session option volume was captured, so nothing can be sold (the 20% rule)`);
  const ladderState = { startedOn: memory.startedOn, accountValueAtStart: memory.accountValueAtStart, shock: memory.shock ?? 0 };
  planBaselineSales({ symbol: input.symbol, commissions: input.book.commissions, todayIso: input.clock.todayIso, atMs: input.now.getTime(), stockPrice: input.stockPrice, priceToCycleScale: 1, baseline, select, book: book.book, ladderState, notes });
  // A same-day expiry is sold only while it still has time to the close.
  const planned = book.planned.filter((sale) => daysToExpiry(sale.expiry, input.clock.todayIso) > 0 || yearsToTodaysClose > 0);
  return { stoppedBecause: null, memory, planned, notes };
}
