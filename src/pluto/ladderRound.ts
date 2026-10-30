import { loadCommissionEstimator, loadStockCommissionEstimator } from "../lib/commissionEstimate.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { accountContextFromTotalCash } from "../lib/accountContext.js";
import { frozenSymbolSet } from "../lib/tickerFreeze.js";
import { loadInFlightNotionalsBySymbol, loadLastFilledPlutoActionAtBySymbol } from "./book.js";
import { executePlutoOrder, watchPlutoOrder } from "./executor.js";
import { defaultOptionQuoteBandPlannerDependencies } from "./optionQuoteBandPlanLoader.js";
import { saveLadderCycleMemory } from "./ladderCycleMemory.js";
import { runLadderLook } from "./ladderLook.js";
import { loadLadderLookInput } from "./ladderLookLoader.js";
import { loadCommittedCapitalOnSymbols } from "../lib/orderLimits.js";
import { noticeLadderBook, noticeLadderTicker, type LadderBookNoticeReason } from "./ladderNotices.js";
import { admitLadderSales, ladderSaleNotional, loadLadderTickerOrderCounts, sendLadderSales, type LadderBookRoom, type LadderSaleOutcome } from "./ladderOrders.js";
import { recordPlutoAction, recordPlutoEvent } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { tickerCooldownStatus } from "./postModelGates.js";
import { loadSafetyLimitBookCounts } from "./safetyLimits.js";
import type { PlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, effectivePlutoStrategy, loadEnabledPlutoTickerSettings, tickerPotFraction } from "./tickerSettingsStore.js";

// One Pluto round under the CC + Put Ladder (Marcelo 2026-10-14/15): rules only, no model. Every enabled ticker gets a
// look (ladderLook.ts) on its live book and the Day Signals loop's band quotes, and the sales it plans go out within the
// Safety Limits' caps (ladderOrders.ts, safetyLimits.ts), the ticker's and the book's: the book's counts and the capital its tickers commit are
// read once per round and moved on as the round sends. Pluto's own checks (breakers, window, worker, reconciliation,
// readiness) ran before this; the SPY stress breaker is checked by the caller. A frozen ticker (a split pending)
// is never looked at. What stops a ticker or holds its sales goes to Telegram once a day (ladderNotices.ts).

export interface LadderRoundInput {
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
}

export interface LadderRoundSummary {
  looked: string[];
  planned: number;
  outcomes: LadderSaleOutcome[];
  /** Per ticker, why nothing was looked at or planned. */
  notes: string[];
}

