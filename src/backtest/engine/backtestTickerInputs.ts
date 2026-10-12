import { easternInstant } from "../../lib/easternIsoDate.js";
import { isRegularDividendCadence } from "../../lib/impliedVolatilitySurface.js";
import { calendarDaysUntilExpiry, captureBothSidesWithinFractionOfSpot, captureMaximumDaysToExpiry, captureMinimumDaysToExpiry, computeStrikeWindow, selectContractsToCapture, type StrikeWindow } from "../../lib/optionChainCaptureWindow.js";
import { chooseReferenceVolatility } from "../../lib/optionChainCaptureReferenceVolatility.js";
import { fitSurfaceForSnapshot, type FittedExpiry } from "../../lib/optionSurfaceFitting.js";
import { computeYangZhangVolatility } from "../../lib/realizedVolatility.js";
import type { MacroEvent } from "../../lib/macroEventCalendar.js";
import type { SignalQuote, SignalSurfaceSlice } from "../../lib/signalCandidates.js";
import { contractKey, type LiveOptionQuote } from "../../lib/signalsLiveScoring.js";
import type { SnapshotHeader, TickerSignalsInputs } from "../../lib/signalsTypes.js";
import { addCalendarDays } from "../../lib/signalsRoadmap.js";
import { computeElevatedVolatilityFlag, computeMomentum, computeSkew, volatilityRatio, volatilityRatioBarsRead, type ElevatedVolatilityFlag } from "../../lib/tiltMeasures.js";
import type { DailyOhlcvBar } from "../../lib/realizedVolatility.js";
import { primaryForecastWindowDays, selectModelVolatilityForecast, selectRealizedVolatilityForecast } from "../../lib/volatilityEdge.js";
import type { ValuationGroup } from "../../lib/volatilityModelTables.js";
import { backtestCaptureLookTimeEt } from "../backtestTypes.js";
import { toOhlcvBars, type BacktestBarHistory } from "./backtestBarHistory.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import type { BacktestTradingCalendar } from "./backtestTradingCalendar.js";

// One backtest day's Signals inputs at 10:00 ET (docs/backtesting/FORMULAS.md): the live pipeline's inputs rebuilt from
// history. The day's quotes go through the capture's own contract selection and the same surface fit
// (optionSurfaceFitting.ts), and the inputs are built as loadTickerSignalsInputs builds them, from the bars before today,
// the file's open interest, the previous session's volume and the macro events still ahead that day. They serve every
// look of the day: a look (backtestLook.ts) adds the book (the free shares and the open short legs) and, after 10:00,
// its own quotes as the day's fresh quotes (selectLookDayQuotes).

/** The live capture's widest strike window (runOptionChainCapture.ts) when no reference volatility exists. */
const widestStrikeWindowHalfWidth = 0.5;
/** Bars the capture's reference volatility reads (runOptionChainCapture.ts). */
const referenceVolatilityBarCount = 40;
/** Bars loadBarsForTilt reads. */
const tiltBarCount = 1500;
/** Rows loadVolatilityForecasts reads. */
const forecastBarRowCount = primaryForecastWindowDays + 1 + 20;
const decisionTimeEt = { hour: 10, minute: 0 };

export interface BacktestTickerProfile {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
  valuationGroup: ValuationGroup;
  /** False for an ETF: no earnings or ex-dividend checks (tickerCalendarProfile). */
  calendarChecksApply: boolean;
  earningsCalendarResolved: boolean;
  /** Ascending. event_time "-1" = before the open. */
  earnings: { dateIso: string; eventTime: string | null }[];
  /** Ascending. */
  exDividends: { dateIso: string; amount: number | null }[];
}

export interface BacktestDayMarket {
  todayIso: string;
  /** Every 10:00 quote of the day in the file. */
  quotes: readonly SymbolFileQuote[];
  /** Open interest published for today, by contractKey. */
  openInterestByContract: ReadonlyMap<string, number>;
  /** The previous session's full volume, by contractKey; null when the file has no previous session. */
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  /** The 10:00 stock price (put-call parity). */
  stockPrice: number;
  /** DTB3 known at 10:00 (the latest observation before today), percent. */
  riskFreeRatePercent: number | null;
}

/** What one ticker's inputs of a day are built from. */
export interface HistoricalTickerDay {
  profile: BacktestTickerProfile;
  /** The ticker's daily bars on today's traded scale. */
  bars: BacktestBarHistory;
  market: BacktestDayMarket;
  calendar: BacktestTradingCalendar;
  /** Precomputed elevated-volatility flag for the day; computed from the bars when absent. */
  elevatedVolatility?: ElevatedVolatilityFlag | null;
  /** The major macro events from today on, as the calendar held them that day (loadUpcomingMajorMacroEvents); none when absent. */
  macroEvents?: readonly MacroEvent[];
}

