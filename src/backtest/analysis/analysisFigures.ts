import { statSync, existsSync } from "node:fs";
import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { computeYangZhangVolatility } from "../../lib/realizedVolatility.js";
import { tickerCalendarProfile } from "../../lib/tickerCalendarRelevance.js";
import { backtestDataFilePath, requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { readFileDailyBars, readFileIntradayPrices } from "../backtestFileStockBars.js";
import { listBacktestDataFileSymbols, readBacktestDataFileContents } from "../dataFileSummary.js";
import { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { loadBacktestBarHistory, type StoredDailyBar } from "../engine/backtestBarHistory.js";
import { readSplitScheduleCache, refreshSplitScheduleForSymbol, type SplitSchedule } from "../engine/splitFactors.js";
import { loadTreasuryBillRates } from "../engine/treasuryBillRates.js";
import { ladderShock } from "../engine/backtestBaselineLadder.js";
import type { BacktestBaselineSettings } from "../backtestTypes.js";
import { summarizeChainScan, type AnalysisChainSummary, type ChainMapContract, type ChainScanDayRow } from "./analysisChainScan.js";
import { scanChainDaysInParallel } from "./analysisChainScanPool.js";
import { buildChainScanDayInputs, tenOclockPriceAsTraded } from "./analysisDayInputs.js";
import { correlationRows, impliedReportMove, reportMove, reportSessionDates, summarizeEarnings, type AnalysisCorrelationRow, type AnalysisEarningsSummary, type AnalysisReport } from "./analysisEarningsAndCorrelation.js";
import {
  barChecks,
  impliedVersusRealised,
  maxDrawdownByRange,
  maxDrawdownOf,
  stockProfile,
  toOhlcvBars,
  yangZhangSeries,
  type AnalysisBarChecks,
  type AnalysisIvPremiumStats,
  type AnalysisMaxDrawdown,
  type AnalysisPriceRange,
  type AnalysisProfile,
} from "./analysisPriceFigures.js";

// The Analyse window's figures for one ticker, from its data file, its IBKR daily bars, its earnings and the other data
// files (for correlation), at the values given. Everything but the analysis backtest's figures (analysisBacktestFigures.ts).

/** Bumped when a formula or the figures' shape changes: a stored analysis with an older version shows as such. */
export const analysisFormulasVersion = 5;

export type AnalysisStep = "bars" | "chains" | "earnings_correlation" | "saving" | "backtest" | "summary";
export const analysisSteps: readonly AnalysisStep[] = ["bars", "chains", "earnings_correlation", "saving", "backtest", "summary"];

/** The values the figures depend on: the ticker's effective baseline values and its pot. */
export interface AnalysisFigureValues {
  potDollars: number;
  baseline: BacktestBaselineSettings;
  /** trading.spreadCostChargedPct ÷ 100: the share of the half-spread a fill gives up. */
  spreadShareCharged: number;
}

export interface AnalysisFigures {
  formulasVersion: number;
  symbol: string;
  /** The last complete option day and the last daily bar the figures read. */
  optionLastDate: string;
  barsLastDate: string | null;
  /** IBKR daily bars, split-adjusted: [date, open, high, low, close, implied volatility]. */
  bars: [string, number, number, number, number, number | null][];
  /** 21-day Yang-Zhang, one per bar (null until 21 sessions). */
  yangZhang21: (number | null)[];
  volatility: {
    impliedNow: number | null;
    yangZhang21Now: number | null;
    yangZhang63Now: number | null;
    impliedVersusRealised: { all: AnalysisIvPremiumStats; lastYear: AnalysisIvPremiumStats; byYear: Record<string, AnalysisIvPremiumStats> };
  };
  maxDrawdown: Record<AnalysisPriceRange, AnalysisMaxDrawdown | null>;
  /** The shock the rule gives a cycle starting the next weekday, with what it read. */
  shock: { startDate: string; windowFrom: string; closes: number; maxDrawdown: number | null; shock: number; rule: BacktestBaselineSettings["ladderShock"] };
  chains: AnalysisChainSummary & {
    lastDay: { date: string; spot: number | null; shock: number; cap: number | null; bestCappedPut: ChainScanDayRow["bestCappedPut"]; passingCalls: number; passingPuts: number; passingCappedPuts: number } | null;
    /** The last day's chain, priced at the mid: the chain yield map. */
    chainMap: ChainMapContract[];
    scanSeconds: number;
  };
  /**
   * Each scanned day with a 10:00 price: [date, price as traded, shock, the best capped Put's volume limit, its strike, the
   * best entry Call's volume limit] (the contract fields null when none passed). The window computes the fits and the
   * largest pots from them.
   */
  fitDays: AnalysisFitDayRow[];
  /** True when the lab's volatility-edge filter or Edge Yield ranking applies: the largest pot's contracts were chosen without them. */
  largestPotWithoutModel: boolean;
  earnings: AnalysisEarningsSummary & { exDividendDates: string[]; hasTickerRow: boolean };
  correlation: { rows: AnalysisCorrelationRow[]; skipped: Record<string, string>; spySource: "file" | "database" | null };
  profile: { all: AnalysisProfile | null; twoYear: AnalysisProfile | null };
  dataQuality: AnalysisDataQuality;
}

export type AnalysisFitDayRow = [string, number, number, number | null, number | null, number | null];

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
  schemaVersion: string | null;
  maxDte: string | null;
  barsFetchedAt: string | null;
  bars: { count: number; firstDate: string | null; lastDate: string | null; source: "file" | "database" | null };
  impliedVolatility: { count: number; firstDate: string | null };
  tenOclockBars: number | null;
  splits: SplitSchedule["segments"] | null;
  barChecks: AnalysisBarChecks;
  sizeBytes: number;
  scannedDays: number;
  daysWithoutPrice: number;
  daysWithNothingPassing: string[];
}

export interface AnalysisFigureProgress {
  step: AnalysisStep;
  done: number;
  total: number;
}

const addCalendarDays = (dateIso: string, days: number) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const yearsBefore = (dateIso: string, years: number) => `${Number(dateIso.slice(0, 4)) - years}${dateIso.slice(4)}`;

function nextWeekday(dateIso: string): string {
  let next = addCalendarDays(dateIso, 1);
  while ([0, 6].includes(new Date(`${next}T00:00:00Z`).getUTCDay())) next = addCalendarDays(next, 1);
  return next;
}

/** The symbol's IBKR daily bars as a session reads them: the file's, else the local DB's. */
async function loadDailyBarsOf(symbol: string, connection: Knex): Promise<{ bars: StoredDailyBar[]; source: "file" | "database" | null }> {
  const database = openBacktestDataFileReadOnly(symbol);
  if (database) {
    try {
      const fileBars = readFileDailyBars(database);
      if (fileBars && fileBars.length > 0) return { bars: fileBars, source: "file" };
    } finally {
      database.close();
    }
  }
  const ticker: { id: string } | undefined = await connection("tickers").where({ symbol }).first("id");
  if (!ticker) return { bars: [], source: null };
  const history = await loadBacktestBarHistory(ticker.id, connection);
  return { bars: [...history.rows], source: history.rows.length > 0 ? "database" : null };
}

/** What the file says about itself, tolerating files written before a table existed. */
function readFileQuality(symbol: string, firstDate: string | null, lastDate: string | null) {
  const database = openBacktestDataFileReadOnly(symbol)!;
  try {
    database.exec("PRAGMA busy_timeout = 3000");
    const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
    const holidays = firstDate && lastDate ? Number((database.prepare("SELECT count(*) AS count FROM days WHERE status = 'no_data' AND trading_date BETWEEN ? AND ?").get(firstDate, lastDate) as { count: number }).count) : 0;
    const rows = database.prepare("SELECT min(quote_rows) AS min, max(quote_rows) AS max FROM days WHERE status = 'complete'").get() as { min: number | null; max: number | null };
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

/** Every figure but the analysis backtest's. Reads the files read-only; `onProgress` reports each step and the chain scan's days. */
export async function computeAnalysisFigures(input: { symbol: string; values: AnalysisFigureValues; onProgress?: (progress: AnalysisFigureProgress) => void; connection?: Knex }): Promise<AnalysisFigures> {
  const { symbol, values } = input;
  const connection = input.connection ?? db;
  const report = (step: AnalysisStep, done = 0, total = 0) => input.onProgress?.({ step, done, total });
  const dataDirectory = requireBacktestDataDirectory();

  report("bars");
  const contents = readBacktestDataFileContents(symbol);
  if (!contents || !contents.firstDate || !contents.lastDate) throw new Error(`The ${symbol} data file has no complete days yet.`);
  const file = BacktestSymbolFile.open(symbol);
  let completeDays: string[];
  try {
    completeDays = file.loadDays().filter((day) => day.status === "complete").map((day) => day.tradingDate);
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
  const skipsEarnings = values.baseline.earnings === "skip_spanning" && calendar.calendarChecksApply;

  report("chains", 0, completeDays.length);
  const days = buildChainScanDayInputs({ completeDays, intradayPrices, schedule, rates, dailyBars, shockSettings: values.baseline, earnings: skipsEarnings ? calendar.earnings.map((event) => ({ dateIso: event.date, eventTime: event.eventTime })) : null });
  const scanStarted = Date.now();
  const { rows, chainMap } = await scanChainDaysInParallel({
    filePath: backtestDataFilePath(symbol),
    days,
    settings: { ...values.baseline, spreadShareCharged: values.spreadShareCharged },
    chainMapDate: completeDays.at(-1)!,
    onChunkDone: (daysDone) => report("chains", daysDone, completeDays.length),
  });
  const scanSeconds = (Date.now() - scanStarted) / 1000;
  const summary = summarizeChainScan(rows);
  const last = rows.at(-1) ?? null;
  const passing = (row: ChainScanDayRow, view: "C" | "P" | "Pcap") => Object.values(row.cells[view]).reduce((sum, cell) => sum + (cell?.count ?? 0), 0);

  report("earnings_correlation");
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
  const reportSessions = reportSessionDates(closes, pastReports.map((event) => event.date));
  const lastClose = closes.at(-1)?.tradingDate ?? null;

  const shockStart = nextWeekday(completeDays.at(-1)!);
  const shockWindowFrom = yearsBefore(shockStart, values.baseline.ladderShockLookbackYears);
  const shockWindow = closes.filter((bar) => bar.tradingDate >= shockWindowFrom && bar.tradingDate < shockStart);
  const quality = readFileQuality(symbol, contents.firstDate, contents.lastDate);
  const impliedDays = ohlcv.filter((bar) => bar.impliedVolatility !== null);
  const yz = (window: number) => {
    const result = computeYangZhangVolatility(ohlcv, window, ohlcv.length);
    return result.available ? result.annualizedVolatility : null;
  };

  return {
    formulasVersion: analysisFormulasVersion,
    symbol,
    optionLastDate: completeDays.at(-1)!,
    barsLastDate: lastBarDate,
    bars: ohlcv.map((bar) => [bar.tradingDate, bar.open, bar.high, bar.low, bar.close, bar.impliedVolatility]),
    yangZhang21: yangZhangSeries(ohlcv, 21),
    volatility: { impliedNow: ohlcv.at(-1)?.impliedVolatility ?? null, yangZhang21Now: yz(21), yangZhang63Now: yz(63), impliedVersusRealised: impliedVersusRealised(ohlcv) },
    maxDrawdown: maxDrawdownByRange(closes),
    shock: {
      startDate: shockStart,
      windowFrom: shockWindowFrom,
      closes: shockWindow.length,
      maxDrawdown: maxDrawdownOf(shockWindow)?.depth ?? null,
      shock: ladderShock(values.baseline, closes.map((bar) => ({ date: bar.tradingDate, close: bar.close })), shockStart),
      rule: values.baseline.ladderShock,
    },
    chains: {
      ...summary,
      lastDay: last && { date: last.date, spot: last.spot, shock: last.shock, cap: last.cap, bestCappedPut: last.bestCappedPut, passingCalls: passing(last, "C"), passingPuts: passing(last, "P"), passingCappedPuts: passing(last, "Pcap") },
      chainMap,
      scanSeconds,
    },
    fitDays: rows.filter((row) => row.spot !== null).map((row): AnalysisFitDayRow => [row.date, row.spot!, row.shock, row.largestPotPut?.volumeCap ?? null, row.largestPotPut?.strike ?? null, row.largestPotCall?.volumeCap ?? null]),
    largestPotWithoutModel: values.baseline.volatilityEdgeFilter !== "off" || values.baseline.ranking === "edge_yield",
    earnings: { ...earnings, exDividendDates: calendar.exDividendDates, hasTickerRow: calendar.hasTickerRow },
    correlation: { rows: correlationRows(closes, others), skipped, spySource },
    profile: { all: stockProfile(ohlcv, null, reportSessions), twoYear: lastClose ? stockProfile(ohlcv, yearsBefore(lastClose, 2), reportSessions) : null },
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
      schemaVersion: quality.schemaVersion,
      maxDte: quality.maxDte,
      barsFetchedAt: quality.barsFetchedAt,
      bars: { count: ohlcv.length, firstDate: ohlcv[0]?.tradingDate ?? null, lastDate: lastBarDate, source: barsSource },
      impliedVolatility: { count: impliedDays.length, firstDate: impliedDays[0]?.tradingDate ?? null },
      tenOclockBars: quality.tenOclockBars,
      splits: schedule?.segments ?? null,
      barChecks: barChecks(closes),
      sizeBytes: fileSizeBytes(symbol),
      scannedDays: rows.length - summary.daysWithoutPrice,
      daysWithoutPrice: summary.daysWithoutPrice,
      daysWithNothingPassing: summary.daysWithNothingPassing,
    },
  };
}
