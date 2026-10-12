import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { describeOptionContract, daysToExpiry } from "../../lib/optionContractLabel.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { maximumSpreadFractionOfMid } from "../../lib/impliedVolatilitySurface.js";
import { addCalendarDays } from "../../lib/signalsRoadmap.js";
import { isEtfSector, tickerCalendarProfile } from "../../lib/tickerCalendarRelevance.js";
import type { BacktestSettings, BacktestSettingsOverrides, BacktestTablesMode } from "../backtestTypes.js";
import { normalizeBacktestSymbol, requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { calendarDaysBetween, computeBacktestMetrics, computeDailyReturns, type AccountDay, type ClosedTradeFigures } from "../sessionAnalytics.js";
import { loadBacktestBarHistory, type BacktestBarHistory } from "./backtestBarHistory.js";
import {
  computeCashLockedInPuts,
  computeFreeCash,
  computeInterestDollars,
  computeParityStockPrice,
  markAccountValue,
  openingCashChange,
  positionExposureDollars,
  positionMarkedExposureDollars,
  settlePosition,
  updatePositionMarks,
  type BacktestBook,
  type BacktestPosition,
} from "./backtestBook.js";
import { decideBacktestDay, decisionInstantMs, type BacktestBookView, type BacktestTickerProfile } from "./backtestDayDecision.js";
import { BacktestSymbolFile, type SymbolFileQuote } from "./backtestSymbolFile.js";
import { loadOrInferSplitSchedule, requireSplitFactors, splitFactorOn, type SplitSchedule } from "./splitFactors.js";
import { BacktestTradingCalendar, loadMarketCalendarRowsFrom } from "./backtestTradingCalendar.js";
import { loadTreasuryBillRates, type TreasuryBillRates } from "./treasuryBillRates.js";
import { prepareModelTablesForSession } from "./walkForwardModelTables.js";

// The backtest engine's entry point (docs/backtesting/FORMULAS.md, DATA-FILES.md). Called by the job process
// (scripts/run-backtest-job.ts) for a backtest job. One session = one symbol from its start to its end date, replayed
// one 10:00 ET look per complete day of the symbol's data file:
//   a. settle every position whose expiry is before today, at that expiry day's close (IBKR daily bar)
//   b. credit interest on cash since the previous trading day (DTB3 on or before that day)
//   c. mark the account at 10:00 (option mids, shares at the parity stock price) and record the day
//   d. decide: the live pipeline on the day's quotes (backtestDayDecision.ts), at most one opening sale
//   e. the buy-and-hold baseline: whole shares on the first day, the rest in cash at the same interest

export interface BacktestRunHooks {
  /** Persist progress and a heartbeat (call at least every 10 s). */
  reportProgress(done: number, total: number, label: string): Promise<void>;
  /** True once the screen asked to cancel; the engine then throws BacktestCancelledError. */
  isCancelRequested(): Promise<boolean>;
}

export class BacktestCancelledError extends Error {
  constructor() {
    super("Backtest cancelled.");
    this.name = "BacktestCancelledError";
  }
}

const progressIntervalMs = 5_000;
const cancelCheckIntervalMs = 2_000;
const insertBatchSize = 500;

interface SessionRow {
  id: string;
  symbol: string;
  startDate: string;
  endDate: string;
  startingValue: string;
  tablesMode: BacktestTablesMode;
  settingsSnapshot: BacktestSettings;
  overrides: BacktestSettingsOverrides;
}

export interface SimulatedTrade {
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
  grade: string;
  edgeMargin: number;
  expectedPnlDollars: number;
  calibratedExpectedPnlDollars: number;
  edgeYield: number | null;
  histYield: number | null;
  kellyContracts: number | null;
  stressContracts: number | null;
  settledOn: string | null;
  settlementClose: number | null;
  inTheMoneyAtExpiry: boolean | null;
  pnlDollars: number | null;
}

export interface SimulatedDay {
  tradingDate: string;
  accountValue: number;
  cash: number;
  exposureDollars: number;
  interestDollars: number;
  baselineValue: number;
  baselineExposureDollars: number;
  baselineInterestDollars: number;
  decisionSummary: string;
}

async function loadSessionRow(sessionId: string, connection: Knex): Promise<SessionRow> {
  const row = await connection("backtest_sessions")
    .where({ id: sessionId })
    .first("id", "symbol", connection.raw('start_date::text as "startDate"'), connection.raw('end_date::text as "endDate"'), "starting_value as startingValue", "tables_mode as tablesMode", "settings_snapshot as settingsSnapshot", "overrides");
  if (!row) throw new Error(`Backtest session ${sessionId} not found.`);
  return row as SessionRow;
}

async function loadTickerProfile(symbol: string, connection: Knex): Promise<BacktestTickerProfile> {
  const ticker: { id: string; symbol: string; company_name: string | null; sector: string | null; tradingview_ticker: string | null } | undefined = await connection("tickers").where({ symbol }).first("id", "symbol", "company_name", connection.raw("NULLIF(sector, '') as sector"), "tradingview_ticker");
  if (!ticker) throw new Error(`${symbol} is not in the local tickers table: its daily bars and earnings dates come from there.`);
  const events: { eventType: string; dateIso: string; eventTime: string | null; amount: string | null }[] = await connection("ticker_calendar_events")
    .where({ ticker_id: ticker.id })
    .whereIn("event_type", ["earnings", "ex_dividend"])
    .orderBy("event_date")
    .select("event_type as eventType", connection.raw('event_date::text as "dateIso"'), "event_time as eventTime", "amount");
  const calendarProfile = tickerCalendarProfile(ticker);
  return {
    tickerId: ticker.id,
    symbol: ticker.symbol,
    companyName: ticker.company_name,
    sector: ticker.sector,
    valuationGroup: isEtfSector(ticker.sector) ? "etf" : "stock",
    calendarChecksApply: calendarProfile.calendarChecksApply,
    earningsCalendarResolved: calendarProfile.earningsCalendarResolved,
    earnings: events.filter((event) => event.eventType === "earnings").map((event) => ({ dateIso: event.dateIso, eventTime: event.eventTime })),
    exDividends: events.filter((event) => event.eventType === "ex_dividend").map((event) => ({ dateIso: event.dateIso, amount: event.amount === null ? null : Number(event.amount) })),
  };
}

/** A strike as the marks are keyed: rounded, so a strike carried across a split (× F(today) ÷ F(open)) finds the listed one. */
const roundedStrike = (strike: number) => Math.round(strike * 10_000) / 10_000;
const markKey = (expiry: string, strike: number, right: "C" | "P") => contractKey({ expiry, strike: roundedStrike(strike), right });

/** The option's 10:00 mark: the mid of a quote with an ask (a missing bid counts as 0). */
function markMidByContract(quotes: readonly SymbolFileQuote[]): Map<string, number> {
  const marks = new Map<string, number>();
  for (const quote of quotes) {
    if (quote.ask === null || !(quote.ask > 0)) continue;
    const bid = quote.bid !== null && quote.bid > 0 ? quote.bid : 0;
    if (quote.ask < bid) continue;
    marks.set(markKey(quote.expiry, quote.strike, quote.right), (bid + quote.ask) / 2);
  }
  return marks;
}

/**
 * A position's mark on its opening scale. After a split the listed contract is the adjusted one (strike × F(today) ÷ F(open),
 * that many more contracts), so its mid is put back on the opening scale; null when the day has no quote for it.
 */
function positionMark(position: BacktestPosition, midByContract: ReadonlyMap<string, number>, splitFactorToday: number): number | null {
  const scaleToToday = splitFactorToday / position.splitFactorAtOpen;
  const mid = midByContract.get(markKey(position.expiry, position.strike * scaleToToday, position.right));
  return mid === undefined ? null : mid / scaleToToday;
}

/**
 * The expiry day's close on the position's opening scale: IBKR's split-adjusted close × F(open), else the stock price the
 * closing option quotes imply (traded on the expiry day) × F(open) ÷ F(expiry). Null when neither exists.
 */
function settlementCloseOnOpeningScale(position: BacktestPosition, bars: BacktestBarHistory, file: BacktestSymbolFile, rates: TreasuryBillRates, schedule: SplitSchedule): { close: number; source: "bar" | "closing_quotes" } | null {
  const adjustedClose = bars.closeOn(position.expiry);
  if (adjustedClose !== null && adjustedClose > 0) return { close: adjustedClose * position.splitFactorAtOpen, source: "bar" };
  const splitFactorAtExpiry = splitFactorOn(schedule, position.expiry);
  if (splitFactorAtExpiry === null) return null;
  const ratePercent = rates.ratePercentOnOrBefore(position.expiry) ?? 0;
  const parity = computeParityStockPrice(file.loadEndOfDay(position.expiry), position.expiry, ratePercent / 100, null);
  return parity ? { close: (parity.price * position.splitFactorAtOpen) / splitFactorAtExpiry, source: "closing_quotes" } : null;
}

function volumeByContract(file: BacktestSymbolFile, tradingDate: string | null): Map<string, number> | null {
  if (tradingDate === null) return null;
  const volumes = new Map<string, number>();
  for (const row of file.loadEndOfDay(tradingDate)) if (row.volume !== null) volumes.set(contractKey(row), row.volume);
  return volumes;
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/**
 * Runs one session from scratch (its previous days and trades are deleted first). Sets the session `running`, then
 * `succeeded` with metrics, baseline_metrics, data_last_date and finished_at. Throws on failure or cancel; the caller
 * then marks the session and the job failed or cancelled.
 */
export async function runBacktestSession(sessionId: string, hooks: BacktestRunHooks, connection: Knex = db): Promise<void> {
  const session = await loadSessionRow(sessionId, connection);
  const settings = applyBacktestOverrides(session.settingsSnapshot, session.overrides ?? {});
  const symbol = normalizeBacktestSymbol(session.symbol);
  const startingValue = Number(session.startingValue);
  const dataDirectory = requireBacktestDataDirectory();
  const file = BacktestSymbolFile.open(symbol);
  try {
    const fileDays = file.loadDays();
    const completeDays = fileDays.filter((day) => day.status === "complete").map((day) => day.tradingDate);
    const dataLastDate = completeDays.at(-1) ?? null;
    const sessionDays = completeDays.filter((dateIso) => dateIso >= session.startDate && dateIso <= session.endDate);
    if (sessionDays.length === 0) throw new Error(`The ${symbol} data file has no complete day between ${session.startDate} and ${session.endDate}.`);
    const previousFileDayOf = new Map(completeDays.map((dateIso, index) => [dateIso, index > 0 ? completeDays[index - 1]! : null]));

    await connection("backtest_session_days").where({ session_id: sessionId }).delete();
    await connection("backtest_trades").where({ session_id: sessionId }).delete();
    await connection("backtest_sessions").where({ id: sessionId }).update({ status: "running", error: null, metrics: null, baseline_metrics: null, finished_at: null, data_last_date: dataLastDate });
    await hooks.reportProgress(0, sessionDays.length, "Loading history");

    const profile = await loadTickerProfile(symbol, connection);
    const bars = await loadBacktestBarHistory(profile.tickerId, connection);
    if (bars.rows.length === 0) throw new Error(`No IBKR daily bars for ${symbol} in the local DB: the forecast and the settlement prices come from them.`);
    const calendar = new BacktestTradingCalendar(fileDays, await loadMarketCalendarRowsFrom(addCalendarDays(fileDays.at(-1)!.tradingDate, 1), connection));
    const rates = await loadTreasuryBillRates(dataDirectory, addCalendarDays(completeDays[0]!, -10), completeDays.at(-1)!);
    // IBKR's bars are split-adjusted, the option file is as traded: F(D) puts every bar price on day D's traded scale.
    const { schedule, cached: scheduleCached } = loadOrInferSplitSchedule(dataDirectory, symbol, file, completeDays, bars, rates);
    const splitFactorByDay = requireSplitFactors(symbol, schedule, sessionDays);
    const splitsInSession = schedule.splits.filter((split) => split.lastDayBefore >= sessionDays[0]! && split.firstDayAfter <= sessionDays.at(-1)!);
    console.log(`backtest ${sessionId} splits (${scheduleCached ? "cached" : "inferred"}): ${splitsInSession.length === 0 ? "none in the session" : splitsInSession.map((split) => `${split.ratio}-for-1 between ${split.lastDayBefore} and ${split.firstDayAfter}`).join("; ")}`);
    const barsOnScale = new Map<number, BacktestBarHistory>();
    const barsOnTradedScale = (factor: number) => barsOnScale.get(factor) ?? barsOnScale.set(factor, bars.scaled(factor)).get(factor)!;
    const tables = await prepareModelTablesForSession(session.tablesMode, sessionDays, dataDirectory, (year) => hooks.reportProgress(0, sessionDays.length, `Model tables for ${year}`), connection);
    for (const line of tables.report) console.log(`backtest ${sessionId} tables: ${line}`);

    const book: BacktestBook = { cash: startingValue, positions: [] };
    const trades: SimulatedTrade[] = [];
    const days: SimulatedDay[] = [];
    // Buy and hold keeps the scale of its purchase day: N shares bought at P(first), worth N × P(D) × F(first) ÷ F(D).
    const baseline = { shares: 0, cash: startingValue, bought: false, splitFactorAtPurchase: 1 };
    let lastOpenedAtMs: number | null = null;
    /** The last 10:00 price on the split-adjusted scale (× F(D) gives any day's traded scale). */
    let lastAdjustedStockPrice: number | null = null;
    let lastProgressAtMs = 0;
    let lastCancelCheckAtMs = 0;
    const startedAtMs = Date.now();

    for (let dayIndex = 0; dayIndex < sessionDays.length; dayIndex++) {
      const todayIso = sessionDays[dayIndex]!;
      const nowMs = Date.now();
      if (nowMs - lastCancelCheckAtMs >= cancelCheckIntervalMs) {
        lastCancelCheckAtMs = nowMs;
        if (await hooks.isCancelRequested()) throw new BacktestCancelledError();
      }
      if (nowMs - lastProgressAtMs >= progressIntervalMs) {
        lastProgressAtMs = nowMs;
        await hooks.reportProgress(dayIndex, sessionDays.length, `${todayIso} · ${formatCount(dayIndex + 1)} of ${formatCount(sessionDays.length)} days`);
      }
      const notes: string[] = [];
      const splitFactor = splitFactorByDay.get(todayIso)!;
      const previousFileDay = previousFileDayOf.get(todayIso) ?? null;
      const previousBarDate = bars.previousClose(todayIso)?.dateIso ?? null;
      if (previousFileDay !== null && previousBarDate !== null && previousBarDate < previousFileDay) notes.push(`IBKR bars end ${previousBarDate}: the forecast and the day's move use that close`);

      // a. Settlement at the expiry day's close.
      for (const position of [...book.positions]) {
        if (position.expiry >= todayIso) continue;
        const contractLabel = describeOptionContract({ strike: position.strike, right: position.right, expiry: position.expiry, dte: null });
        const settlementClose = settlementCloseOnOpeningScale(position, bars, file, rates, schedule);
        if (!settlementClose) {
          notes.push(`cannot settle ${contractLabel}: no close for ${position.expiry}`);
          continue;
        }
        const settlement = settlePosition(position, settlementClose.close);
        book.cash += settlement.cashChange;
        book.positions.splice(book.positions.indexOf(position), 1);
        Object.assign(trades[position.tradeIndex]!, { settledOn: position.expiry, settlementClose: settlementClose.close, inTheMoneyAtExpiry: settlement.inTheMoneyAtExpiry, pnlDollars: settlement.pnlDollars });
        if (settlementClose.source === "closing_quotes") notes.push(`settled ${position.expiry} at the closing quotes' price (no IBKR bar)`);
        const splitFactorAtExpiry = splitFactorOn(schedule, position.expiry);
        if (splitFactorAtExpiry !== null && splitFactorAtExpiry !== position.splitFactorAtOpen) notes.push(`${contractLabel} was held across a split (×${Number((position.splitFactorAtOpen / splitFactorAtExpiry).toFixed(4))}): settled on its opening scale at ${settlementClose.close.toFixed(2)}`);
      }

      // b. Interest since the previous trading day.
      const previousSessionDay = dayIndex > 0 ? sessionDays[dayIndex - 1]! : null;
      let interestDollars = 0;
      let baselineInterestDollars = 0;
      if (previousSessionDay) {
        const ratePercent = rates.ratePercentOnOrBefore(previousSessionDay) ?? 0;
        const calendarDays = calendarDaysBetween(previousSessionDay, todayIso);
        interestDollars = computeInterestDollars(book.cash, ratePercent, calendarDays);
        baselineInterestDollars = computeInterestDollars(baseline.cash, ratePercent, calendarDays);
        book.cash += interestDollars;
        baseline.cash += baselineInterestDollars;
      }

      // c. The 10:00 marks.
      const quotes = file.loadQuotes(todayIso);
      const riskFreeRatePercent = rates.ratePercentOnOrBefore(addCalendarDays(todayIso, -1));
      const parity = computeParityStockPrice(quotes, todayIso, (riskFreeRatePercent ?? 0) / 100, maximumSpreadFractionOfMid);
      const adjustedFallbackPrice: number | null = parity ? null : (bars.previousClose(todayIso)?.close ?? lastAdjustedStockPrice);
      const stockPrice: number | null = parity?.price ?? (adjustedFallbackPrice === null ? null : adjustedFallbackPrice * splitFactor);
      if (stockPrice === null) throw new Error(`${todayIso}: no 10:00 stock price from the quotes and no earlier close to mark the account with.`);
      const midByContract = markMidByContract(quotes);
      updatePositionMarks(book, (position) => positionMark(position, midByContract, splitFactor));
      const accountValue = markAccountValue(book, stockPrice, splitFactor);
      const cashAtMark = book.cash;
      const exposureDollars = book.positions.reduce((sum, position) => sum + positionExposureDollars(position), 0);
      lastAdjustedStockPrice = stockPrice / splitFactor;

      // e. Buy and hold: whole shares on the first day with a price (as traded that day), the rest in cash.
      if (!baseline.bought) {
        baseline.shares = Math.floor(startingValue / stockPrice);
        baseline.cash = startingValue - baseline.shares * stockPrice;
        baseline.splitFactorAtPurchase = splitFactor;
        baseline.bought = true;
      }
      const baselineSharesValue = (baseline.shares * stockPrice * baseline.splitFactorAtPurchase) / splitFactor;
      const baselineValue = baselineSharesValue + baseline.cash;

      // d. The 10:00 decision.
      let decisionSummary: string;
      if (!parity) {
        decisionSummary = `No open: no two-sided call and put pair to price the stock at 10:00; marked at the previous close ${stockPrice.toFixed(2)}`;
      } else {
        const bookView: BacktestBookView = {
          netLiquidationValue: accountValue,
          cash: book.cash,
          freeCash: computeFreeCash(book),
          cashLockedInPuts: computeCashLockedInPuts(book),
          committedDollars: exposureDollars,
          markedExposureDollars: book.positions.reduce((sum, position) => sum + positionMarkedExposureDollars(position, stockPrice, splitFactor), 0),
          openPositionCount: book.positions.length,
          // On today's scale, so a contract held across a split is still recognised as taken.
          occupiedContracts: book.positions.map((position) => {
            const strikeToday = roundedStrike((position.strike * splitFactor) / position.splitFactorAtOpen);
            return { expiry: position.expiry, strike: strikeToday, detail: `open position on ${describeOptionContract({ symbol, strike: strikeToday, right: position.right, expiry: position.expiry, dte: daysToExpiry(position.expiry, todayIso) })}` };
          }),
          lastOpenedAtMs,
        };
        const decision = decideBacktestDay({
          profile,
          bars: barsOnTradedScale(splitFactor),
          market: { todayIso, quotes, openInterestByContract: file.loadOpenInterest(todayIso), previousSessionVolumeByContract: volumeByContract(file, previousFileDay), stockPrice, riskFreeRatePercent },
          book: bookView,
          settings,
          calendar,
          modelTables: tables.tablesFor(todayIso),
        });
        decisionSummary = decision.summary;
        if (decision.open) {
          const { candidate, quantity, fillPrice, commissionDollars } = decision.open;
          const model = candidate.model!;
          const position: BacktestPosition = {
            tradeIndex: trades.length,
            strategyKey: candidate.strategyKey,
            expiry: candidate.expiry,
            strike: candidate.strike,
            right: candidate.strategyKey === "covered_call" ? "C" : "P",
            contracts: quantity,
            premium: fillPrice,
            commissionDollars,
            sharePriceAtOpen: candidate.strategyKey === "covered_call" ? stockPrice : null,
            openedAtMs: decisionInstantMs(todayIso),
            lastMarkPerShare: (candidate.bid + candidate.ask) / 2,
            splitFactorAtOpen: splitFactor,
          };
          book.cash += openingCashChange(position);
          book.positions.push(position);
          lastOpenedAtMs = position.openedAtMs;
          trades.push({
            openedOn: todayIso,
            strategyKey: position.strategyKey,
            expiry: position.expiry,
            strike: position.strike,
            optionRight: position.right,
            contracts: quantity,
            bid: candidate.bid,
            ask: candidate.ask,
            fillPrice,
            commissionDollars,
            spotAtOpen: stockPrice,
            sharePriceAtOpen: position.sharePriceAtOpen,
            exposureDollars: positionExposureDollars(position),
            dte: candidate.dte,
            delta: candidate.delta,
            grade: model.grade,
            edgeMargin: model.edgeMargin,
            expectedPnlDollars: model.expectedPnlDollars * quantity,
            calibratedExpectedPnlDollars: model.calibratedExpectedPnlDollars * quantity,
            edgeYield: model.expectedAnnualizedReturn,
            histYield: model.calibratedAnnualizedReturn,
            kellyContracts: decision.open.kellyContracts,
            stressContracts: decision.open.stressContracts,
            settledOn: null,
            settlementClose: null,
            inTheMoneyAtExpiry: null,
            pnlDollars: null,
          });
        }
      }
      // The day is recorded as marked at 10:00, before its decision: an opening sale's cash and exposure show from the next day.
      days.push({ tradingDate: todayIso, accountValue, cash: cashAtMark, exposureDollars, interestDollars, baselineValue, baselineExposureDollars: baselineSharesValue, baselineInterestDollars, decisionSummary: [decisionSummary, ...notes].join(" · ") });
    }
    const elapsedSeconds = (Date.now() - startedAtMs) / 1000;
    console.log(`backtest ${sessionId}: ${sessionDays.length} days, ${trades.length} trades in ${elapsedSeconds.toFixed(1)} s (${((elapsedSeconds / sessionDays.length) * 1000).toFixed(0)} ms a day)`);
    await hooks.reportProgress(sessionDays.length, sessionDays.length, `Saving ${formatCount(sessionDays.length)} days and ${formatCount(trades.length)} trades`);
    await persistSessionResult(sessionId, startingValue, days, trades, dataLastDate, connection);
  } finally {
    file.close();
  }
}

/** The session's own series and its buy-and-hold series, measured with the same formulas. */
export function computeSessionMetrics(startingValue: number, days: readonly SimulatedDay[], trades: readonly SimulatedTrade[]) {
  const sessionDays: AccountDay[] = days.map((day) => ({ tradingDate: day.tradingDate, value: day.accountValue, exposureDollars: day.exposureDollars, interestDollars: day.interestDollars }));
  const baselineDays: AccountDay[] = days.map((day) => ({ tradingDate: day.tradingDate, value: day.baselineValue, exposureDollars: day.baselineExposureDollars, interestDollars: day.baselineInterestDollars }));
  const closedTradeFigures: ClosedTradeFigures[] = trades.map((trade) => ({ openedOn: trade.openedOn, settledOn: trade.settledOn, exposureDollars: trade.exposureDollars, pnlDollars: trade.pnlDollars, expectedPnlDollars: trade.expectedPnlDollars, calibratedExpectedPnlDollars: trade.calibratedExpectedPnlDollars, edgeMargin: trade.edgeMargin, inTheMoneyAtExpiry: trade.inTheMoneyAtExpiry }));
  return { metrics: computeBacktestMetrics(sessionDays, closedTradeFigures, startingValue), baselineMetrics: computeBacktestMetrics(baselineDays, [], startingValue) };
}

async function persistSessionResult(sessionId: string, startingValue: number, days: SimulatedDay[], trades: SimulatedTrade[], dataLastDate: string | null, connection: Knex): Promise<void> {
  const { metrics, baselineMetrics } = computeSessionMetrics(startingValue, days, trades);
  const dailyReturns = computeDailyReturns(days.map((day) => day.accountValue));
  const baselineDailyReturns = computeDailyReturns(days.map((day) => day.baselineValue));
  const dayRows = days.map((day, index) => ({
    session_id: sessionId,
    trading_date: day.tradingDate,
    account_value: day.accountValue,
    cash: day.cash,
    exposure_dollars: day.exposureDollars,
    interest_dollars: day.interestDollars,
    daily_return: dailyReturns[index],
    baseline_value: day.baselineValue,
    baseline_daily_return: baselineDailyReturns[index],
    decision_summary: day.decisionSummary,
  }));
  const tradeRows = trades.map((trade) => ({
    session_id: sessionId,
    opened_on: trade.openedOn,
    strategy_key: trade.strategyKey,
    expiry: trade.expiry,
    strike: trade.strike,
    option_right: trade.optionRight,
    contracts: trade.contracts,
    bid: trade.bid,
    ask: trade.ask,
    fill_price: trade.fillPrice,
    commission_dollars: trade.commissionDollars,
    spot_at_open: trade.spotAtOpen,
    share_price_at_open: trade.sharePriceAtOpen,
    exposure_dollars: trade.exposureDollars,
    dte: trade.dte,
    delta: trade.delta,
    grade: trade.grade,
    edge_margin: trade.edgeMargin,
    expected_pnl_dollars: trade.expectedPnlDollars,
    calibrated_expected_pnl_dollars: trade.calibratedExpectedPnlDollars,
    edge_yield: trade.edgeYield,
    hist_yield: trade.histYield,
    kelly_contracts: trade.kellyContracts,
    stress_contracts: trade.stressContracts,
    settled_on: trade.settledOn,
    settlement_close: trade.settlementClose,
    in_the_money_at_expiry: trade.inTheMoneyAtExpiry,
    pnl_dollars: trade.pnlDollars,
  }));
  await connection.transaction(async (transaction) => {
    for (let index = 0; index < dayRows.length; index += insertBatchSize) await transaction("backtest_session_days").insert(dayRows.slice(index, index + insertBatchSize));
    for (let index = 0; index < tradeRows.length; index += insertBatchSize) await transaction("backtest_trades").insert(tradeRows.slice(index, index + insertBatchSize));
    await transaction("backtest_sessions")
      .where({ id: sessionId })
      .update({ status: "succeeded", metrics: JSON.stringify(metrics), baseline_metrics: JSON.stringify(baselineMetrics), data_last_date: dataLastDate, finished_at: transaction.fn.now(), error: null });
  });
}

