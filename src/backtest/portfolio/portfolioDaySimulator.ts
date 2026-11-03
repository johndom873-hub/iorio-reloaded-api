import { blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import type { EffectiveBacktestSettings } from "../backtestTypes.js";
import { computeInterestDollars } from "../engine/backtestBook.js";
import { BacktestBarHistory } from "../engine/backtestBarHistory.js";
import type { BacktestLookSymbol } from "../engine/backtestLookTypes.js";
import { captureLookTimeEt, lookInstantMs } from "../engine/backtestTickerInputs.js";
import { BacktestTradingCalendar } from "../engine/backtestTradingCalendar.js";
import { runVolFarmerV2Look } from "../engine/backtestVolFarmerV2Look.js";
import { creditInterest, expirySettlementInstant, settleExpiry, settleLeapsCall } from "../engine/ledger/ledgerEvents.js";
import { ledgerLeapsLegsDueForSettlement, ledgerLegsDueForSettlement, ledgerNetLiquidationValue } from "../engine/ledger/ledgerSelectors.js";
import { createSimulatedLedger, requirePosition, unexitedLegsOf, type LedgerLeg, type SimulatedLedger } from "../engine/ledger/simulatedLedger.js";
import type { ObservedChainDay } from "./portfolioObservedChain.js";
import { syntheticExpiryChain, syntheticLeapsSource } from "./portfolioSyntheticChain.js";

// The portfolio simulator's day (D5, Marcelo 2026-11-03): Vol Farmer v4 as the lab runs it, on simulated days. Each day,
// as the session runner does: options that expired at an earlier close settle on that close (settleExpiry, the LEAPS
// settleLeapsCall), interest is credited on the cash since the previous day, the account is marked at 10:00 (the day's
// value, before its orders), then the lab's own v4 look (runVolFarmerV2Look) decides at 10:00 on the day's synthetic chain
// (portfolioSyntheticChain.ts) with the lab's book: whole lots, the First position and its band, Always hold the stock,
// the same-day Calls, the Puts and LEAPS, the allowance, the shared free cash and the turn order. One look a day (the
// lab's 10:00); no splits, dividends or earnings on simulated days.

const millisecondsPerYear = 365 * 86_400_000;
const millisecondsPerDay = 86_400_000;

export interface SimulatedTicker {
  symbol: string;
  /** u (D4): a same-day Call's own IV ÷ IBKR's 30-day IV in the ticker's backtest. */
  sameDayVolatilityUplift: number;
}

export interface SimulatedTickerDay {
  /** The price at the 10:00 look, as traded. */
  tenOclockPrice: number;
  close: number;
  /** IBKR's 30-day IV known at 10:00 (the previous session's), as a fraction. */
  impliedVolatility: number;
  /** The first expiry on or after today: today's on an expiry day. */
  nextExpiry: string;
  /** The listed strikes' spacing, $: today's on a projected day, the listed one on a replayed day. */
  strikeSpacing: number;
  /**
   * The observed day of the ticker's own chain the next expiry is priced, quoted and traded like, read against its anchor,
   * and the day's own anchor (the 30-day IV × the ticker's factor at the day's elevation; portfolioObservedChain.ts);
   * null: priced at the 30-day IV × u, a cent either side, any volume.
   */
  observedChain: { day: ObservedChainDay; volatilityAnchor: number } | null;
}

export interface DaySimulationInput {
  /** The simulated sessions, ascending ISO dates. */
  dates: readonly string[];
  tickers: readonly SimulatedTicker[];
  /** Ticker `ticker`'s day `day` (indices into `tickers` and `dates`). */
  dayOf(ticker: number, day: number): SimulatedTickerDay;
  /** The lab's settings as a session reads them, the book's allocations and Always hold the stock in volFarmerV4. */
  settings: EffectiveBacktestSettings;
  startingValue: number;
  /** T-bills, percent a year: the cash's interest every day and the options' rate. */
  riskFreeRatePercent: number;
  /** A replay of recorded days: the rate on or before a date (DTB3), in place of riskFreeRatePercent. */
  riskFreeRatePercentOn?(dateIso: string): number;
  /** Each look's summary, as the session records it per day (what was done and why not). */
  onLookSummary?(dateIso: string, summary: string): void;
}

export interface SimulatedTickerFigures {
  symbol: string;
  /** Calls and Puts sold: their fills less commission. */
  premiumDollars: number;
  callsSold: number;
  callAways: number;
  /** Days the ticker held no shares at 10:00. */
  daysWithoutShares: number;
}

/**
 * Where the account's change came from (D6): Calls and Puts sold (fills less commission), the LEAPS (their cash and the
 * open ones at the last close), T-bill interest, and the shares: the rest (their P&L with their commissions).
 */
export interface SimulationSources {
  callsDollars: number;
  putsDollars: number;
  leapsDollars: number;
  interestDollars: number;
  sharesDollars: number;
}

export interface DaySimulationResult {
  /** The account at 10:00 each day, before the day's orders (the session's own day values), then at the last close. */
  accountValues: Float64Array;
  premiumDollars: number;
  interestDollars: number;
  byTicker: SimulatedTickerFigures[];
  sources: SimulationSources;
}

const symbolOfLeg = (ledger: SimulatedLedger, leg: LedgerLeg) => requirePosition(ledger, leg.positionId).symbol;

/** Runs the book over the days: the lab's v4 look on synthetic chains, settled and marked as the session runner does. */
export async function simulateBookDays(input: DaySimulationInput): Promise<DaySimulationResult> {
  const { dates, tickers, settings, startingValue } = input;
  const ratePercentOn = (dateIso: string) => input.riskFreeRatePercentOn?.(dateIso) ?? input.riskFreeRatePercent;
  let riskFreeRate = ratePercentOn(dates[0]!) / 100;
  const ledger = createSimulatedLedger(startingValue, new Date(lookInstantMs(dates[0]!, captureLookTimeEt) - millisecondsPerDay));
  const calendar = new BacktestTradingCalendar(dates.map((tradingDate) => ({ tradingDate, status: "complete" as const })), []);
  const priceByLegId = new Map<string, number>();
  const closeBySymbolAndDate = new Map<string, number>();
  const sectorBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, null]));
  const figures = tickers.map<SimulatedTickerFigures>((ticker) => ({ symbol: ticker.symbol, premiumDollars: 0, callsSold: 0, callAways: 0, daysWithoutShares: 0 }));
  const figuresBySymbol = new Map(figures.map((entry) => [entry.symbol, entry]));
  const tickerIndexBySymbol = new Map(tickers.map((ticker, index) => [ticker.symbol, index]));
  const sameDayOptionsOnly = settings.volFarmerV4.optionsExpiry === "today";
  const accountValues = new Float64Array(dates.length + 1);
  let interestDollars = 0;
  let callsDollars = 0;
  let putsDollars = 0;
  let actionNumber = 0;

  for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
    const todayIso = dates[dayIndex]!;
    const previousIso = dayIndex === 0 ? null : dates[dayIndex - 1]!;
    const at = new Date(lookInstantMs(todayIso, captureLookTimeEt));
    const days = tickers.map((_, ticker) => input.dayOf(ticker, dayIndex));
    // The rate known at 10:00: the latest before today, as the session reads DTB3.
    const riskFreeRatePercent = ratePercentOn(previousIso ?? todayIso);
    riskFreeRate = riskFreeRatePercent / 100;

    // a. Options that expired at an earlier close settle on that close.
    if (previousIso !== null) {
      for (const leg of ledgerLegsDueForSettlement(ledger, previousIso)) {
        const symbol = symbolOfLeg(ledger, leg);
        const outcome = settleExpiry(ledger, { legId: leg.id, expiryClose: closeBySymbolAndDate.get(`${symbol} ${leg.expiryDate}`)! });
        if (outcome === "call_away") figuresBySymbol.get(symbol)!.callAways += 1;
      }
      for (const leg of ledgerLeapsLegsDueForSettlement(ledger, previousIso)) {
        const symbol = symbolOfLeg(ledger, leg);
        settleLeapsCall(ledger, { legId: leg.id, expiryClose: closeBySymbolAndDate.get(`${symbol} ${leg.expiryDate}`)! });
      }
      // b. Interest on the cash since the previous day.
      const calendarDays = Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${previousIso}T00:00:00Z`)) / millisecondsPerDay);
      const dollars = computeInterestDollars(ledger.cash, riskFreeRatePercent, calendarDays);
      interestDollars += dollars;
      creditInterest(ledger, at, dollars);
    }

    // c. Every open leg marked at 10:00, as the runner marks it at the quotes' mid: shares at the price, a sold Call or Put
    // on the day's chain (the 30-day IV × u), a LEAPS on the 30-day IV.
    const sharesHeld = new Set<string>();
    for (const leg of unexitedLegsOf(ledger)) {
      const position = requirePosition(ledger, leg.positionId);
      const tickerIndex = tickerIndexBySymbol.get(position.symbol)!;
      const day = days[tickerIndex]!;
      if (leg.legType === "stock") {
        priceByLegId.set(leg.id, day.tenOclockPrice);
        if (leg.quantity > 0) sharesHeld.add(position.symbol);
      } else if (leg.strikePrice !== null && leg.expiryDate !== null) {
        const isCall = leg.optionType === "call";
        const volatility = position.strategyKey === "leaps" ? day.impliedVolatility : day.impliedVolatility * tickers[tickerIndex]!.sameDayVolatilityUplift;
        const yearsToExpiry = Math.max(0, expirySettlementInstant(leg.expiryDate).getTime() - at.getTime()) / millisecondsPerYear;
        const forward = day.tenOclockPrice * Math.exp(riskFreeRate * yearsToExpiry);
        const intrinsic = Math.max(0, isCall ? day.tenOclockPrice - leg.strikePrice : leg.strikePrice - day.tenOclockPrice);
        priceByLegId.set(leg.id, yearsToExpiry > 0 ? blackScholesPriceOnForward(forward, leg.strikePrice, yearsToExpiry, riskFreeRate, volatility, isCall) : intrinsic);
      }
    }
    accountValues[dayIndex] = ledgerNetLiquidationValue(ledger, priceByLegId);
    for (const ticker of tickers) if (!sharesHeld.has(ticker.symbol)) figuresBySymbol.get(ticker.symbol)!.daysWithoutShares += 1;

    // d. The lab's v4 look at 10:00 on the day's synthetic chain. Selling only options expiring today, v4 reads nothing of
    // a day's quotes but whether a Call expires today (volFarmerV2Steps.ts): on another day the chain is left empty.
    const lookSymbols: BacktestLookSymbol[] = tickers.map((ticker, index) => {
      const day = days[index]!;
      const yearsToExpiry = (expiry: string) => Math.max(0, expirySettlementInstant(expiry).getTime() - at.getTime()) / millisecondsPerYear;
      const chainUnread = sameDayOptionsOnly && day.nextExpiry !== todayIso;
      const { quotes, previousSessionVolumeByContract } = chainUnread ? { quotes: [], previousSessionVolumeByContract: new Map<string, number>() } : syntheticExpiryChain({
        expiry: day.nextExpiry,
        stockPrice: day.tenOclockPrice,
        yearsToExpiry: yearsToExpiry(day.nextExpiry),
        riskFreeRate,
        volatility: day.impliedVolatility * ticker.sameDayVolatilityUplift,
        strikeSpacing: day.strikeSpacing,
        ...(day.observedChain === null ? {} : { observed: { day: day.observedChain.day, thirtyDayVolatility: day.observedChain.volatilityAnchor } }),
      });
      return {
        profile: { tickerId: ticker.symbol, symbol: ticker.symbol, companyName: null, sector: null, calendarChecksApply: false, earningsCalendarResolved: true, earnings: [], exDividends: [] },
        bars: new BacktestBarHistory(previousIso === null ? [] : [{ tradingDate: previousIso, open: null, high: null, low: null, close: null, volume: null, impliedVolatility: day.impliedVolatility }]),
        market: { todayIso, quotes, previousSessionVolumeByContract, stockPrice: day.tenOclockPrice, riskFreeRatePercent },
        splitFactorToday: 1,
        optionContractsRepresentable: true,
        adjustedDailyClosesBeforeToday: [],
        leapsCallQuotes: syntheticLeapsSource({ todayIso, stockPrice: day.tenOclockPrice, riskFreeRate, volatility: day.impliedVolatility, strikeSpacing: day.strikeSpacing, yearsToExpiry }),
      };
    });
    const look = await runVolFarmerV2Look({
      todayIso,
      lookTimeEt: captureLookTimeEt,
      symbols: lookSymbols,
      sectorBySymbol,
      calendar,
      settings,
      ledger,
      previousSessionDateIso: previousIso,
      priceByLegId,
      nextActionId: () => `simulated-${(actionNumber += 1)}`,
      sessionDayIndex: dayIndex,
    });
    input.onLookSummary?.(todayIso, look.summary);
    for (const sale of look.optionSales) {
      const entry = figuresBySymbol.get(sale.symbol)!;
      const netPremium = sale.fillPrice * sale.contracts * 100 - sale.commissionDollars;
      entry.premiumDollars += netPremium;
      if (sale.optionRight === "C") {
        entry.callsSold += 1;
        callsDollars += netPremium;
      } else putsDollars += netPremium;
    }
    tickers.forEach((ticker, index) => closeBySymbolAndDate.set(`${ticker.symbol} ${todayIso}`, days[index]!.close));
  }

  // The last day's close: shares at the close, options expiring that day at their intrinsic value, a LEAPS at its value then.
  const lastIso = dates.at(-1)!;
  const closeAt = expirySettlementInstant(lastIso);
  const closePriceByLegId = new Map(priceByLegId);
  for (const leg of unexitedLegsOf(ledger)) {
    const position = requirePosition(ledger, leg.positionId);
    const close = closeBySymbolAndDate.get(`${position.symbol} ${lastIso}`)!;
    if (leg.legType === "stock") closePriceByLegId.set(leg.id, close);
    else if (leg.strikePrice !== null && leg.expiryDate !== null) {
      const intrinsic = Math.max(0, leg.optionType === "call" ? close - leg.strikePrice : leg.strikePrice - close);
      const yearsToExpiry = Math.max(0, expirySettlementInstant(leg.expiryDate).getTime() - closeAt.getTime()) / millisecondsPerYear;
      const day = input.dayOf(tickerIndexBySymbol.get(position.symbol)!, dates.length - 1);
      closePriceByLegId.set(leg.id, yearsToExpiry > 0 ? blackScholesPriceOnForward(close * Math.exp(riskFreeRate * yearsToExpiry), leg.strikePrice, yearsToExpiry, riskFreeRate, day.impliedVolatility, leg.optionType === "call") : intrinsic);
    }
  }
  accountValues[dates.length] = ledgerNetLiquidationValue(ledger, closePriceByLegId);
  const isLeaps = (positionId: string | null) => positionId !== null && requirePosition(ledger, positionId).strategyKey === "leaps";
  let leapsDollars = 0;
  for (const entry of ledger.cashJournal) if (isLeaps(entry.positionId)) leapsDollars += entry.amount;
  for (const leg of unexitedLegsOf(ledger)) if (isLeaps(leg.positionId)) leapsDollars += (closePriceByLegId.get(leg.id) ?? leg.entryPrice) * leg.quantity * leg.multiplier * (leg.side === "short" ? -1 : 1);
  const sharesDollars = accountValues[dates.length]! - startingValue - callsDollars - putsDollars - leapsDollars - interestDollars;
  return { accountValues, premiumDollars: figures.reduce((sum, entry) => sum + entry.premiumDollars, 0), interestDollars, byTicker: figures, sources: { callsDollars, putsDollars, leapsDollars, interestDollars, sharesDollars } };
}