/** The 10:00 look: the capture's own time. */
export const captureLookTimeEt = backtestCaptureLookTimeEt;

export function decisionInstantMs(todayIso: string): number {
  return easternInstant(todayIso, decisionTimeEt.hour, decisionTimeEt.minute).getTime();
}

/** The instant of a look ("HH:MM" Eastern) on a day. */
export function lookInstantMs(todayIso: string, lookTimeEt: string): number {
  const [hour, minute] = lookTimeEt.split(":").map(Number) as [number, number];
  return easternInstant(todayIso, hour, minute).getTime();
}

/**
 * A set of contracts by expiry, strike and right: membership as contractKey's would answer it (two strikes give the same
 * key text exactly when they are the same number), without building a key per quote.
 */
export class ContractSet {
  private readonly rightsByStrikeByExpiry = new Map<string, Map<number, Set<string>>>();

  static of(contracts: Iterable<{ expiry: string; strike: number; right: string }>): ContractSet {
    const set = new ContractSet();
    for (const contract of contracts) set.add(contract);
    return set;
  }

  add(contract: { expiry: string; strike: number; right: string }): void {
    let rightsByStrike = this.rightsByStrikeByExpiry.get(contract.expiry);
    if (!rightsByStrike) this.rightsByStrikeByExpiry.set(contract.expiry, (rightsByStrike = new Map()));
    let rights = rightsByStrike.get(contract.strike);
    if (!rights) rightsByStrike.set(contract.strike, (rights = new Set()));
    rights.add(contract.right);
  }

  has(contract: { expiry: string; strike: number; right: string }): boolean {
    return this.rightsByStrikeByExpiry.get(contract.expiry)?.get(contract.strike)?.has(contract.right) ?? false;
  }
}

/** The contracts the live 10:00 capture would have requested on this day (runOptionChainCapture.ts prepareTicker). */
export function selectCapturedQuotes(quotes: readonly SymbolFileQuote[], todayIso: string, stockPrice: number, referenceVolatility: number | null): SymbolFileQuote[] {
  const selected = capturedContractsOf(quotes, todayIso, stockPrice, referenceVolatility);
  return quotes.filter((quote) => selected.has(quote));
}

/** selectCapturedQuotes as contracts: every contract of a quote it keeps (and possibly contracts the quotes lack). */
function capturedContractsOf(quotes: readonly SymbolFileQuote[], todayIso: string, stockPrice: number, referenceVolatility: number | null): ContractSet {
  const strikesByExpiry = new Map<string, Set<number>>();
  for (const quote of quotes) strikesByExpiry.set(quote.expiry, (strikesByExpiry.get(quote.expiry) ?? new Set()).add(quote.strike));
  const selected = new ContractSet();
  for (const [expiry, strikes] of strikesByExpiry) {
    const daysToExpiryCount = calendarDaysUntilExpiry(todayIso, expiry.replaceAll("-", ""));
    if (daysToExpiryCount < captureMinimumDaysToExpiry || daysToExpiryCount > captureMaximumDaysToExpiry) continue;
    const window: StrikeWindow | null =
      referenceVolatility !== null
        ? computeStrikeWindow({ spotPrice: stockPrice, atmImpliedVolatility: referenceVolatility, daysToExpiry: daysToExpiryCount })
        : { halfWidth: widestStrikeWindowHalfWidth, lowerBound: stockPrice * Math.exp(-widestStrikeWindowHalfWidth), upperBound: stockPrice * Math.exp(widestStrikeWindowHalfWidth) };
    if (!window) continue;
    for (const contract of selectContractsToCapture([...strikes], stockPrice, window, { bothSidesWithinFractionOfSpot: captureBothSidesWithinFractionOfSpot })) selected.add({ expiry, ...contract });
  }
  return selected;
}

/**
 * The quotes a look after 10:00 reads fresh, as "day" quotes stamped with the look's instant: every contract of the
 * 10:00 capture, plus the contracts the capture's selection takes at the look's stock price (the live day loop re-reads
 * its contract set at the live price, so a contract that moved into the strike window since 10:00 is quoted too).
 * A held leg outside both is added by the look.
 */
export function selectLookDayQuotes(lookQuotes: readonly SymbolFileQuote[], capturedContracts: ContractSet, todayIso: string, lookStockPrice: number, referenceVolatility: number | null, quotedAtIso: string): LiveOptionQuote[] {
  // A look quote is among these exactly when selectCapturedQuotes keeps it.
  const inWindowNow = capturedContractsOf(lookQuotes, todayIso, lookStockPrice, referenceVolatility);
  const dayQuotes: LiveOptionQuote[] = [];
  for (const quote of lookQuotes) {
    if (capturedContracts.has(quote) || inWindowNow.has(quote)) dayQuotes.push({ expiry: quote.expiry, strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask, quotedAt: quotedAtIso });
  }
  return dayQuotes;
}