export async function runLadderRound(input: LadderRoundInput): Promise<LadderRoundSummary> {
  const { settings } = input;
  const [enabled, frozen, clock, optionCommissions, stockCommissions, account, lastFilledAtBySymbol] = await Promise.all([
    loadEnabledPlutoTickerSettings(),
    frozenSymbolSet(),
    defaultOptionQuoteBandPlannerDependencies.loadClock(input.todayIso),
    loadCommissionEstimator(),
    loadStockCommissionEstimator(),
    accountContextFromTotalCash(input.totalCashValue),
    loadLastFilledPlutoActionAtBySymbol(),
  ]);
  const allocationBySymbol = effectiveAllocationPctBySymbol(enabled);
  const summary: LadderRoundSummary = { looked: [], planned: 0, outcomes: [], notes: [] };
  // The book: every ticker enabled in Pluto, frozen ones included (their positions still commit capital).
  const [bookCounts, bookCommitted, inFlightAtStart] = await Promise.all([loadSafetyLimitBookCounts(enabled, input.now), loadCommittedCapitalOnSymbols(enabled.map((ticker) => ticker.symbol)), loadInFlightNotionalsBySymbol()]);
  const book: LadderBookRoom = { counts: bookCounts, committedCapitalDollars: bookCommitted, budgetFraction: settings.capitalBudgetPct / 100, netLiquidationValue: input.netLiquidationValue };
  const bookNotices = new Set<LadderBookNoticeReason>();
  // What this round's earlier tickers just sent: the cash they commit is gone for the next ones. The orders in flight are
  // read once, at the round's start, so the round's own are counted here only.
  let committedThisRound = 0;
  for (const ticker of enabled) {
    if (input.symbols.length > 0 && !input.symbols.includes(ticker.symbol)) continue;
    // A ticker under Vol Farmer v2 is volFarmerV2Round.ts's; it still counts in the book above.
    if (effectivePlutoStrategy(ticker) !== "cc_put_ladder") continue;
    if (frozen.has(ticker.symbol)) {
      summary.notes.push(`${ticker.symbol}: frozen (a split is pending), not traded`);
      continue;
    }
    const cooldown = tickerCooldownStatus(lastFilledAtBySymbol.get(ticker.symbol) ?? null, input.now.getTime(), settings.safetyTickerCooldownMinutes);
    if (settings.safetyTickerCooldownMinutes > 0 && !cooldown.cooledDown) {
      summary.notes.push(`${ticker.symbol}: ticker cooldown, ${cooldown.detail}`);
      continue;
    }
    // Pluto's free cash, less what orders on other tickers still tie up (the ticker's own are counted by its look).
    const freeCash = Math.max(0, account.freeCash - (inFlightAtStart.totalNotional - (inFlightAtStart.tickerNotionalBySymbol.get(ticker.symbol) ?? 0)) - committedThisRound);
    const tickerWeight = tickerPotFraction(allocationBySymbol.get(ticker.symbol) ?? 0, settings);
    const commissions = { option: optionCommissions, stock: stockCommissions };
    const lookInput = await loadLadderLookInput({ tickerId: ticker.tickerId, symbol: ticker.symbol, tickerWeight }, { now: input.now, clock, freeCash, accountValue: input.netLiquidationValue, commissions, maxQuoteAgeMinutes: settings.maxQuoteAgeMinutes });
    if ("unavailable" in lookInput) {
      summary.notes.push(lookInput.unavailable);
      if (lookInput.noShock) await noticeLadderTicker(ticker.symbol, "no_shock", settings, input.now);
      continue;
    }
    const look = runLadderLook(lookInput);
    summary.looked.push(ticker.symbol);
    if (look.stoppedBecause) {
      summary.notes.push(look.stoppedBecause);
      await recordPlutoEvent("warning", { passId: input.passId, symbol: ticker.symbol, message: look.stoppedBecause });
      await noticeLadderTicker(ticker.symbol, "split_guard", settings, input.now);
      continue;
    }
    await saveLadderCycleMemory(ticker.tickerId, look.memory!);
    summary.planned += look.planned.length;
    summary.notes.push(...look.notes);
    if (look.cannotTradeBecause) await noticeLadderTicker(ticker.symbol, look.cannotTradeBecause, settings, input.now);
    if (look.planned.length === 0) continue;
    const counts = await loadLadderTickerOrderCounts({ tickerId: ticker.tickerId, symbol: ticker.symbol }, input.now);
    const { send, waiting } = admitLadderSales(look.planned, counts, book, settings);
    if (waiting.length > 0) {
      summary.notes.push(`${ticker.symbol}: ${waiting.length} sale(s) wait for a later look (${waiting[0]!.reason})`);
      const bookCap = waiting.find((entry) => entry.cap.startsWith("book_"))?.cap as LadderBookNoticeReason | undefined;
      if (bookCap && !bookNotices.has(bookCap)) {
        bookNotices.add(bookCap);
        await noticeLadderBook(bookCap, settings, input.now);
      }
      if (waiting.some((entry) => entry.cap.startsWith("ticker_"))) await noticeLadderTicker(ticker.symbol, "held_by_ticker_cap", settings, input.now);
    }
    const outcomes = await sendLadderSales(
      {
        passId: input.passId,
        symbol: ticker.symbol,
        tickerId: ticker.tickerId,
        sales: send,
        deltaContext: { minAbsDelta: lookInput.baseline.minAbsDelta, maxAbsDelta: lookInput.baseline.maxAbsDelta, riskFreeRate: clock.riskFreeRate, todayIso: clock.todayIso, closeMinutesEt: clock.closeMinutesEt },
        forwardAnchors: lookInput.forwardAnchors,
        stockPrice: lookInput.stockPrice,
        todayIso: clock.todayIso,
        baseline: lookInput.baseline,
        commissions,
        tradingSessionsThrough: lookInput.tradingSessionsThrough,
      },
      {
        burst: (symbol, contracts) => input.marketWatch.burst(symbol, contracts),
        recordAction: recordPlutoAction,
        recordEvent: (type, detail) => recordPlutoEvent(type, detail),
        execute: (order) => executePlutoOrder(input.api, settings, order),
        watch: (watched) =>
          input.trackWatch(
            watchPlutoOrder(input.api, settings, { actionId: watched.actionId, orderId: watched.orderId, symbol: ticker.symbol, reference: { price: watched.limitPrice, side: "sell", multiplier: 100, ...(watched.otherReferenceLegs ? { otherLegs: watched.otherReferenceLegs } : {}) }, description: watched.description, cancelByMs: input.cancelByMs }),
            watched.orderId,
            ticker.symbol,
          ),
        now: () => new Date(),
      },
    );
    for (const outcome of outcomes) {
      if (outcome.orderId !== null) book.counts.ordersToday += 1;
      if (outcome.outcome !== "confirmed") continue;
      committedThisRound += outcome.sale.strategyKey === "cash_secured_put" ? outcome.sale.strike * 100 * outcome.sale.contracts : outcome.sale.sharesBought * outcome.sale.stockPrice;
      book.counts.workingOrders += 1;
      book.committedCapitalDollars += ladderSaleNotional(outcome.sale, outcome.limitPrice ?? outcome.sale.optionPrice);
    }
    if (outcomes.some((outcome) => outcome.blockedOnLiveCheck)) await noticeLadderTicker(ticker.symbol, "blocked_on_live_check", settings, input.now);
    summary.outcomes.push(...outcomes);
  }
  return summary;
}
