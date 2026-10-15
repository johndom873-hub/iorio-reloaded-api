import { loadCommissionEstimator, loadStockCommissionEstimator } from "../lib/commissionEstimate.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { accountContextFromTotalCash } from "../lib/signalsStore.js";
import { frozenSymbolSet } from "../lib/tickerFreeze.js";
import { loadInFlightNotionals, loadLastFilledPlutoActionAtBySymbol } from "./book.js";
import { executePlutoOrder, watchPlutoOrder } from "./executor.js";
import { defaultLadderBandPlannerDependencies } from "./ladderBandPlanLoader.js";
import { saveLadderCycleMemory } from "./ladderCycleMemory.js";
import { runLadderLook } from "./ladderLook.js";
import { loadLadderLookInput } from "./ladderLookLoader.js";
import { admitLadderSales, loadLadderTickerOrderCounts, sendLadderSales, type LadderSaleOutcome } from "./ladderOrders.js";
import { recordPlutoAction, recordPlutoEvent } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { tickerCooldownStatus } from "./postModelGates.js";
import type { PlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings } from "./tickerSettingsStore.js";

// One Pluto round under the CC + Put Ladder (Marcelo 2026-10-14/15): rules only, no model. Every enabled ticker gets a
// look (ladderLook.ts) on its live book and the Day Signals loop's band quotes, and the sales it plans go out within the
// ladder's caps (ladderOrders.ts). Pluto's own checks (breakers, window, worker, reconciliation, readiness) ran before
// this; the ladder's SPY stress level is checked by the caller. A frozen ticker (a split pending) is never looked at.

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
    defaultLadderBandPlannerDependencies.loadClock(input.todayIso),
    loadCommissionEstimator(),
    loadStockCommissionEstimator(),
    accountContextFromTotalCash(input.totalCashValue),
    loadLastFilledPlutoActionAtBySymbol(),
  ]);
  const allocationBySymbol = effectiveAllocationPctBySymbol(enabled);
  const summary: LadderRoundSummary = { looked: [], planned: 0, outcomes: [], notes: [] };
  // What this round's earlier tickers just sent: the cash they commit is gone for the next ones.
  let committedThisRound = 0;
  for (const ticker of enabled) {
    if (input.symbols.length > 0 && !input.symbols.includes(ticker.symbol)) continue;
    if (frozen.has(ticker.symbol)) {
      summary.notes.push(`${ticker.symbol}: frozen (a split is pending), not traded`);
      continue;
    }
    const cooldown = tickerCooldownStatus(lastFilledAtBySymbol.get(ticker.symbol) ?? null, input.now.getTime(), settings.ladderTickerCooldownMinutes);
    if (settings.ladderTickerCooldownMinutes > 0 && !cooldown.cooledDown) {
      summary.notes.push(`${ticker.symbol}: ticker cooldown, ${cooldown.detail}`);
      continue;
    }
    // Pluto's free cash, less what orders on other tickers still tie up (the ticker's own are counted by its look).
    const inFlight = await loadInFlightNotionals(ticker.symbol);
    const freeCash = Math.max(0, account.freeCash - (inFlight.totalNotional - inFlight.tickerNotional) - committedThisRound);
    const tickerWeight = ((allocationBySymbol.get(ticker.symbol) ?? 0) / 100) * (settings.capitalBudgetPct / 100);
    const lookInput = await loadLadderLookInput({ tickerId: ticker.tickerId, symbol: ticker.symbol, tickerWeight }, { now: input.now, clock, freeCash, accountValue: input.netLiquidationValue, commissions: { option: optionCommissions, stock: stockCommissions } });
    if ("unavailable" in lookInput) {
      summary.notes.push(lookInput.unavailable);
      continue;
    }
    const look = runLadderLook(lookInput);
    summary.looked.push(ticker.symbol);
    if (look.stoppedBecause) {
      summary.notes.push(look.stoppedBecause);
      await recordPlutoEvent("warning", { passId: input.passId, symbol: ticker.symbol, message: look.stoppedBecause });
      if (settings.telegramVerbosity !== "off") await notifyPlutoTelegram(`⚠️ Pluto (CC + Put Ladder): ${look.stoppedBecause}.`);
      continue;
    }
    await saveLadderCycleMemory(ticker.tickerId, look.memory!);
    summary.planned += look.planned.length;
    summary.notes.push(...look.notes);
    if (look.planned.length === 0) continue;
    const counts = await loadLadderTickerOrderCounts({ tickerId: ticker.tickerId, symbol: ticker.symbol }, input.now);
    const { send, waiting } = admitLadderSales(look.planned, counts, settings);
    if (waiting.length > 0) summary.notes.push(`${ticker.symbol}: ${waiting.length} sale(s) wait for a later look (${waiting[0]!.reason})`);
    const outcomes = await sendLadderSales(
      {
        passId: input.passId,
        symbol: ticker.symbol,
        tickerId: ticker.tickerId,
        sales: send,
        gateContext: { potFraction: tickerWeight, minAbsDelta: lookInput.baseline.minAbsDelta, maxAbsDelta: lookInput.baseline.maxAbsDelta, riskFreeRate: clock.riskFreeRate, todayIso: clock.todayIso, closeMinutesEt: clock.closeMinutesEt },
        forwardAnchors: lookInput.forwardAnchors,
        stockPrice: lookInput.stockPrice,
        todayIso: clock.todayIso,
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
      if (outcome.outcome === "confirmed") committedThisRound += outcome.sale.strategyKey === "cash_secured_put" ? outcome.sale.strike * 100 * outcome.sale.contracts : outcome.sale.sharesBought * outcome.sale.stockPrice;
    }
    summary.outcomes.push(...outcomes);
  }
  return summary;
}
