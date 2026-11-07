import { statSync, existsSync } from "node:fs";
import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { computeYangZhangVolatility } from "../../lib/realizedVolatility.js";
import { tickerCalendarProfile } from "../../lib/tickerCalendarRelevance.js";
import { backtestDataFilePath, requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { readFileDailyBars, readFileIntradayPrices } from "../backtestFileStockBars.js";
import { listBacktestDataFileSymbols, readBacktestDataFileContents } from "../dataFileSummary.js";
import { currentBusinessFromOf, rowsFrom } from "../tickerBusinessChanges.js";
import { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { loadBacktestBarHistory, type StoredDailyBar } from "../engine/backtestBarHistory.js";
import { readSplitScheduleCache, refreshSplitScheduleForSymbol, type SplitSchedule } from "../engine/splitFactors.js";
import { loadTreasuryBillRates } from "../engine/treasuryBillRates.js";
import { optionCommissionDollars, stockCommissionDollars } from "../engine/ledger/ledgerFills.js";
import { volFarmerV4BreakEven, volFarmerV4CallPremiumShare, volFarmerV4ImpliedMoveStep, volFarmerV4PutStrikeCapOf } from "../engine/volFarmerV4Steps.js";
import type { BacktestVolFarmerV4Settings } from "../backtestTypes.js";
import { openDaysFromCalendarRows } from "../../lib/marketSessionStatus.js";
import { loadMarketCalendarRowsFrom } from "../engine/backtestTradingCalendar.js";
import { computeOptionActivity, type AnalysisOptionActivity } from "./analysisOptionActivity.js";
import { buildSameDayCallScanDays, expiryDaysAmong, tenOclockPriceAsTraded } from "./analysisDayInputs.js";
import { correlationRows, impliedReportMove, reportMove, reportSessionDates, summarizeEarnings, type AnalysisCorrelationRow, type AnalysisEarningsSummary, type AnalysisReport } from "./analysisEarningsAndCorrelation.js";
import {
  barChecks,
  barIndicatorsOf,
  impliedVersusRealised,
  impliedVolatilityRange,
  marketFits,
  maxDrawdownByRange,
  median,
  openingGaps,
  stockProfile,
  toOhlcvBars,
  trendSplit,
  weeklySkew,
  yangZhangSeries,
  type AnalysisBarChecks,
  type AnalysisBarIndicators,
  type AnalysisIvPremiumStats,
  type AnalysisMarketFit,
  type AnalysisMaxDrawdown,
  type AnalysisOpeningGaps,
  type AnalysisPriceRange,
  type AnalysisProfile,
  type AnalysisTrendSplit,
} from "./analysisPriceFigures.js";
import { countExpiryWeeks, expiryWeeksBy, steadyWeekliesStartMonth, wholeWeeksBetween } from "./analysisExpiryWeeks.js";
import { scanSameDayCallsInParallel } from "./analysisSameDayCallsPool.js";
import type { SameDayCall, SameDayCallDay } from "./analysisSameDayCalls.js";
import { bandAt, largestPotOfDay, potFittingDayShare, smallestPotFor, targetReachedAt, targetReachedOverDays } from "./analysisPotSizing.js";
import { fallsOfAStep, stepStatistics, stepsOfBars, type FallOfAStep, type StepOnDay, type StepStatistics } from "./analysisStepFalls.js";
import { sameDayMonthsBefore, sharesPerLot } from "./analysisSuitabilityRule.js";

// The Analyse window's figures for one ticker under Vol Farmer v4 (Marcelo 2026-11-01), from its data file, its IBKR daily
// bars, its earnings and the other data files (for correlation), at the lab's v4 values: the weeks with an expiry (F1),
// the Calls v4 could sell on each expiry day (F5) and the pots they fit (F2–F4), what v4 would do today (F10), the Step
// and the falls of a Step (F7, F9), and the stock profile (F12–F16 with the 10-15 sheet's). Everything but the analysis
// backtest's figures (analysisBacktest.ts). The formulas are in FORMULAS.md, "Analyse window (Vol Farmer v4)".

/** Bumped when a formula or the figures' shape changes: a stored analysis with an older version shows as such. */
export const analysisFormulasVersion = 9;

export type AnalysisStep = "bars" | "calls" | "earnings_correlation" | "saving" | "backtest";
export const analysisSteps: readonly AnalysisStep[] = ["bars", "calls", "earnings_correlation", "saving", "backtest"];

/** The values the figures depend on: the analysis backtest's account and pot, and the lab's v4 values. */
export interface AnalysisFigureValues {
  /** The analysis backtest's starting account: the lab's default, or a trial's starting value. */
  accountDollars: number;
  /** The one ticker's pot: the account × potShareOfAccount. */
  potDollars: number;
  /** The pot's share of the account with one ticker: its allocation of 100% and the excess allowance (1.2 at 20%). */
  potShareOfAccount: number;
  /** The first position's share of the pot (firstPositionPct ÷ 100: 0.8). */
  firstPositionShare: number;
  v4: BacktestVolFarmerV4Settings;
}

/** F1: the whole weeks with an expiry day, and the month steady weeklies start in. */
export interface AnalysisExpiryWeeks {
  /** Complete file days whose 10:00 quotes list a Call expiring that day. */
  expiryDays: number;
  wholeWeeks: number;
  weeksWithExpiryDay: number;
  /** Weeks by the year of their last session; expiry days by their own year. */
  byYear: Record<string, { expiryDays: number; wholeWeeks: number; weeksWithExpiryDay: number }>;
  /** "2020-01"; null when no month starts a run of months with an expiry in 90% of their whole weeks. */
  steadyWeekliesFrom: string | null;
  /** The analysis backtest's first day: the first complete day of that month, else the file's first. */
  backtestStartDate: string;
}

/** F5 over every expiry day, F4 over the last 12 months'. */
export interface AnalysisSameDayCalls {
  expiryDays: number;
  /** Expiry days with a Call v4 could sell. */
  daysWithCall: number;
  byYear: Record<string, { expiryDays: number; daysWithCall: number }>;
  /** Expiry days without a 10:00 price (not scanned). */
  daysWithoutPrice: number;
  /** Expiry days with a price and no Call v4 could sell. */
  daysWithNoCall: string[];
  lastTwelveMonths: { fromDate: string; expiryDays: number; daysWithCall: number; largestPotDollars: number | null };
  scanSeconds: number;
}

/** F2–F4 over the last 12 months, at the analysis's pot. */
export interface AnalysisSize {
  fromDate: string;
  toDate: string;
  highestPriceAsTraded: number | null;
  highestOn: string | null;
  smallestPotDollars: number | null;
  smallestAccountDollars: number | null;
  accountDollars: number;
  potDollars: number;
  targetReached: ReturnType<typeof targetReachedOverDays>;
  largestPotByCallVolume: { potDollars: number | null; expiryDays: number };
}

/** F10: the last day's 10:00 look replayed as v4 would open a cycle on it. */
export interface AnalysisToday {
  date: string;
  isExpiryDay: boolean;
  priceAsTraded: number | null;
  accountDollars: number;
  potDollars: number;
  lots: number;
  sharesDollars: number;
  targetDollars: number;
  shareOfTarget: number | null;
  /** F5's pick; null on a day without a Call expiring at its close, or when none passes. */
  call: SameDayCall | null;
  /** The first position's break-even after buying the lots and selling the Call (B-E1); null without lots. */
  firstBreakEven: number | null;
  band: { floorDollars: number; topDollars: number; oneMoreLotDollars: number } | null;
  /** Whether v4 would sell Puts today: on an expiry day, when the best Call pays under putsStartCallYieldPct a year. */
  putsNow: boolean;
  putsStartCallYieldPct: number;
  /** The Step from the previous session's IV, and the highest strike a Put would be sold at (B-E1 less the Step); null without an IV. */
  step: { stepPct: number; impliedVolatility: number; ivDate: string } | null;
  putStrikeCap: number | null;
}

/** The Vol Farmer v4 profile's figures (F9, F7's counts, F12–F16), every bar of the file. */
export interface AnalysisStockProfile {
  steps: StepStatistics & { now: (StepOnDay & { date: string }) | null };
  falls: { count: number; perYear: number | null; reachedTwoSteps: number; backWithinAYear: number; medianDaysDown: number | null; medianDaysBack: number | null };
  trend: AnalysisTrendSplit;
  market: { all: AnalysisMarketFit; sinceBacktest: AnalysisMarketFit | null; spyDownDays: AnalysisMarketFit; spyUpDays: AnalysisMarketFit } | null;
  gaps: AnalysisOpeningGaps;
  weeklySkew: ReturnType<typeof weeklySkew>;
  ivRange: ReturnType<typeof impliedVolatilityRange>;
  /** The last bar's IV and its percentile over the last 252 bars. */
  ivNow: { date: string; impliedVolatility: number; percentile: number | null } | null;
}

export interface AnalysisFigures {
  formulasVersion: number;
  symbol: string;
  /** The first and last complete option day, and the last daily bar the figures read. */
  optionFirstDate: string;
  optionLastDate: string;
  barsLastDate: string | null;
  /** IBKR daily bars, split-adjusted: [date, open, high, low, close, implied volatility]. */
  bars: [string, number, number, number, number, number | null][];
  /** 21-day Yang-Zhang, one per bar (null until 21 sessions). */
  yangZhang21: (number | null)[];
  /** F9's stand-in, one per bar: the 63-day Yang-Zhang on a bar without an IV; null on bars with one (the IV pane's dashed line). */
  realisedStandIn: (number | null)[];
  /** IV Percentile, one per bar: added when the figures are read (analysisStore.ts), not stored. */
  barIndicators?: AnalysisBarIndicators;
  volatility: {
    impliedNow: number | null;
    yangZhang21Now: number | null;
    yangZhang63Now: number | null;
    impliedVersusRealised: { all: AnalysisIvPremiumStats; lastYear: AnalysisIvPremiumStats; byYear: Record<string, AnalysisIvPremiumStats> };
  };
  maxDrawdown: Record<AnalysisPriceRange, AnalysisMaxDrawdown | null>;
  expiryWeeks: AnalysisExpiryWeeks;
  sameDayCalls: AnalysisSameDayCalls;
  size: AnalysisSize;
  today: AnalysisToday;
  /** F7 over every bar, oldest first (v4's account in each, F11, is the analysis backtest's). */
  falls: FallOfAStep[];
  stockProfile: AnalysisStockProfile;
  /** The 10-15 sheet's profile (CAGR, R², swings, variance ratio) over every bar and the last two years. */
  profile: { all: AnalysisProfile | null; twoYear: AnalysisProfile | null };
  /** Options volume and open interest from the file (analysisOptionActivity.ts); null when the file can't be read. */
  optionActivity: AnalysisOptionActivity | null;
  earnings: AnalysisEarningsSummary & { exDividendDates: string[]; hasTickerRow: boolean };
  correlation: { rows: AnalysisCorrelationRow[]; skipped: Record<string, string>; spySource: "file" | "database" | null };
  dataQuality: AnalysisDataQuality;
}

export interface AnalysisDataQuality {
  completeDays: number;
  firstDate: string | null;
  lastDate: string | null;
  weekdays: number;
  /** Days the downloader stored as no_data (market holidays) inside the range. */
  holidays: number;
  missingWeekdays: number;
  daysWithIssues: number;
  unavailableDays: number;
  intradayDays: number | null;
  quoteRowsPerDay: { min: number | null; max: number | null; lastDay: number | null };
  /** Complete days whose 10:00 quotes have no ask above zero. */
  daysWithEveryQuoteAtZero: number;
  schemaVersion: string | null;
  maxDte: string | null;
  barsFetchedAt: string | null;
  bars: { count: number; firstDate: string | null; lastDate: string | null; source: "file" | "database" | null };
  impliedVolatility: { count: number; firstDate: string | null };
  tenOclockBars: number | null;
  splits: SplitSchedule["segments"] | null;
  barChecks: AnalysisBarChecks;
  sizeBytes: number;
}

/** The figures the data file gives without the scan of its expiry days: what the Analyse window shows before a ticker's first analysis. */
export type AnalysisFileFigures = Omit<AnalysisFigures, "sameDayCalls" | "size" | "today">;

export interface AnalysisFigureProgress {
  step: AnalysisStep;
  done: number;
  total: number;
}

const addCalendarDays = (dateIso: string, days: number) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const yearsBefore = (dateIso: string, years: number) => `${Number(dateIso.slice(0, 4)) - years}${dateIso.slice(4)}`;

/** The symbol's IBKR daily bars as a session reads them: the file's, else the local DB's; from its business change, if any (tickerBusinessChanges.ts). */
export async function loadDailyBarsOf(symbol: string, connection: Knex): Promise<{ bars: StoredDailyBar[]; source: "file" | "database" | null }> {
  const currentBusinessFrom = currentBusinessFromOf(symbol);
  const database = openBacktestDataFileReadOnly(symbol);
  if (database) {
    try {
      const fileBars = readFileDailyBars(database);
      if (fileBars && fileBars.length > 0) return { bars: rowsFrom(fileBars, currentBusinessFrom), source: "file" };
    } finally {
      database.close();
    }
  }
  const ticker: { id: string } | undefined = await connection("tickers").where({ symbol }).first("id");
  if (!ticker) return { bars: [], source: null };
  const history = await loadBacktestBarHistory(ticker.id, connection);
  return { bars: rowsFrom(history.rows, currentBusinessFrom), source: history.rows.length > 0 ? "database" : null };
}

/** What the file says about itself, tolerating files written before a table existed. */
function readFileQuality(symbol: string, firstDate: string | null, lastDate: string | null) {
  const database = openBacktestDataFileReadOnly(symbol)!;
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    const holidays = firstDate && lastDate ? Number((database.prepare("SELECT count(*) AS count FROM days WHERE status = 'no_data' AND trading_date BETWEEN ? AND ?").get(firstDate, lastDate) as { count: number }).count) : 0;
    const rows = database.prepare("SELECT min(quote_rows) AS min, max(quote_rows) AS max FROM days WHERE status = 'complete' AND trading_date >= ?").get(firstDate ?? "0000-01-01") as { min: number | null; max: number | null };
    const lastDay = lastDate ? ((database.prepare("SELECT quote_rows AS rows FROM days WHERE trading_date = ?").get(lastDate) as { rows: number | null } | undefined)?.rows ?? null) : null;
    const meta = tables.has("meta") ? new Map((database.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((row) => [row.key, row.value])) : new Map<string, string>();
    const tenOclockBars = tables.has("ibkr_intraday_bars") ? Number((database.prepare("SELECT count(*) AS count FROM ibkr_intraday_bars WHERE start_minutes_et = 570").get() as { count: number }).count) : null;
    return { holidays, quoteRowsPerDay: { min: rows.min, max: rows.max, lastDay }, schemaVersion: meta.get("schema_version") ?? null, maxDte: meta.get("max_dte") ?? null, barsFetchedAt: meta.get("ibkr_bars_fetched_at") ?? null, tenOclockBars };
  } finally {
    database.close();
  }
}

function fileSizeBytes(symbol: string): number {
  const filePath = backtestDataFilePath(symbol);
  return statSync(filePath).size + (existsSync(`${filePath}-wal`) ? statSync(`${filePath}-wal`).size : 0);
}

const weekdaysBetween = (fromIso: string, toIso: string) => {
  let count = 0;
  for (let day = fromIso; day <= toIso; day = addCalendarDays(day, 1)) if (![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) count++;
  return count;
};

/** The ticker's earnings reports and ex-dividend dates (ticker_calendar_events); hasTickerRow false when the symbol has no ticker row. */
async function loadCalendarEvents(symbol: string, connection: Knex): Promise<{ hasTickerRow: boolean; calendarChecksApply: boolean; earnings: { date: string; afterClose: boolean | null; eventTime: string | null }[]; exDividendDates: string[] }> {
  const ticker: { id: string; sector: string | null; tradingview_ticker: string | null } | undefined = await connection("tickers").where({ symbol }).first("id", connection.raw("NULLIF(sector, '') as sector"), "tradingview_ticker");
  if (!ticker) return { hasTickerRow: false, calendarChecksApply: false, earnings: [], exDividendDates: [] };
  const rows: { event_type: string; event_date: string; event_time: string | null }[] = await connection("ticker_calendar_events")
    .where({ ticker_id: ticker.id })
    .whereIn("event_type", ["earnings", "ex_dividend"])
    .orderBy("event_date")
    .select("event_type", connection.raw("event_date::text as event_date"), "event_time");
  return {
    hasTickerRow: true,
    calendarChecksApply: tickerCalendarProfile(ticker).calendarChecksApply,
    // event_time "1": after the close; "-1": before the open; "0" or none: not said.
    earnings: rows.filter((row) => row.event_type === "earnings").map((row) => ({ date: row.event_date, afterClose: row.event_time === "1" ? true : row.event_time === "-1" ? false : null, eventTime: row.event_time })),
    exDividendDates: rows.filter((row) => row.event_type === "ex_dividend").map((row) => row.event_date),
  };
}

/**
 * What every figure reads: the file's complete days and its expiry days, the days whose 10:00 quotes are all at zero, the
 * daily bars, the split schedule, the T-bill rates, the 10:00 prices and the ticker's calendar.
 */
async function loadAnalysisInputs(symbol: string, connection: Knex) {
  const dataDirectory = requireBacktestDataDirectory();
  const contents = readBacktestDataFileContents(symbol);
  if (!contents || !contents.firstDate || !contents.lastDate) throw new Error(`The ${symbol} data file has no complete days yet.`);
  const file = BacktestSymbolFile.open(symbol);
  let completeDays: string[];
  let expiryDays: Set<string>;
  let daysWithEveryQuoteAtZero = 0;
  try {
    completeDays = file.loadDays().filter((day) => day.status === "complete").map((day) => day.tradingDate);
    expiryDays = expiryDaysAmong(file, completeDays);
    for (const date of completeDays) {
      const quotes = file.loadQuotes(date);
      if (quotes.length > 0 && quotes.every((quote) => !(quote.ask !== null && quote.ask > 0))) daysWithEveryQuoteAtZero += 1;
    }
  } finally {
    file.close();
  }
  const { bars: dailyBars, source: barsSource } = await loadDailyBarsOf(symbol, connection);
  const ohlcv = toOhlcvBars(dailyBars);
  const closes = ohlcv.map((bar) => ({ tradingDate: bar.tradingDate, close: bar.close }));
  const schedule = (await refreshSplitScheduleForSymbol(symbol, connection)) ?? readSplitScheduleCache(dataDirectory, symbol)?.schedule ?? null;
  const rates = await loadTreasuryBillRates(dataDirectory, completeDays[0]!, completeDays.at(-1)!);
  const database = openBacktestDataFileReadOnly(symbol)!;
  const intradayPrices = (() => {
    try {
      return readFileIntradayPrices(database, completeDays[0]!, completeDays.at(-1)!);
    } finally {
      database.close();
    }
  })();
  if (!intradayPrices) throw new Error(`The ${symbol} data file has no IBKR 30-minute bars: the 10:00 prices cannot be read. Its download writes them.`);
  const calendar = await loadCalendarEvents(symbol, connection);
  return { contents: { ...contents, firstDate: contents.firstDate, lastDate: contents.lastDate }, completeDays, expiryDays, daysWithEveryQuoteAtZero, dailyBars, barsSource, ohlcv, closes, schedule, rates, intradayPrices, calendar };
}

type AnalysisInputs = Awaited<ReturnType<typeof loadAnalysisInputs>>;

/** F1 over the file's complete days. */
function expiryWeeksOf(completeDays: readonly string[], expiryDays: ReadonlySet<string>): AnalysisExpiryWeeks {
  const weeks = wholeWeeksBetween(completeDays, expiryDays, completeDays[0]!, completeDays.at(-1)!);
  const byYear: AnalysisExpiryWeeks["byYear"] = {};
  for (const [year, count] of expiryWeeksBy(weeks, "year")) byYear[year] = { expiryDays: 0, ...count };
  for (const date of expiryDays) (byYear[date.slice(0, 4)] ??= { expiryDays: 0, wholeWeeks: 0, weeksWithExpiryDay: 0 }).expiryDays += 1;
  const steadyWeekliesFrom = steadyWeekliesStartMonth(weeks);
  const backtestStartDate = (steadyWeekliesFrom === null ? null : completeDays.find((date) => date.startsWith(steadyWeekliesFrom))) ?? completeDays[0]!;
  return { expiryDays: expiryDays.size, ...countExpiryWeeks(weeks), byYear: Object.fromEntries(Object.entries(byYear).sort(([a], [b]) => a.localeCompare(b))), steadyWeekliesFrom, backtestStartDate };
}

/** F9 and F7 over every bar, and the profile's other figures (F12–F16). */
function stockProfileOf(ohlcv: AnalysisInputs["ohlcv"], spyCloses: readonly { tradingDate: string; close: number }[] | null, backtestStartDate: string) {
  const steps = stepsOfBars(ohlcv);
  const statistics = stepStatistics(steps);
  const closes = ohlcv.map((bar) => ({ tradingDate: bar.tradingDate, close: bar.close }));
  const falls = statistics.median === null ? [] : fallsOfAStep(closes, steps, statistics.median);
  const lastIndex = ohlcv.length - 1;
  const lastStep = lastIndex >= 0 ? steps[lastIndex] : null;
  const indicators = barIndicatorsOf(ohlcv);
  const lastBar = ohlcv.at(-1);
  const years = ohlcv.length < 2 ? null : (Date.parse(`${ohlcv.at(-1)!.tradingDate}T00:00:00Z`) - Date.parse(`${ohlcv[0]!.tradingDate}T00:00:00Z`)) / (365.25 * 86_400_000);
  const profile: AnalysisStockProfile = {
    steps: { ...statistics, now: lastStep && lastBar ? { ...lastStep, date: lastBar.tradingDate } : null },
    falls: {
      count: falls.length,
      perYear: years ? falls.length / years : null,
      reachedTwoSteps: falls.filter((fall) => fall.steps >= 2).length,
      backWithinAYear: falls.filter((fall) => fall.daysBack !== null && fall.daysBack <= 365).length,
      medianDaysDown: median(falls.map((fall) => fall.daysDown)),
      medianDaysBack: median(falls.flatMap((fall) => (fall.daysBack === null ? [] : [fall.daysBack]))),
    },
    trend: trendSplit(ohlcv.map((bar) => bar.close)),
    market: spyCloses === null ? null : marketFits(closes, spyCloses, backtestStartDate),
    gaps: openingGaps(ohlcv),
    weeklySkew: weeklySkew(closes),
    ivRange: impliedVolatilityRange(ohlcv),
    ivNow: lastBar && lastBar.impliedVolatility !== null && lastBar.impliedVolatility > 0 ? { date: lastBar.tradingDate, impliedVolatility: lastBar.impliedVolatility, percentile: indicators.ivPercentile.at(-1)?.[0] ?? null } : null,
  };
  const realisedStandIn = steps.map((entry) => (entry?.source === "realised" ? entry.volatility : null));
  return { falls, profile, realisedStandIn };
}

/** Every figure that needs no scan of the expiry days. */
async function fileFiguresOf(symbol: string, inputs: AnalysisInputs, connection: Knex): Promise<AnalysisFileFigures> {
  const { contents, completeDays, expiryDays, daysWithEveryQuoteAtZero, barsSource, ohlcv, closes, schedule, intradayPrices, calendar } = inputs;
  const activityDatabase = openBacktestDataFileReadOnly(symbol);
  let optionActivity: AnalysisOptionActivity | null = null;
  try {
    if (activityDatabase) optionActivity = computeOptionActivity(activityDatabase, completeDays.at(-1)!, new Map());
  } finally {
    activityDatabase?.close();
  }

  const firstOptionDay = completeDays[0]!;
  const lastBarDate = closes.at(-1)?.tradingDate ?? null;
  const pastReports = calendar.earnings.filter((event) => event.date >= firstOptionDay && lastBarDate !== null && event.date <= lastBarDate);
  const nextReport = calendar.earnings.find((event) => event.date > (lastBarDate ?? completeDays.at(-1)!)) ?? null;
  const completeDaySet = new Set(completeDays);
  const reports: AnalysisReport[] = [];
  const quoteFile = BacktestSymbolFile.open(symbol);
  try {
    for (const event of pastReports) {
      const quoteDate = [...closes].reverse().find((bar) => bar.tradingDate < event.date)?.tradingDate ?? null;
      const price = quoteDate ? tenOclockPriceAsTraded(quoteDate, intradayPrices, schedule) : null;
      const straddle = quoteDate && price !== null && completeDaySet.has(quoteDate) ? impliedReportMove(quoteFile.loadQuotes(quoteDate), quoteDate, event.date, price) : null;
      reports.push({
        date: event.date,
        move: reportMove(closes, event.date),
        impliedMove: straddle?.impliedMove ?? null,
        straddle: straddle && { quoteDate: straddle.quoteDate, expiry: straddle.expiry, strike: straddle.strike, callMid: straddle.callMid, putMid: straddle.putMid, price: straddle.price },
      });
    }
  } finally {
    quoteFile.close();
  }
  const earnings = summarizeEarnings(reports, nextReport);

  const others: Record<string, { tradingDate: string; close: number }[]> = {};
  const skipped: Record<string, string> = {};
  let spySource: "file" | "database" | null = null;
  for (const other of new Set([...listBacktestDataFileSymbols(), "SPY"])) {
    if (other === symbol) continue;
    const loaded = await loadDailyBarsOf(other, connection);
    const otherCloses = toOhlcvBars(loaded.bars).map((bar) => ({ tradingDate: bar.tradingDate, close: bar.close }));
    if (otherCloses.length < 30) {
      skipped[other] = "no stock prices";
      continue;
    }
    if (other === "SPY") spySource = loaded.source;
    others[other] = otherCloses;
  }
  const spyCloses = symbol === "SPY" ? closes : (others.SPY ?? null);
  const reportSessions = reportSessionDates(closes, pastReports.map((event) => event.date));
  const lastClose = closes.at(-1)?.tradingDate ?? null;
  const expiryWeeks = expiryWeeksOf(completeDays, expiryDays);
  const { falls, profile, realisedStandIn } = stockProfileOf(ohlcv, spyCloses, expiryWeeks.backtestStartDate);
  const quality = readFileQuality(symbol, contents.firstDate, contents.lastDate);
  const impliedDays = ohlcv.filter((bar) => bar.impliedVolatility !== null);
  const yz = (window: number) => {
    const result = computeYangZhangVolatility(ohlcv, window, ohlcv.length);
    return result.available ? result.annualizedVolatility : null;
  };

  return {
    formulasVersion: analysisFormulasVersion,
    symbol,
    optionFirstDate: firstOptionDay,
    optionLastDate: completeDays.at(-1)!,
    barsLastDate: lastBarDate,
    bars: ohlcv.map((bar) => [bar.tradingDate, bar.open, bar.high, bar.low, bar.close, bar.impliedVolatility]),
    yangZhang21: yangZhangSeries(ohlcv, 21),
    realisedStandIn,
    volatility: { impliedNow: ohlcv.at(-1)?.impliedVolatility ?? null, yangZhang21Now: yz(21), yangZhang63Now: yz(63), impliedVersusRealised: impliedVersusRealised(ohlcv) },
    maxDrawdown: maxDrawdownByRange(closes),
    expiryWeeks,
    falls,
    stockProfile: profile,
    profile: { all: stockProfile(ohlcv, null, reportSessions), twoYear: lastClose ? stockProfile(ohlcv, yearsBefore(lastClose, 2), reportSessions) : null },
    optionActivity,
    earnings: { ...earnings, exDividendDates: calendar.exDividendDates, hasTickerRow: calendar.hasTickerRow },
    correlation: { rows: correlationRows(closes, others), skipped, spySource },
    dataQuality: {
      completeDays: contents.completeDays,
      firstDate: contents.firstDate,
      lastDate: contents.lastDate,
      weekdays: weekdaysBetween(contents.firstDate, contents.lastDate),
      holidays: quality.holidays,
      missingWeekdays: contents.missingWeekdays,
      daysWithIssues: contents.daysWithIssues,
      unavailableDays: contents.unavailableDays,
      intradayDays: contents.intradayDays,
      quoteRowsPerDay: quality.quoteRowsPerDay,
      daysWithEveryQuoteAtZero,
      schemaVersion: quality.schemaVersion,
      maxDte: quality.maxDte,
      barsFetchedAt: quality.barsFetchedAt,
      bars: { count: ohlcv.length, firstDate: ohlcv[0]?.tradingDate ?? null, lastDate: lastBarDate, source: barsSource },
      impliedVolatility: { count: impliedDays.length, firstDate: impliedDays[0]?.tradingDate ?? null },
      tenOclockBars: quality.tenOclockBars,
      splits: schedule?.segments ?? null,
      barChecks: barChecks(closes),
      sizeBytes: fileSizeBytes(symbol),
    },
  };
}

/** F5 by year and F4 over the last 12 months, from the scan's rows. */
function sameDayCallsOf(rows: readonly SameDayCallDay[], lastDate: string, scanSeconds: number, firstPositionShare: number): AnalysisSameDayCalls {
  const priced = rows.filter((row) => row.spot !== null);
  const byYear: AnalysisSameDayCalls["byYear"] = {};
  for (const row of rows) {
    const entry = (byYear[row.date.slice(0, 4)] ??= { expiryDays: 0, daysWithCall: 0 });
    entry.expiryDays += 1;
    if (row.best !== null) entry.daysWithCall += 1;
  }
  const fromDate = sameDayMonthsBefore(lastDate, 12);
  const lastYear = rows.filter((row) => row.date > fromDate);
  const dayPots = lastYear.flatMap((row) => (row.spot === null ? [] : [largestPotOfDay(row.mostLotsByVolume, row.spot, firstPositionShare)]));
  return {
    expiryDays: rows.length,
    daysWithCall: rows.filter((row) => row.best !== null).length,
    byYear,
    daysWithoutPrice: rows.length - priced.length,
    daysWithNoCall: priced.filter((row) => row.best === null).map((row) => row.date),
    lastTwelveMonths: { fromDate, expiryDays: lastYear.length, daysWithCall: lastYear.filter((row) => row.best !== null).length, largestPotDollars: potFittingDayShare(dayPots) },
    scanSeconds,
  };
}

/** F2–F4 over the last 12 months of complete days. */
function sizeOf(inputs: AnalysisInputs, values: AnalysisFigureValues, sameDayCalls: AnalysisSameDayCalls): AnalysisSize {
  const toDate = inputs.completeDays.at(-1)!;
  const fromDate = sameDayMonthsBefore(toDate, 12);
  const prices = inputs.completeDays.filter((date) => date > fromDate).flatMap((date) => {
    const price = tenOclockPriceAsTraded(date, inputs.intradayPrices, inputs.schedule);
    return price === null ? [] : [{ date, price }];
  });
  const highest = prices.reduce<{ date: string; price: number } | null>((top, entry) => (top === null || entry.price > top.price ? entry : top), null);
  const smallest = highest === null ? null : smallestPotFor(highest.price, values.firstPositionShare, values.potShareOfAccount);
  return {
    fromDate,
    toDate,
    highestPriceAsTraded: highest?.price ?? null,
    highestOn: highest?.date ?? null,
    smallestPotDollars: smallest?.potDollars ?? null,
    smallestAccountDollars: smallest?.accountDollars ?? null,
    accountDollars: values.accountDollars,
    potDollars: values.potDollars,
    targetReached: targetReachedOverDays(values.potDollars, prices.map((entry) => entry.price), values.firstPositionShare),
    largestPotByCallVolume: { potDollars: sameDayCalls.lastTwelveMonths.largestPotDollars, expiryDays: sameDayCalls.lastTwelveMonths.expiryDays },
  };
}

/** F10: the last day's look replayed as v4 opens a cycle: the lots, the Call, B-E1, the band, and the Put level a Step under B-E1. */
function todayOf(inputs: AnalysisInputs, values: AnalysisFigureValues, lastDayRow: SameDayCallDay | null): AnalysisToday {
  const date = inputs.completeDays.at(-1)!;
  const price = tenOclockPriceAsTraded(date, inputs.intradayPrices, inputs.schedule);
  const isExpiryDay = inputs.expiryDays.has(date);
  const call = isExpiryDay && lastDayRow?.date === date ? lastDayRow.best : null;
  const reached = price === null ? null : targetReachedAt(values.potDollars, price, values.firstPositionShare);
  const lots = reached?.lots ?? 0;
  const shares = lots * sharesPerLot;
  let firstBreakEven: number | null = null;
  if (price !== null && lots > 0) {
    const costPerShare = price + stockCommissionDollars(shares) / shares;
    const premiums = call === null ? [] : [{ legId: "today", dollars: volFarmerV4CallPremiumShare(call.fillPrice, lots, lots, optionCommissionDollars(lots)), shares }];
    firstBreakEven = volFarmerV4BreakEven({ shares, costPerShare, premiums });
  }
  // The engine's Step at a look: the previous session's IV (the bar before the last day's).
  const previousBar = [...inputs.ohlcv].reverse().find((bar) => bar.tradingDate < date) ?? null;
  const previousIv = previousBar && previousBar.impliedVolatility !== null && previousBar.impliedVolatility > 0 ? previousBar.impliedVolatility : null;
  const step = previousIv === null || previousBar === null ? null : { ...volFarmerV4ImpliedMoveStep(previousIv), impliedVolatility: previousIv, ivDate: previousBar.tradingDate };
  const putsStartCallYieldPct = values.v4.putsStartCallYieldPct;
  const band = price === null ? null : bandAt(values.potDollars, price, values.firstPositionShare, values.v4.rebalanceBandPct);
  return {
    date,
    isExpiryDay,
    priceAsTraded: price,
    accountDollars: values.accountDollars,
    potDollars: values.potDollars,
    lots,
    sharesDollars: reached?.sharesDollars ?? 0,
    targetDollars: reached?.targetDollars ?? values.potDollars * values.firstPositionShare,
    shareOfTarget: reached?.shareOfTarget ?? null,
    call,
    firstBreakEven,
    band: band && { floorDollars: band.floorDollars, topDollars: band.topDollars, oneMoreLotDollars: band.oneMoreLotDollars },
    putsNow: isExpiryDay && (call?.premiumYield ?? 0) < putsStartCallYieldPct / 100,
    putsStartCallYieldPct,
    step: step && { stepPct: step.stepPct, impliedVolatility: step.impliedVolatility, ivDate: step.ivDate },
    putStrikeCap: step === null || firstBreakEven === null ? null : volFarmerV4PutStrikeCapOf(firstBreakEven, step.stepPct),
  };
}

/** The figures the data file gives without an analysis (no scan, no backtest): the Analyse window before a ticker's first analysis. Reads the files read-only. */
export async function computeAnalysisFileFigures(input: { symbol: string; connection?: Knex }): Promise<AnalysisFileFigures> {
  const connection = input.connection ?? db;
  return fileFiguresOf(input.symbol, await loadAnalysisInputs(input.symbol, connection), connection);
}

/** Every figure but the analysis backtest's. Reads the files read-only; `onProgress` reports each step and the scan's days. */
export async function computeAnalysisFigures(input: { symbol: string; values: AnalysisFigureValues; onProgress?: (progress: AnalysisFigureProgress) => void; connection?: Knex }): Promise<AnalysisFigures> {
  const { symbol, values } = input;
  const connection = input.connection ?? db;
  const report = (step: AnalysisStep, done = 0, total = 0) => input.onProgress?.({ step, done, total });

  report("bars");
  const inputs = await loadAnalysisInputs(symbol, connection);
  const { completeDays, expiryDays, intradayPrices, schedule, rates } = inputs;
  const scannedDays = completeDays.filter((date) => expiryDays.has(date));

  report("calls", 0, scannedDays.length);
  // The sessions its premium yields count (tradingSessionsHeld.ts): the file's complete days, then the market calendar for the 45 days after them.
  const afterLastDay = addCalendarDays(completeDays.at(-1)!, 1);
  const openDays = [...completeDays, ...openDaysFromCalendarRows(afterLastDay, addCalendarDays(afterLastDay, 44), await loadMarketCalendarRowsFrom(afterLastDay, connection))];
  const scanStarted = Date.now();
  const rows = await scanSameDayCallsInParallel({
    filePath: backtestDataFilePath(symbol),
    days: buildSameDayCallScanDays({ completeDays, scannedDays, intradayPrices, schedule, rates }),
    settings: { callMinAbsDelta: values.v4.callMinAbsDelta, callMaxAbsDelta: values.v4.callMaxAbsDelta, maxSpreadPctOfMid: values.v4.maxSpreadPctOfMid },
    openDays,
    onChunkDone: (daysDone) => report("calls", daysDone, scannedDays.length),
  });
  const sameDayCalls = sameDayCallsOf(rows, completeDays.at(-1)!, (Date.now() - scanStarted) / 1000, values.firstPositionShare);

  report("earnings_correlation");
  const fileFigures = await fileFiguresOf(symbol, inputs, connection);
  return { ...fileFigures, sameDayCalls, size: sizeOf(inputs, values, sameDayCalls), today: todayOf(inputs, values, rows.at(-1) ?? null) };
}