/** The capture's reference volatility from the bars before today (loadReferenceVolatility + chooseReferenceVolatility). */
export function referenceVolatilityBefore(bars: BacktestBarHistory, todayIso: string): number | null {
  const rows = bars.rowsBefore(todayIso, referenceVolatilityBarCount);
  const latestWithImpliedVolatility = [...rows].reverse().find((row) => row.impliedVolatility !== null);
  const yangZhang = computeYangZhangVolatility(toOhlcvBars(rows), 21);
  return chooseReferenceVolatility({
    todayIso,
    latestImpliedVolatility: latestWithImpliedVolatility?.impliedVolatility ?? null,
    latestImpliedVolatilityDateIso: latestWithImpliedVolatility?.tradingDate ?? null,
    yangZhang21DayVolatility: yangZhang.available ? yangZhang.annualizedVolatility : null,
  }).volatility;
}

/** A fitted expiry as the Signals loader reads it back from option_surface_fits (optionSurfaceStore.ts → signalsStore.ts loadSlices). */
export function fittedExpiryToSlice(fitted: FittedExpiry): SignalSurfaceSlice {
  return {
    expiry: fitted.expiry,
    status: fitted.slice.status,
    yearsToExpiry: fitted.yearsToExpiry,
    forwardPrice: fitted.forwardPrice,
    fitUnderlyingPrice: fitted.underlyingPrice,
    kMin: fitted.slice.kMin,
    kMax: fitted.slice.kMax,
    parameters: fitted.slice.parameters,
    pointCount: fitted.slice.pointCount,
    rmseVolatility: fitted.slice.rmseVolatility,
    minButterflyDensity: fitted.slice.minimumButterflyDensity,
    droppedCounts: fitted.dropped,
    calendarChecks: fitted.calendarChecks,
    calendarViolations: fitted.calendarViolations,
  };
}

/**
 * How far ahead a backtest day knows an earnings date (Marcelo 2026-10-12). The stored calendar holds every report of
 * the period, but a company announces its date some weeks before: a date is in a day's inputs (Signals' exclusion of
 * expiries spanning it, Pluto's closes before it) only from this many calendar days before it.
 */
export const earningsDateKnownCalendarDaysAhead = 30;

/** The earnings dates known on a day: up to earningsDateKnownCalendarDaysAhead calendar days after it. */
export function earningsKnownOn(earnings: BacktestTickerProfile["earnings"], todayIso: string): BacktestTickerProfile["earnings"] {
  const lastKnownDateIso = addCalendarDays(todayIso, earningsDateKnownCalendarDaysAhead);
  return earnings.filter((event) => event.dateIso <= lastKnownDateIso);
}

/**
 * Earnings the Signals exclusion checks on a day: the dates known that day (earningsKnownOn) from today on, except a
 * report today before the open (loadEarningsDatesNotYetReported).
 */
export function earningsNotYetReported(earnings: BacktestTickerProfile["earnings"], todayIso: string): string[] {
  return earningsKnownOn(earnings, todayIso)
    .filter((event) => event.dateIso >= todayIso && !(event.dateIso === todayIso && event.eventTime === "-1"))
    .map((event) => event.dateIso);
}

/**
 * The elevated-volatility flag reads the YZ21/YZ126 ratio at every bar of its 1,500, and the next day reads the same
 * ratios again. A ratio depends only on the bars it reads (volatilityRatioBarsRead of them, complete bars in a row of
 * one history), named here by the dates of the first and the last, so each is computed once per history and scale.
 */
const volatilityRatiosByHistory = new WeakMap<BacktestBarHistory, Map<string, number | null>>();

function rememberedVolatilityRatio(history: BacktestBarHistory): (bars: DailyOhlcvBar[], endIndex: number) => number | null {
  let ratioByWindow = volatilityRatiosByHistory.get(history);
  if (!ratioByWindow) volatilityRatiosByHistory.set(history, (ratioByWindow = new Map()));
  const remembered = ratioByWindow;
  return (bars, endIndex) => {
    if (endIndex < volatilityRatioBarsRead || endIndex > bars.length) return volatilityRatio(bars, endIndex);
    const window = `${bars[endIndex - volatilityRatioBarsRead]!.tradingDate}|${bars[endIndex - 1]!.tradingDate}`;
    if (remembered.has(window)) return remembered.get(window)!;
    const ratio = volatilityRatio(bars, endIndex);
    remembered.set(window, ratio);
    return ratio;
  };
}

/**
 * Builds the day's TickerSignalsInputs the way loadTickerSignalsInputs does, from history, with an empty book (no free
 * shares, no open short legs): the look sets those from the simulated ledger at each pass.
 */
export function buildHistoricalTickerInputs(context: HistoricalTickerDay): { inputs: TickerSignalsInputs; fitIssue: string | null; referenceVolatility: number | null } {
  const { profile, bars, market } = context;
  const todayIso = market.todayIso;
  const capturedAtIso = new Date(decisionInstantMs(todayIso)).toISOString();

  const nextExDividend = profile.exDividends.find((event) => event.dateIso >= todayIso) ?? null;
  const pastExDividend = [...profile.exDividends].reverse().find((event) => event.dateIso < todayIso) ?? null;
  const referenceVolatility = referenceVolatilityBefore(bars, todayIso);
  const captured = selectCapturedQuotes(market.quotes, todayIso, market.stockPrice, referenceVolatility);
  let slices: SignalSurfaceSlice[] = [];
  let fitIssue: string | null = null;
  try {
    const outcome = fitSurfaceForSnapshot({
      tradingDate: todayIso,
      spotPrice: market.stockPrice,
      riskFreeRatePercent: market.riskFreeRatePercent,
      nextExDividendDate: nextExDividend?.dateIso ?? null,
      nextExDividendAmount: nextExDividend?.amount ?? null,
      pastExDividendDate: pastExDividend?.dateIso ?? null,
      pastExDividendAmount: pastExDividend?.amount ?? null,
      quotes: captured.map((quote) => ({ expiry: quote.expiry, strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask })),
    });
    if (outcome.kind === "skipped") fitIssue = outcome.reason;
    else slices = outcome.expiries.map(fittedExpiryToSlice);
  } catch (error) {
    fitIssue = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const header: SnapshotHeader = { snapshotId: `backtest:${todayIso}`, tradingDateIso: todayIso, capturedAt: capturedAtIso, underlyingPrice: market.stockPrice, riskFreeRatePercent: market.riskFreeRatePercent, fitCompletedAt: capturedAtIso, fitIssue };
  const quotes: SignalQuote[] = captured.map((quote) => {
    const key = contractKey(quote);
    return { expiry: quote.expiry, strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask, source: "snapshot", openInterest: market.openInterestByContract.get(key) ?? null, volume: market.previousSessionVolumeByContract?.get(key) ?? null, bidSize: quote.bidSize, askSize: quote.askSize };
  });

  const forecastBars = toOhlcvBars(bars.rowsBefore(todayIso, forecastBarRowCount));
  const tiltBars = toOhlcvBars(bars.rowsBefore(todayIso, tiltBarCount));
  const earningsDatesIso = profile.calendarChecksApply ? earningsNotYetReported(profile.earnings, todayIso) : [];
  const furthestExpiry = slices.map((slice) => slice.expiry).sort().at(-1);

  const inputs: TickerSignalsInputs = {
    tickerId: profile.tickerId,
    symbol: profile.symbol,
    companyName: profile.companyName,
    sector: profile.sector,
    header,
    slices,
    quotes,
    dayQuotes: [],
    forecast: selectRealizedVolatilityForecast(forecastBars),
    modelForecast: selectModelVolatilityForecast(forecastBars),
    openSessionDatesIso: furthestExpiry && furthestExpiry > todayIso ? context.calendar.openDaysBetween(addCalendarDays(todayIso, 1), furthestExpiry) : [],
    tradingSessions: furthestExpiry ? context.calendar.sessionsBetween(todayIso, furthestExpiry) : [],
    valuationGroup: profile.valuationGroup,
    earningsDatesIso,
    earningsCalendarResolved: profile.earningsCalendarResolved,
    macroEvents: [...(context.macroEvents ?? [])],
    momentum: computeMomentum(tiltBars.map((bar) => bar.close)),
    elevatedVolatility: context.elevatedVolatility !== undefined ? context.elevatedVolatility : computeElevatedVolatilityFlag(tiltBars, rememberedVolatilityRatio(bars)),
    skew: computeSkew(slices),
    nextEarningsDateIso: profile.calendarChecksApply ? (earningsDatesIso[0] ?? null) : null,
    previousClose: bars.previousClose(todayIso),
    freeShares: 0,
    openShortLegs: [],
    dailyBarCount: bars.countBefore(todayIso),
    // loadDividendCadenceUnknown: an upcoming ex-dividend with no regular cadence to project later ones from.
    dividendCadenceUnknown: nextExDividend !== null && !isRegularDividendCadence({ date: nextExDividend.dateIso, amount: Number(nextExDividend.amount) }, pastExDividend ? { date: pastExDividend.dateIso, amount: Number(pastExDividend.amount) } : null),
    todayEasternIso: todayIso,
  };
  return { inputs, fitIssue, referenceVolatility };
}
