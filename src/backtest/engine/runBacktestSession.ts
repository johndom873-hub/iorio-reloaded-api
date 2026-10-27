import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { describeOptionContract } from "../../lib/optionContractLabel.js";
import { contractKey } from "../../lib/optionContractKey.js";
import { addCalendarDays } from "../../lib/calendarDays.js";
import { isEtfSector, tickerCalendarProfile } from "../../lib/tickerCalendarRelevance.js";
import { effectiveWindowEndEt } from "../../pluto/sessionSchedule.js";
import { isRetiredBacktestDecisionMaker, retiredBacktestDecisionMakerMessage, type BacktestAction, type BacktestBookMode, type BacktestBreakEvenLevel, type BacktestCycle, type BacktestCycleGap, type BacktestFill, type BacktestLadderLevel, type BacktestOrderShortfall, type BacktestPosition, type BacktestRunStatistics, type BacktestSettings, type BacktestSettingsOverrides, type BacktestSymbolSettings, type BacktestTablesMode } from "../backtestTypes.js";
import { normalizeBacktestSymbol, requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { calendarDaysBetween, computeBacktestMetrics, computeDailyReturns, cycleFiguresOf, type AccountDay } from "../sessionAnalytics.js";
import type { FileIntradayPrices } from "../backtestFileStockBars.js";
import { BacktestBarHistory, loadBacktestBarHistory } from "./backtestBarHistory.js";
import { computeInterestDollars } from "./backtestBook.js";
import type { BacktestLookSymbol, BacktestNoCandidateNote, BacktestNoSaleNote, BacktestOptionSale, BacktestTickerSetup } from "./backtestLookTypes.js";
import { buildCycleGapRecords, buildCycleRecords, buildFillRecords, buildOptionTrades, buildPositionRecords, withPositionCycle, type BacktestCycleRecord, type SimulatedTrade } from "./backtestSessionRecords.js";
import type { NoSaleRecords } from "./backtestIdleStretches.js";
import { captureLookTimeEt, decisionInstantMs, type BacktestTickerProfile } from "./backtestTickerInputs.js";
import { firstTwoSidedMids, markKey, markMidByContract, roundedStrike } from "./backtestOptionMarks.js";
import { BacktestSymbolFile, type SymbolFileDayIssue, type SymbolFileEndOfDayRow, type SymbolFileQuote } from "./backtestSymbolFile.js";
import { describeDaysWithoutIntradayQuotes } from "../jobs/backtestSessionRequest.js";
import { loadMarketStressPrices, marketStressSymbol } from "../marketStressBars.js";
import { SpyBuyAndHold } from "./spyBuyAndHold.js";

import { alignOpenOptionLegsToSplitFactor, creditInterest, settleExpiry, settleHedgePut, settleLeapsCall } from "./ledger/ledgerEvents.js";
import { ledgerCommittedDollars, ledgerHedgeLegsDueForSettlement, ledgerLeapsLegsDueForSettlement, ledgerLegsDueForSettlement, ledgerNetLiquidationValue, ledgerSharesValue } from "./ledger/ledgerSelectors.js";
import { describeHedgeTotals, hedgeIsOn, summarizeHedge, type HedgePutQuoteSource } from "./backtestBaselineHedge.js";
import { createSimulatedLedger, cycleSplitFactorFor, rememberedForRevision, requirePosition, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";
import { loadOrInferSplitSchedule, requireSplitFactors, splitFactorOn, type SplitSchedule } from "./splitFactors.js";
import { BacktestTradingCalendar, loadMarketCalendarRowsFrom } from "./backtestTradingCalendar.js";
import { BacktestDayDataReader, type PrefetchedSymbolDay } from "./backtestDayDataReader.js";
import { loadTreasuryBillRates } from "./treasuryBillRates.js";
import { prepareModelTablesForSession } from "./walkForwardModelTables.js";
import { runBaselineLook } from "./backtestBaselineLook.js";
import { runSteadyStakeLook } from "./backtestSteadyStakeLook.js";
import { describeVolFarmerCash, runVolFarmerLook, scanVolFarmerCrossing } from "./backtestVolFarmerLook.js";
import { describeVolFarmerV2Run, runVolFarmerV2Look } from "./backtestVolFarmerV2Look.js";

// The backtest engine's entry point (docs/backtesting/FORMULAS.md, FULL-FIDELITY-DESIGN.md, DATA-FILES.md). Called by the
// job process (scripts/run-backtest-job.ts) for a backtest job. One session = one or several symbols from its start to
// its end date on ONE book: a simulated ledger shaped like the platform's own tables (ledger/), with one cash balance.
// Session days are the dates on which at least one symbol's file has a complete day; each is replayed as:
//   a. settle every option whose expiry is before today, at 16:00 of its expiry day and that day's close (IBKR daily
//      bar, else the close of IBKR's last 30-minute bar that day): in the money by a cent or more it is assigned (a put's
//      shares come in at the strike, a call's go at the strike), otherwise it expires worthless and a call's shares
//      stay. With neither close the session fails: an option is never settled on a guessed price or left open.
//      Every stock price comes from IBKR's bars kept in the symbol's file (backtestFileStockBars.ts), never from the
//      option quotes (Marcelo 2026-10-14); the quotes only tell where a split falls (splitFactors.ts).
//   b. credit interest on cash since the previous session day (DTB3 on or before that day)
//   c. mark the account at 10:00 and record the day:
//        account value = cash + shares × the 10:00 stock price − short options × their 10:00 mids
//        (an option with no quote that day keeps its last mark; a symbol with no file day or no 10:00 price that day
//        has its shares marked at its previous close and is not scored)
//   d. the looks inside Pluto's trading window, every half hour the files hold quotes for (10:00 … 15:30) from the
//      window's start to its end, the end never later than 30 minutes before the day's close (sessionSchedule.ts: 12:30
//      on a 13:00 day). At each look each symbol's stock price is the close of IBKR's 30-minute bar ending then (10:00
//      reads the 09:30 bar), and the look's quotes re-mark its legs; a symbol whose file has no intraday quotes that day
//      is looked at only at 10:00, and one without quotes or a bar at a look is left out of that look. The decision
//      maker (the baseline wheel, the Steady Stake, the Vol Farmer, Vol Farmer v2) then decides the look on the shared
//      book; the Steady Stake and Vol Farmer v2 decide at 10:00 only, the baseline at 10:00 only when its looks say so
//   e. the buy-and-hold baselines, for comparison only: the starting value split equally between the symbols, each
//      share bought whole on the first day its symbol has a price and never rebalanced, the rest in cash at the same
//      interest; and the starting value in whole SPY shares at SPY's 10:00 price (spyBuyAndHold.ts)
// The day's row is its 10:00 mark, taken before its looks: what the looks do shows in the account from the next session
// day, so the last day's actions are in the book but outside the account series and the metrics.
// Days no symbol's file holds are not session days; the next session day's summary names those the downloader could not
// retrieve. A previous day whose end-of-day data is missing leaves volume unknown, and the day's summary says so.
// A wheel cycle stays on the price scale of its first day: IBKR's bars are split-adjusted and the option file is as
// traded, so with F(D) the symbol's cumulative split factor a price traded on day D is put on the cycle's scale by
// × F(cycle) ÷ F(D).

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
/** How many of a symbol's days the reader thread reads ahead of the one being replayed (today's included). */
const prefetchDaysAhead = 3;

interface SessionRow {
  id: string;
  symbol: string;
  /** Empty on a row written before sessions took a list: `symbol` is then the one symbol. */
  symbols: string[] | null;
  startDate: string;
  endDate: string;
  startingValue: string;
  tablesMode: BacktestTablesMode;
  settingsSnapshot: BacktestSettings;
  overrides: BacktestSettingsOverrides;
  bookMode: BacktestBookMode;
  /** Each ticker's pot, weight and values in a "pots" session; null otherwise. */
  symbolSettings: Record<string, BacktestSymbolSettings> | null;
}

export type { SimulatedTrade } from "./backtestSessionRecords.js";

export interface SimulatedDay {
  tradingDate: string;
  accountValue: number;
  cash: number;
  exposureDollars: number;
  /** The shares held at the same marks as the account value (recorded only). */
  sharesValueDollars: number;
  interestDollars: number;
  baselineValue: number;
  baselineExposureDollars: number;
  baselineInterestDollars: number;
  /** Buy and hold of SPY; null when the local DB has no SPY prices at all. */
  spyBaselineValue: number | null;
  spyBaselineExposureDollars: number | null;
  spyBaselineInterestDollars: number | null;
  decisionSummary: string;
  looksRun: number;
  actionsTaken: number;
}

async function loadSessionRow(sessionId: string, connection: Knex): Promise<SessionRow> {
  const row = await connection("backtest_sessions")
    .where({ id: sessionId })
    .first("id", "symbol", "symbols", connection.raw('start_date::text as "startDate"'), connection.raw('end_date::text as "endDate"'), "starting_value as startingValue", "tables_mode as tablesMode", "settings_snapshot as settingsSnapshot", "overrides", "book_mode as bookMode", "symbol_settings as symbolSettings");
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

/** A strike as the marks are keyed: rounded, so a strike carried across a split (÷ r) finds the listed one. */

/** The half hours the data files hold quotes for (their intraday_window, every intraday_interval). */
export const lookGridTimesEt: readonly string[] = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"];
/** A look's quotes are read for the strikes from this share of the 10:00 stock price to that multiple of it (the capture's widest window at any price the day can reach), and for the held legs' strikes. */
const lookStrikeRangeOfStockPrice = { lowest: 0.45, highest: 2.2 };

const clockTime = (minutesOfDay: number) => `${String(Math.floor(minutesOfDay / 60)).padStart(2, "0")}:${String(minutesOfDay % 60).padStart(2, "0")}`;

/** A regular session's close, 16:00 ET, in minutes of the day. */
export const regularCloseMinutesEt = 16 * 60;

/**
 * The looks of a day: the grid times from the window's start through its end, the end pulled in to 30 minutes before
 * the day's close (effectiveWindowEndEt, as resolvePlutoSession). The quotes stored for later times on an early-close
 * day repeat the closing quotes and are never looked at.
 */
export function lookTimesInWindow(windowStartEt: string, windowEndEt: string, closeMinutesEt: number): string[] {
  const lastLookTimeEt = effectiveWindowEndEt(windowEndEt, clockTime(closeMinutesEt));
  return lookGridTimesEt.filter((lookTimeEt) => lookTimeEt >= windowStartEt && lookTimeEt <= lastLookTimeEt);
}

/** One look of a day, for the day's summary. */
interface DayLookSummary {
  lookTimeEt: string;
  /** The look in one line, without where opens were stopped. */
  summary: string;
  filledCount: number;
  refusedCount: number;
  /** "no further opens on SMCI: no ticker room". */
  opensStopped: readonly string[];
}

/**
 * The day in one line. A day of one look at 10:00 reads as that look. Otherwise every look that filled an order is
 * named with its time; of the looks that only had choices refused, the first is told in full and the others are named;
 * the looks with nothing to tell are counted, and when no look did anything the first one says why. Where opens were
 * stopped for lack of room is said once for the day.
 */
function summarizeDayLooks(looks: readonly DayLookSummary[]): string[] {
  if (looks.length === 0) return [];
  const opensStopped = [...new Set(looks.flatMap((look) => look.opensStopped))];
  if (looks.length === 1 && looks[0]!.lookTimeEt === captureLookTimeEt) return [looks[0]!.summary, ...opensStopped];
  const withFills = looks.filter((look) => look.filledCount > 0);
  const onlyRefused = looks.filter((look) => look.filledCount === 0 && look.refusedCount > 0);
  if (withFills.length + onlyRefused.length === 0) return [`${looks[0]!.lookTimeEt} ${looks[0]!.summary}`, ...(looks.length > 1 ? [`no action at the ${looks.length - 1} later look${looks.length === 2 ? "" : "s"} either`] : [])];
  const quietCount = looks.length - withFills.length - onlyRefused.length;
  const laterRefusedLooks = onlyRefused.slice(1);
  const laterRefusedCount = laterRefusedLooks.reduce((sum, look) => sum + look.refusedCount, 0);
  return [
    ...withFills.map((look) => `${look.lookTimeEt} ${look.summary}`),
    ...(onlyRefused.length > 0 ? [`${onlyRefused[0]!.lookTimeEt} ${onlyRefused[0]!.summary}`] : []),
    ...(laterRefusedLooks.length > 0 ? [`${laterRefusedCount} more choice${laterRefusedCount === 1 ? "" : "s"} refused at ${laterRefusedLooks.map((look) => look.lookTimeEt).join(", ")}`] : []),
    ...(quietCount > 0 ? [`no action at the other ${quietCount} look${quietCount === 1 ? "" : "s"}`] : []),
    ...opensStopped,
  ];
}

/**
 * The option's mark at a look or at the close: the mid of a quote with an ask (a missing bid counts as 0), for the
 * contracts at the given strikes (as markKey rounds them): the held legs a caller marks. The last quote of a contract
 * counts, as when every quote is read.
 */
/** A day's close on IBKR's split-adjusted scale: its daily bar's, else its last 30-minute bar's; null with neither. */
function adjustedCloseOn(dateIso: string, bars: BacktestBarHistory, intradayPrices: FileIntradayPrices): { close: number; source: "bar" | "intraday_bar" } | null {
  const dailyClose = bars.closeOn(dateIso);
  if (dailyClose !== null && dailyClose > 0) return { close: dailyClose, source: "bar" };
  const lastIntradayClose = intradayPrices.priceAt(dateIso, "16:00");
  return lastIntradayClose === null ? null : { close: lastIntradayClose, source: "intraday_bar" };
}

/** The expiry day's close on a cycle's scale: IBKR's split-adjusted close (adjustedCloseOn) × F(cycle). Null without one. */
function settlementCloseOnCycleScale(expiryDate: string, cycleSplitFactor: number, bars: BacktestBarHistory, intradayPrices: FileIntradayPrices): { close: number; source: "bar" | "intraday_bar" } | null {
  const close = adjustedCloseOn(expiryDate, bars, intradayPrices);
  return close === null ? null : { close: close.close * cycleSplitFactor, source: close.source };
}

function volumeByContract(endOfDayRows: readonly SymbolFileEndOfDayRow[] | null): Map<string, number> | null {
  if (endOfDayRows === null) return null;
  const volumes = new Map<string, number>();
  for (const row of endOfDayRows) if (row.volume !== null) volumes.set(contractKey(row), row.volume);
  return volumes;
}

/**
 * What the file lacks for a session day, in the day's words. The previous day's end-of-day rows give the volume Pluto's
 * volume rule reads: a day stored without them (or without some expirations) leaves that volume unknown, and the rule
 * refuses the contracts. Today's own missing parts are named too.
 */
function describeDataGaps(file: BacktestSymbolFile, todayIso: string, previousFileDay: string | null, previousSessionVolumeByContract: ReadonlyMap<string, number> | null): string[] {
  const notes: string[] = [];
  const expiriesOf = (issues: readonly SymbolFileDayIssue[]) => issues.map((issue) => issue.expiry).filter((expiry): expiry is string => expiry !== null);
  if (previousFileDay !== null) {
    const endOfDayIssues = file.loadDayIssues(previousFileDay).filter((issue) => issue.part === "eod");
    if (endOfDayIssues.some((issue) => issue.expiry === null) || (previousSessionVolumeByContract?.size ?? 0) === 0) notes.push(`volume unknown for every contract (refused by the volume rule): the file has no end-of-day data for ${previousFileDay}`);
    else if (endOfDayIssues.length > 0) notes.push(`volume unknown for the expiries ${expiriesOf(endOfDayIssues).join(", ")} (refused by the volume rule): their end-of-day data of ${previousFileDay} could not be downloaded`);
  }
  const todaysIssues = file.loadDayIssues(todayIso);
  for (const [part, what] of [["quotes", "10:00 quotes"], ["open_interest", "open interest"]] as const) {
    const issues = todaysIssues.filter((issue) => issue.part === part);
    if (issues.length === 0) continue;
    notes.push(issues.some((issue) => issue.expiry === null) ? `the day's ${what} could not be downloaded` : `the day's ${what} could not be downloaded for the expiries ${expiriesOf(issues).join(", ")}`);
  }
  return notes;
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

/** Open legs of open positions, in the ledger's order (one list per ledger revision). */
function openLegsOf(ledger: SimulatedLedger): readonly LedgerLeg[] {
  return rememberedForRevision(ledger, "openLegsOf", () => {
    const openPositionIds = new Set(ledger.positions.filter((position) => position.status === "open").map((position) => position.id));
    return ledger.legs.filter((leg) => leg.exitAt === null && openPositionIds.has(leg.positionId));
  });
}

export interface SimulatedSessionResult {
  days: SimulatedDay[];
  trades: SimulatedTrade[];
  positions: BacktestPosition[];
  fills: BacktestFill[];
  actions: BacktestAction[];
  /** Each with its timeline and stock-only stretches. */
  cycles: BacktestCycleRecord[];
  /** Each symbol's stretches with no cycle open. */
  cycleGaps: BacktestCycleGap[];
  /** The baseline's orders that left contracts unsold. */
  shortfalls: BacktestOrderShortfall[];
  /** The put ladder's levels, per symbol and day: the day's first look while the cycle held shares. */
  ladderLevels: BacktestLadderLevel[];
  breakEvenLevels: BacktestBreakEvenLevel[];
  /** What the run tells about the session as a whole. */
  notes: string[];
  runStatistics: BacktestRunStatistics;
}

/** A symbol's file day at 10:00: its quotes, the stock price then (IBKR), and what the looks read with them. */
interface DayCapture {
  quotes: SymbolFileQuote[];
  /** The close of IBKR's 09:30 bar on the day's traded scale; null without that bar. */
  stockPrice: number | null;
  previousSessionVolumeByContract: Map<string, number> | null;
  /** The 10:00 market the looks read; null without a 10:00 price. */
  market: BacktestLookSymbol["market"] | null;
}

/** One symbol of a session: its file, history and price scale, and where the replay stands on it. */
interface SessionSymbol {
  symbol: string;
  file: BacktestSymbolFile;
  profile: BacktestTickerProfile;
  /** IBKR's daily bars kept in the symbol's file. */
  bars: BacktestBarHistory;
  /** IBKR's 30-minute bars kept in the file: the stock's price at each look. */
  intradayPrices: FileIntradayPrices;
  barsOnTradedScale(splitFactor: number): BacktestBarHistory;
  /** IBKR's split-adjusted daily closes, ascending. */
  adjustedDailyCloses: { date: string; close: number }[];
  schedule: SplitSchedule;
  completeDays: Set<string>;
  /** The days whose intraday quotes the file holds. */
  intradayDays: Set<string>;
  /** A day's end-of-day rows (the last days read are kept: the day's later marks and the next day's volume read the same day). */
  endOfDayRows(tradingDate: string): readonly SymbolFileEndOfDayRow[];
  /** The complete file day before each complete day; null for the first. */
  previousFileDayOf: Map<string, string | null>;
  /** The symbol's complete days inside the session, ascending: what the reader thread reads ahead. */
  ownSessionDays: string[];
  /** The days the reader thread read for the symbol, the last few kept (a day's end-of-day rows are read again the next day). */
  prefetchedDays: Map<string, PrefetchedSymbolDay | null>;
  /** Each file day's 10:00 capture, worked out once; the last few kept. */
  captureByDay: Map<string, DayCapture>;
  lastCompleteDay: string;
  /** Days inside the period the downloader could not retrieve at all. */
  unavailableDaysInPeriod: string[];
  /** F on each of the symbol's own session days. */
  splitFactorByDay: Map<string, number>;
  /** How many of the adjusted closes are dated before the day being replayed. */
  closesBeforeTodayCount: number;
  /** The last 10:00 price on the split-adjusted scale (× F(D) gives any day's traded scale); null before the first. */
  lastAdjustedStockPrice: number | null;
  /** Buy and hold keeps the scale of its purchase day: N shares bought at P(first), worth N × P(D) × F(first) ÷ F(D). */
  baseline: { shares: number; splitFactorAtPurchase: number; bought: boolean };
}

/** The symbols of a session row, in its order. */
function sessionSymbolsOf(session: Pick<SessionRow, "symbol" | "symbols">): string[] {
  const listed = Array.isArray(session.symbols) && session.symbols.length > 0 ? session.symbols : [session.symbol];
  return [...new Set(listed.map(normalizeBacktestSymbol))];
}

/**
 * Runs one session from scratch (its previous days, trades and book are deleted first). Sets the session `running`, then
 * `succeeded` with metrics, baseline_metrics, data_last_date and finished_at. Throws on failure or cancel; the caller
 * then marks the session and the job failed or cancelled.
 */
export async function runBacktestSession(sessionId: string, hooks: BacktestRunHooks, connection: Knex = db): Promise<void> {
  const session = await loadSessionRow(sessionId, connection);
  const settings = applyBacktestOverrides(session.settingsSnapshot, session.overrides ?? {});
  // A past rules or AI model session is never run again: its stored results stay as they are.
  if (isRetiredBacktestDecisionMaker(settings.decisionMaker)) throw new Error(retiredBacktestDecisionMakerMessage);
  // With per-ticker pots the tickers take their turn at a look alphabetically, so the one that finds the cash short is
  // known in advance (approved by Marcelo 2026-10-15); a shared account keeps the order given.
  const symbolNames = session.bookMode === "pots" ? sessionSymbolsOf(session).sort() : sessionSymbolsOf(session);
  // Each ticker's own baseline values and weight (backtestLook.ts).
  const tickerSetupBySymbol: ReadonlyMap<string, BacktestTickerSetup> | undefined =
    session.bookMode === "pots" && session.symbolSettings ? new Map(Object.entries(session.symbolSettings).map(([symbol, ticker]) => [symbol, { baseline: { ...settings.baseline, ...ticker.baseline }, weight: ticker.weight }])) : undefined;
  // The baseline wheel's hedge (backtestBaselineHedge.ts) reads long-dated Puts from the files of the tickers it is on for; the Vol Farmer's, from every file.
  const hedgeOnFor = (symbol: string) => settings.decisionMaker === "vol_farmer" || (settings.decisionMaker === "baseline" && hedgeIsOn(tickerSetupBySymbol?.get(symbol)?.baseline ?? settings.baseline));
  // Vol Farmer v2 buys its LEAPS from the 10:00 Calls of every listed expiry (backtestVolFarmerV2Look.ts).
  const leapsOn = settings.decisionMaker === "vol_farmer_v2";
  const severalSymbols = symbolNames.length > 1;
  const startingValue = Number(session.startingValue);
  const dataDirectory = requireBacktestDataDirectory();
  // Every file is opened once and stays open for the run.
  const files: BacktestSymbolFile[] = [];
  // The files are read ahead on a thread of their own (backtestDayDataReader.ts).
  const dayDataReader = new BacktestDayDataReader();
  try {
    const fileBySymbol = new Map<string, BacktestSymbolFile>();
    for (const symbol of symbolNames) {
      const file = BacktestSymbolFile.open(symbol);
      files.push(file);
      fileBySymbol.set(symbol, file);
    }
    const fileDaysBySymbol = new Map(symbolNames.map((symbol) => [symbol, fileBySymbol.get(symbol)!.loadDays()]));
    const completeDaysBySymbol = new Map(symbolNames.map((symbol) => [symbol, fileDaysBySymbol.get(symbol)!.filter((day) => day.status === "complete").map((day) => day.tradingDate)]));
    for (const symbol of symbolNames) if (!completeDaysBySymbol.get(symbol)!.some((dateIso) => dateIso >= session.startDate && dateIso <= session.endDate)) throw new Error(`The ${symbol} data file has no complete day between ${session.startDate} and ${session.endDate}.`);
    // A session day is a date on which at least one symbol's file has a complete day.
    const sessionDays = [...new Set(symbolNames.flatMap((symbol) => completeDaysBySymbol.get(symbol)!.filter((dateIso) => dateIso >= session.startDate && dateIso <= session.endDate)))].sort();
    // The session cannot go past the file that ends first.
    const dataLastDate = symbolNames.map((symbol) => completeDaysBySymbol.get(symbol)!.at(-1)!).sort()[0]!;

    await clearSessionResult(sessionId, connection);
    await connection("backtest_sessions").where({ id: sessionId }).update({ status: "running", error: null, metrics: null, baseline_metrics: null, spy_baseline_metrics: null, finished_at: null, data_last_date: dataLastDate, notes: JSON.stringify([]), run_statistics: null });
    await hooks.reportProgress(0, sessionDays.length, "Loading history");

    // Sessions for the variance clock: a date is a session when any file has it complete, a holiday when the files
    // that have it all say no data; after the last file day the market calendar decides.
    const statusByDate = new Map<string, "complete" | "no_data">();
    for (const fileDays of fileDaysBySymbol.values()) for (const day of fileDays) if (day.status === "complete" || !statusByDate.has(day.tradingDate)) statusByDate.set(day.tradingDate, day.status);
    const unionFileDays = [...statusByDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tradingDate, status]) => ({ tradingDate, status }));
    const marketCalendarRows = await loadMarketCalendarRowsFrom(addCalendarDays(unionFileDays.at(-1)!.tradingDate, 1), connection);
    const calendar = new BacktestTradingCalendar(unionFileDays, marketCalendarRows);
    const firstCompleteDay = symbolNames.map((symbol) => completeDaysBySymbol.get(symbol)![0]!).sort()[0]!;
    const lastCompleteDay = symbolNames.map((symbol) => completeDaysBySymbol.get(symbol)!.at(-1)!).sort().at(-1)!;
    const rates = await loadTreasuryBillRates(dataDirectory, addCalendarDays(firstCompleteDay, -10), lastCompleteDay);

    const symbols: SessionSymbol[] = [];
    for (const symbol of symbolNames) {
      const file = fileBySymbol.get(symbol)!;
      const completeDays = completeDaysBySymbol.get(symbol)!;
      const completeDaySet = new Set(completeDays);
      const profile = await loadTickerProfile(symbol, connection);
      // Every stock price comes from IBKR's bars kept in the file: the forecast, the 10:00 and look prices, the closes.
      const refreshHint = `press Update on its row in Data files (or run npm run backtest:backfill-file-stock-bars -- ${symbol})`;
      const dailyBarRows = file.loadIbkrDailyBars();
      if (!dailyBarRows) throw new Error(`The ${symbol} data file has no IBKR daily bars: ${refreshHint}.`);
      const bars = new BacktestBarHistory(dailyBarRows);
      const intradayPrices = file.loadIbkrIntradayPrices(addCalendarDays(session.startDate, -10), session.endDate);
      if (!intradayPrices) throw new Error(`The ${symbol} data file has no IBKR 30-minute bars: ${refreshHint}.`);
      const lastOwnDay = [...completeDays].reverse().find((dateIso) => dateIso >= session.startDate && dateIso <= session.endDate)!;
      for (const [what, lastDate] of [["daily", bars.lastDateIso()], ["30-minute", intradayPrices.lastDate]] as const) {
        if (lastDate === null || lastDate < lastOwnDay) throw new Error(`The ${symbol} IBKR ${what} bars end ${lastDate ?? "nowhere"}, before the session's last day ${lastOwnDay}: ${refreshHint}.`);
      }
      // IBKR's bars are split-adjusted, the option file is as traded: F(D) puts every bar price on day D's traded scale.
      const { schedule, cached: scheduleCached } = loadOrInferSplitSchedule(dataDirectory, symbol, file, completeDays, bars, rates);
      const ownSessionDays = sessionDays.filter((dateIso) => completeDaySet.has(dateIso));
      const splitFactorByDay = requireSplitFactors(symbol, schedule, ownSessionDays);
      const splitsInSession = schedule.splits.filter((split) => split.lastDayBefore >= sessionDays[0]! && split.firstDayAfter <= sessionDays.at(-1)!);
      // Days inside the period with no 10:00 data at all (an unavailable day that has a `days` row lacks only its intraday quotes).
      const unavailableDaysInPeriod = file.loadUnavailableDays().map((day) => day.tradingDate).filter((dateIso) => dateIso >= session.startDate && dateIso <= session.endDate && !completeDaySet.has(dateIso));
      if (unavailableDaysInPeriod.length > 0) console.log(`backtest ${sessionId} ${symbol}: ${unavailableDaysInPeriod.length} day(s) inside the period could not be downloaded: ${unavailableDaysInPeriod.join(", ")}`);
      console.log(`backtest ${sessionId} ${symbol} splits (${scheduleCached ? "cached" : "inferred"}): ${splitsInSession.length === 0 ? "none in the session" : splitsInSession.map((split) => `${split.ratio}-for-1 between ${split.lastDayBefore} and ${split.firstDayAfter}`).join("; ")}`);
      const barsOnScale = new Map<number, BacktestBarHistory>();
      const endOfDayRowsByDate = new Map<string, SymbolFileEndOfDayRow[]>();
      const prefetchedDays = new Map<string, PrefetchedSymbolDay | null>();
      const endOfDayRows = (tradingDate: string) => {
        let rows = endOfDayRowsByDate.get(tradingDate);
        if (!rows) {
          rows = prefetchedDays.get(tradingDate)?.endOfDay() ?? file.loadEndOfDay(tradingDate);
          endOfDayRowsByDate.set(tradingDate, rows);
          // Only the last few days are ever asked for again.
          if (endOfDayRowsByDate.size > 4) endOfDayRowsByDate.delete(endOfDayRowsByDate.keys().next().value!);
        }
        return rows;
      };
      symbols.push({
        symbol,
        file,
        profile,
        bars,
        intradayPrices,
        barsOnTradedScale: (factor) => barsOnScale.get(factor) ?? barsOnScale.set(factor, bars.scaled(factor)).get(factor)!,
        adjustedDailyCloses: bars.rows.flatMap((row) => (row.close !== null && row.close > 0 ? [{ date: row.tradingDate, close: row.close }] : [])),
        schedule,
        completeDays: completeDaySet,
        intradayDays: file.loadIntradayDays(),
        endOfDayRows,
        previousFileDayOf: new Map(completeDays.map((dateIso, index) => [dateIso, index > 0 ? completeDays[index - 1]! : null])),
        ownSessionDays,
        prefetchedDays,
        captureByDay: new Map(),
        lastCompleteDay: completeDays.at(-1)!,
        unavailableDaysInPeriod,
        splitFactorByDay,
        closesBeforeTodayCount: 0,
        lastAdjustedStockPrice: null,
        baseline: { shares: 0, splitFactorAtPurchase: 1, bought: false },
      });
    }
    const symbolByName = new Map(symbols.map((entry) => [entry.symbol, entry]));
    const sectorBySymbol = new Map(symbols.map((entry) => [entry.symbol, entry.profile.sector]));
    // A day no file holds is skipped; those the downloader could not retrieve for any symbol are named on the next day.
    const sessionDaySet = new Set(sessionDays);
    const skippedUnavailableDays = [...new Set(symbols.flatMap((entry) => entry.unavailableDaysInPeriod))].filter((dateIso) => !sessionDaySet.has(dateIso)).sort();
    const tables = await prepareModelTablesForSession(session.tablesMode, sessionDays, dataDirectory, (year) => hooks.reportProgress(0, sessionDays.length, `Model tables for ${year}`), connection);
    for (const line of tables.report) console.log(`backtest ${sessionId} tables: ${line}`);
    const marketStressPrices = await loadMarketStressPrices(sessionDays[0]!, sessionDays.at(-1)!, connection);
    // SPY at 10:00: the close of its 09:30 bar, else the day's IBKR open (the daily bar has no 10:00 price).
    const spyTicker: { id: string } | undefined = await connection("tickers").where({ symbol: marketStressSymbol }).first("id");
    const spyDailyBars = spyTicker ? await loadBacktestBarHistory(spyTicker.id, connection) : null;
    const spyPriceAtTen = (dateIso: string): number | null => marketStressPrices.priceAt(dateIso, captureLookTimeEt) ?? spyDailyBars?.openOn(dateIso) ?? null;
    const spyBuyAndHold = marketStressPrices.lastDate !== null || (spyDailyBars?.rows.length ?? 0) > 0 ? new SpyBuyAndHold(startingValue) : null;
    const pluto = settings.pluto;
    const closeMinutesByDay = new Map(calendar.sessionsBetween(sessionDays[0]!, sessionDays.at(-1)!).map((tradingSession) => [tradingSession.dateIso, tradingSession.closeMinutesEt]));

    const ledger = createSimulatedLedger(startingValue, new Date(decisionInstantMs(sessionDays[0]!)));
    /** The last 10:00 mark per share of each leg, on its cycle's scale. */
    const priceByLegId = new Map<string, number>();
    const actions: BacktestAction[] = [];
    const shortfalls: BacktestOrderShortfall[] = [];
    const noSaleNotes: BacktestNoSaleNote[] = [];
    // The first look of a day, symbol and order that found no candidate: what the Wheel cycles explain the day with.
    const noCandidateNotes: BacktestNoCandidateNote[] = [];
    const noCandidateKeys = new Set<string>();
    const keepNoCandidateNotes = (found: readonly BacktestNoCandidateNote[]) => {
      for (const note of found) {
        const key = `${note.tradingDate}|${note.symbol}|${note.order}`;
        if (noCandidateKeys.has(key)) continue;
        noCandidateKeys.add(key);
        noCandidateNotes.push(note);
      }
    };
    // Looks that found nothing within the rules are kept one row per day, symbol and order, with their count (approved by
    // Marcelo 2026-10-15: per-look rows were ~16,000 a five-year session, 99% of them these).
    const noCandidateRowByKey = new Map<string, BacktestOrderShortfall>();
    const keepShortfalls = (found: readonly BacktestOrderShortfall[]) => {
      for (const shortfall of found) {
        if (shortfall.reason !== "no_candidate") {
          shortfalls.push(shortfall);
          continue;
        }
        const key = `${shortfall.tradingDate}|${shortfall.symbol}|${shortfall.step}`;
        const kept = noCandidateRowByKey.get(key);
        if (kept) kept.lookCount += shortfall.lookCount;
        else {
          const row = { ...shortfall };
          noCandidateRowByKey.set(key, row);
          shortfalls.push(row);
        }
      }
    };
    const ladderLevels: BacktestLadderLevel[] = [];
    const ladderLevelKeys = new Set<string>();
    const keepLadderLevels = (found: readonly BacktestLadderLevel[]) => {
      for (const level of found) {
        const key = `${level.tradingDate}|${level.symbol}`;
        if (ladderLevelKeys.has(key)) continue;
        ladderLevelKeys.add(key);
        ladderLevels.push(level);
      }
    };
    const breakEvenLevels: BacktestBreakEvenLevel[] = [];
    const breakEvenLevelKeys = new Set<string>();
    const keepBreakEvenLevels = (found: readonly BacktestBreakEvenLevel[]) => {
      for (const level of found) {
        const key = `${level.tradingDate}|${level.symbol}`;
        if (breakEvenLevelKeys.has(key)) continue;
        breakEvenLevelKeys.add(key);
        breakEvenLevels.push(level);
      }
    };
    const optionSales: BacktestOptionSale[] = [];
    const days: SimulatedDay[] = [];
    // Pluto's system checks (the daily-loss breaker, market stress) ran with the rules only: their figures stay at zero.
    const runStatistics: BacktestRunStatistics = { looksRun: 0, daysWithIntradayLooks: 0, dailyLossBreakerTripDates: [], marketStressLooks: 0, marketStressDates: [], daysWithoutMarketStressBars: 0 };
    let actionCount = 0;
    const nextActionId = () => `action-${(actionCount += 1)}`;
    // Buy and hold: each symbol's pot, or the starting value in equal parts; a part waits in cash until its symbol has a price.
    let baselineCash = startingValue;
    const baselineDollarsOf = (symbol: string) => session.symbolSettings?.[symbol]?.potDollars ?? startingValue / symbols.length;
    const symbolOfLeg = (leg: LedgerLeg) => symbolByName.get(requirePosition(ledger, leg.positionId).symbol)!;
    /** A note about one symbol: named when the session has several. */
    const noteFor = (entry: SessionSymbol, text: string) => (severalSymbols ? `${entry.symbol}: ${text}` : text);
    let lastProgressAtMs = 0;
    let lastCancelCheckAtMs = 0;
    const startedAtMs = Date.now();

    /** The risk-free rate a day reads: DTB3 on or before the session day before it. */
    const riskFreeRatePercentOn = (dateIso: string) => rates.ratePercentOnOrBefore(addCalendarDays(dateIso, -1));
    /** F on a day: the symbol's own on a day its file holds, else the factor of the last segment before the date; null when it cannot be inferred. */
    const splitFactorOnDay = (entry: SessionSymbol, dateIso: string): number | null => entry.splitFactorByDay.get(dateIso) ?? splitFactorOn(entry.schedule, dateIso);
    /** The reader thread's copy of a symbol's file day, taken once, at the top of the day. */
    const takePrefetchedDay = async (entry: SessionSymbol, dateIso: string) => {
      if (entry.prefetchedDays.has(dateIso)) return;
      entry.prefetchedDays.set(dateIso, await dayDataReader.take(entry.symbol, dateIso, captureLookTimeEt));
      if (entry.prefetchedDays.size > 4) entry.prefetchedDays.delete(entry.prefetchedDays.keys().next().value!);
    };
    /** A file day's 10:00 capture (DayCapture), worked out once. */
    const captureOf = (entry: SessionSymbol, dateIso: string): DayCapture => {
      let capture = entry.captureByDay.get(dateIso);
      if (capture) return capture;
      const riskFreeRatePercent = riskFreeRatePercentOn(dateIso);
      const quotes = entry.prefetchedDays.get(dateIso)?.quotes() ?? entry.file.loadQuotes(dateIso);
      const adjustedPrice = entry.intradayPrices.priceAt(dateIso, captureLookTimeEt);
      const splitFactor = splitFactorOnDay(entry, dateIso);
      const stockPrice = adjustedPrice === null || splitFactor === null ? null : adjustedPrice * splitFactor;
      const previousFileDay = entry.previousFileDayOf.get(dateIso) ?? null;
      const previousSessionVolumeByContract = volumeByContract(previousFileDay === null ? null : entry.endOfDayRows(previousFileDay));
      const market = stockPrice !== null ? { todayIso: dateIso, quotes, openInterestByContract: entry.prefetchedDays.get(dateIso)?.openInterest() ?? entry.file.loadOpenInterest(dateIso), previousSessionVolumeByContract, stockPrice, riskFreeRatePercent } : null;
      capture = { quotes, stockPrice, previousSessionVolumeByContract, market };
      entry.captureByDay.set(dateIso, capture);
      if (entry.captureByDay.size > 3) entry.captureByDay.delete(entry.captureByDay.keys().next().value!);
      return capture;
    };
    for (let dayIndex = 0; dayIndex < sessionDays.length; dayIndex++) {
      const todayIso = sessionDays[dayIndex]!;
      const nowMs = Date.now();
      if (nowMs - lastCancelCheckAtMs >= cancelCheckIntervalMs) {
        lastCancelCheckAtMs = nowMs;
        if (await hooks.isCancelRequested()) throw new BacktestCancelledError();
      }
      if (nowMs - lastProgressAtMs >= progressIntervalMs) {
        lastProgressAtMs = nowMs;
        await hooks.reportProgress(dayIndex, sessionDays.length, `at ${todayIso}`);
      }
      // The reader thread reads each symbol's next days while this one runs; today's is taken before anything reads it.
      for (const entry of symbols) {
        const ownDayIndex = entry.ownSessionDays.indexOf(todayIso);
        const nextDayIndex = ownDayIndex === -1 ? entry.ownSessionDays.findIndex((dateIso) => dateIso > todayIso) : ownDayIndex;
        // A day already taken is not read again.
        if (nextDayIndex !== -1) for (const dateIso of entry.ownSessionDays.slice(nextDayIndex, nextDayIndex + prefetchDaysAhead)) if (!entry.prefetchedDays.has(dateIso)) dayDataReader.prefetch(entry.symbol, dateIso, captureLookTimeEt);
        if (ownDayIndex === -1) continue;
        await takePrefetchedDay(entry, todayIso);
      }
      const notes: string[] = [];
      const previousSessionDay = dayIndex > 0 ? sessionDays[dayIndex - 1]! : null;
      const skippedBeforeToday = skippedUnavailableDays.filter((dateIso) => dateIso < todayIso && (previousSessionDay === null || dateIso > previousSessionDay));
      if (skippedBeforeToday.length > 0) notes.push(`${skippedBeforeToday.length} day(s) before this one could not be downloaded and were skipped: ${skippedBeforeToday.join(", ")}`);
      const skippedAfterTheLastDay = dayIndex === sessionDays.length - 1 ? skippedUnavailableDays.filter((dateIso) => dateIso > todayIso) : [];
      if (skippedAfterTheLastDay.length > 0) notes.push(`${skippedAfterTheLastDay.length} day(s) after this one could not be downloaded and were skipped: ${skippedAfterTheLastDay.join(", ")}`);
      /** F today: the symbol's own on a day its file holds, else the factor of the last segment before the date. */
      const splitFactorToday = (entry: SessionSymbol): number => {
        const factor = entry.splitFactorByDay.get(todayIso) ?? splitFactorOn(entry.schedule, todayIso);
        if (factor === null) throw new Error(`${entry.symbol} ${todayIso}: the price scale of the day cannot be inferred from its data file.`);
        return factor;
      };

      // a. Settlement at 16:00 of the expiry day, on that day's close. An expiry on a day the market was closed settles on the
      // close of the session before it, OCC's rule (the options of 2025-01-09, a national day of mourning, settled on the
      // 2025-01-08 close); a session without a bar is missing data.
      for (const leg of ledgerLegsDueForSettlement(ledger, addCalendarDays(todayIso, -1))) {
        const owner = symbolOfLeg(leg);
        const expiryDate = leg.expiryDate!;
        const cycleSplitFactor = cycleSplitFactorFor(ledger, owner.symbol, splitFactorToday(owner));
        const splitFactorAtExpiry = splitFactorOn(owner.schedule, expiryDate);
        const contractLabel = describeOptionContract({ symbol: owner.symbol, strike: roundedStrike((leg.strikePrice! * (splitFactorAtExpiry ?? cycleSplitFactor)) / cycleSplitFactor), right: leg.optionType === "call" ? "C" : "P", expiry: expiryDate, dte: null });
        let settlementDate = expiryDate;
        let settlementClose = settlementCloseOnCycleScale(expiryDate, cycleSplitFactor, owner.bars, owner.intradayPrices);
        const marketClosedOnExpiry = !settlementClose && !calendar.isSession(expiryDate) && !owner.unavailableDaysInPeriod.includes(expiryDate);
        const sessionBeforeExpiry = marketClosedOnExpiry ? calendar.sessionBefore(expiryDate) : null;
        if (sessionBeforeExpiry !== null) {
          settlementDate = sessionBeforeExpiry;
          settlementClose = settlementCloseOnCycleScale(sessionBeforeExpiry, cycleSplitFactor, owner.bars, owner.intradayPrices);
        }
        if (!settlementClose) throw new Error(`Cannot settle ${contractLabel}: the ${owner.symbol} data file has no IBKR daily or 30-minute bar for ${settlementDate}. Press Update on its row in Data files and run the session again.`);
        if (settlementDate !== expiryDate) notes.push(noteFor(owner, `${contractLabel}: the market was closed on ${expiryDate}; settled on the ${settlementDate} close`));
        const sharesOnCycleScale = leg.quantity * leg.multiplier;
        const tradedScale = cycleSplitFactor / (splitFactorAtExpiry ?? cycleSplitFactor);
        const outcome = settleExpiry(ledger, { legId: leg.id, expiryClose: settlementClose.close });
        const closeAsTraded = (settlementClose.close / tradedScale).toFixed(2);
        const sharesAsTraded = Math.round(sharesOnCycleScale * tradedScale * 1_000_000) / 1_000_000;
        notes.push(
          outcome === "put_assigned"
            ? `${contractLabel} assigned at the ${closeAsTraded} close: ${sharesAsTraded} shares bought at the strike`
            : outcome === "call_away"
              ? `${contractLabel} assigned at the ${closeAsTraded} close: ${sharesAsTraded} shares called away at the strike`
              : `${contractLabel} expired worthless at the ${closeAsTraded} close${outcome === "call_worthless" ? `, ${sharesAsTraded} shares kept` : ""}`,
        );
        if (settlementClose.source === "intraday_bar") notes.push(noteFor(owner, `settled ${settlementDate} at the close of IBKR's last 30-minute bar (no daily bar)`));
        if (tradedScale !== 1) notes.push(`${contractLabel} was held across a split (×${Number(tradedScale.toFixed(4))}): settled on its cycle's scale at ${settlementClose.close.toFixed(2)}`);
      }
      // A hedge Put still held at its expiry (no quote let the hedge sell it before), or a LEAPS Call held to its expiry:
      // settled on the same close.
      const longOptionsDueBy = addCalendarDays(todayIso, -1);
      for (const leg of [...ledgerHedgeLegsDueForSettlement(ledger, longOptionsDueBy), ...ledgerLeapsLegsDueForSettlement(ledger, longOptionsDueBy)]) {
        const isLeaps = requirePosition(ledger, leg.positionId).strategyKey === "leaps";
        const owner = symbolOfLeg(leg);
        const expiryDate = leg.expiryDate!;
        const cycleSplitFactor = cycleSplitFactorFor(ledger, owner.symbol, splitFactorToday(owner));
        const closeOnExpiry = settlementCloseOnCycleScale(expiryDate, cycleSplitFactor, owner.bars, owner.intradayPrices);
        const settlementDate = closeOnExpiry || calendar.isSession(expiryDate) ? expiryDate : (calendar.sessionBefore(expiryDate) ?? expiryDate);
        const settlementClose = settlementDate === expiryDate ? closeOnExpiry : settlementCloseOnCycleScale(settlementDate, cycleSplitFactor, owner.bars, owner.intradayPrices);
        const tradedScale = cycleSplitFactor / (splitFactorOn(owner.schedule, expiryDate) ?? cycleSplitFactor);
        const contractLabel = describeOptionContract({ symbol: owner.symbol, strike: roundedStrike(leg.strikePrice! / tradedScale), right: isLeaps ? "C" : "P", expiry: expiryDate, dte: null });
        if (!settlementClose) throw new Error(`Cannot settle the ${isLeaps ? "LEAPS" : "hedge's"} ${contractLabel}: the ${owner.symbol} data file has no IBKR daily or 30-minute bar for ${settlementDate}. Press Update on its row in Data files and run the session again.`);
        const soldAtIntrinsic = isLeaps
          ? settleLeapsCall(ledger, { legId: leg.id, expiryClose: settlementClose.close }) === "leaps_sold_at_intrinsic"
          : settleHedgePut(ledger, { legId: leg.id, expiryClose: settlementClose.close }) === "hedge_sold_at_intrinsic";
        const intrinsic = isLeaps ? settlementClose.close - leg.strikePrice! : leg.strikePrice! - settlementClose.close;
        notes.push(`${isLeaps ? "LEAPS" : "hedge"} ${contractLabel} ${settings.decisionMaker === "vol_farmer" || settings.decisionMaker === "vol_farmer_v2" ? "held to its expiry" : "still held at its expiry (no quote to sell it at)"}: ${soldAtIntrinsic ? `sold at its intrinsic value, ${(intrinsic / tradedScale).toFixed(2)}` : "expired worthless"} at the ${(settlementClose.close / tradedScale).toFixed(2)} close`);
      }

      // b. Interest since the previous session day.
      let interestDollars = 0;
      let baselineInterestDollars = 0;
      const interestPeriod = previousSessionDay ? { ratePercent: rates.ratePercentOnOrBefore(previousSessionDay) ?? 0, calendarDays: calendarDaysBetween(previousSessionDay, todayIso) } : null;
      if (interestPeriod) {
        interestDollars = computeInterestDollars(ledger.cash, interestPeriod.ratePercent, interestPeriod.calendarDays);
        baselineInterestDollars = computeInterestDollars(baselineCash, interestPeriod.ratePercent, interestPeriod.calendarDays);
        creditInterest(ledger, new Date(decisionInstantMs(todayIso)), interestDollars);
        baselineCash += baselineInterestDollars;
      }
      const spyBaselineDay = spyBuyAndHold?.markDay(todayIso, spyPriceAtTen(todayIso), interestPeriod) ?? null;

      const hedgePutQuotesByKey = new Map<string, HedgePutQuoteSource>();
      const leapsCallQuotesBySymbol = new Map<string, HedgePutQuoteSource>();
      /** A symbol's 10:00 Calls of every listed expiry, for Vol Farmer v2's LEAPS (each read once a day and expiry); undefined for any other decision maker. */
      const leapsCallQuotesOf = (entry: SessionSymbol): HedgePutQuoteSource | undefined => {
        if (!leapsOn) return undefined;
        let source = leapsCallQuotesBySymbol.get(entry.symbol);
        if (!source) {
          let expiries: string[] | null = null;
          const quotesByExpiry = new Map<string, SymbolFileQuote[]>();
          source = {
            listedExpiries: () => (expiries ??= entry.file.loadCallExpiries(todayIso)),
            quotesOf: (expiry) => quotesByExpiry.get(expiry) ?? quotesByExpiry.set(expiry, entry.file.loadCallQuotesOfExpiry(todayIso, expiry)).get(expiry)!,
          };
          leapsCallQuotesBySymbol.set(entry.symbol, source);
        }
        return source;
      };
      const listedPutExpiriesBySymbol = new Map<string, string[]>();
      /** A symbol's long-dated Puts at a look, for the hedge (each read once a day, look and expiry); undefined when the hedge is off for it. */
      const hedgePutQuotesAt = (entry: SessionSymbol, lookTimeEt: string): HedgePutQuoteSource | undefined => {
        if (!hedgeOnFor(entry.symbol)) return undefined;
        const key = `${entry.symbol}|${lookTimeEt}`;
        let source = hedgePutQuotesByKey.get(key);
        if (!source) {
          const quotesByExpiry = new Map<string, SymbolFileQuote[]>();
          source = {
            listedExpiries: () => listedPutExpiriesBySymbol.get(entry.symbol) ?? listedPutExpiriesBySymbol.set(entry.symbol, entry.file.loadPutExpiries(todayIso)).get(entry.symbol)!,
            quotesOf: (expiry) => quotesByExpiry.get(expiry) ?? quotesByExpiry.set(expiry, lookTimeEt === captureLookTimeEt ? entry.file.loadPutQuotesOfExpiry(todayIso, expiry) : entry.file.loadIntradayPutQuotesOfExpiry(todayIso, lookTimeEt, expiry)).get(expiry)!,
          };
          hedgePutQuotesByKey.set(key, source);
        }
        return source;
      };
      /** The hedge's Puts and Vol Farmer v2's LEAPS Calls the 10:00 quotes left unmarked (past the 45-day window): marked from their own expiry's 10:00 quotes. Returns the legs still unmarked. */
      const markLongDatedOptionLegs = (entry: SessionSymbol, legs: readonly LedgerLeg[], splitFactor: number): LedgerLeg[] => {
        const priceToCycleScale = cycleSplitFactorFor(ledger, entry.symbol, splitFactor) / splitFactor;
        return legs.filter((leg) => {
          if (leg.side !== "long" || leg.legType !== "option") return true;
          const source = leg.optionType === "call" ? leapsCallQuotesOf(entry) : hedgePutQuotesAt(entry, captureLookTimeEt);
          if (!source) return true;
          const strikeAsTraded = leg.strikePrice! / priceToCycleScale;
          const mid = markMidByContract(source.quotesOf(leg.expiryDate!), new Set([roundedStrike(strikeAsTraded)])).get(markKey(leg.expiryDate!, strikeAsTraded, leg.optionType === "call" ? "C" : "P"));
          if (mid === undefined) return true;
          priceByLegId.set(leg.id, mid * priceToCycleScale);
          return false;
        });
      };

      // c. The 10:00 marks, symbol by symbol, and the symbols the day's looks read.
      const openLegs = openLegsOf(ledger);
      /**
       * Marks a symbol's open legs at a stock price and the quotes of the same instant; an option those quotes lack (or
       * quote with no bid) keeps its last mark. Returns those options.
       */
      const markLegs = (entry: SessionSymbol, legsOfSymbol: readonly LedgerLeg[], stockPrice: number, quotes: readonly SymbolFileQuote[], splitFactor: number): LedgerLeg[] => {
        if (legsOfSymbol.length === 0) return [];
        const priceToCycleScale = cycleSplitFactorFor(ledger, entry.symbol, splitFactor) / splitFactor;
        const midByContract = markMidByContract(quotes, new Set(legsOfSymbol.flatMap((leg) => (leg.legType === "stock" ? [] : [roundedStrike(leg.strikePrice! / priceToCycleScale)]))));
        const unmarked: LedgerLeg[] = [];
        for (const leg of legsOfSymbol) {
          if (leg.legType === "stock") priceByLegId.set(leg.id, stockPrice * priceToCycleScale);
          else {
            const mid = midByContract.get(markKey(leg.expiryDate!, leg.strikePrice! / priceToCycleScale, leg.optionType === "call" ? "C" : "P"));
            if (mid !== undefined) priceByLegId.set(leg.id, mid * priceToCycleScale);
            else unmarked.push(leg);
          }
        }
        return unmarked;
      };
      /**
       * The day's mark of options the 10:00 quotes left unmarked (approved by Marcelo 2026-10-13): the first two-sided quote
       * later that day, the snapshots after 10:00 in time order, then the close; none when none turns up (the option then
       * keeps its last mark). It goes into the day's value only: the 10:00 decisions keep the last mark, so nothing from
       * later in the day steers them; once the day's looks are done it becomes the option's mark.
       */
      const laterMarksOfDay = (entry: SessionSymbol, legs: readonly LedgerLeg[], splitFactor: number): Map<string, number> => {
        const priceToCycleScale = cycleSplitFactorFor(ledger, entry.symbol, splitFactor) / splitFactor;
        const strikes = legs.map((leg) => leg.strikePrice! / priceToCycleScale);
        const lowestStrike = Math.min(...strikes) - 0.005;
        const highestStrike = Math.max(...strikes) + 0.005;
        const closeEt = clockTime(closeMinutesByDay.get(todayIso) ?? regularCloseMinutesEt);
        const snapshots = entry.intradayDays.has(todayIso) ? (entry.prefetchedDays.get(todayIso)?.intradayQuotes(captureLookTimeEt, closeEt, lowestStrike, highestStrike) ?? entry.file.loadIntradayQuotes(todayIso, captureLookTimeEt, closeEt, lowestStrike, highestStrike)) : new Map<string, SymbolFileQuote[]>();
        const quoteSets = [...[...snapshots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, quotes]) => quotes), entry.endOfDayRows(todayIso)];
        const contractOf = (leg: LedgerLeg) => ({ expiry: leg.expiryDate!, strike: leg.strikePrice! / priceToCycleScale, right: leg.optionType === "call" ? ("C" as const) : ("P" as const) });
        const midByContract = firstTwoSidedMids(quoteSets, legs.map(contractOf));
        const marks = new Map<string, number>();
        for (const leg of legs) {
          const contract = contractOf(leg);
          const mid = midByContract.get(markKey(contract.expiry, contract.strike, contract.right));
          if (mid !== undefined) marks.set(leg.id, mid * priceToCycleScale);
        }
        return marks;
      };
      /** Options the 10:00 quotes left unmarked: their later mark of the day, and the mark they kept for the decisions. */
      const laterMarkByLegId = new Map<string, number>();
      const decisionMarkByLegId = new Map<string, number | undefined>();
      /** The symbols scored today, each with its 10:00 capture. */
      const daySymbols: { entry: SessionSymbol; lookSymbol: BacktestLookSymbol; splitFactor: number }[] = [];
      let nothingScoredReason = "no symbol could be scored";
      let baselineSharesValue = 0;
      for (const entry of symbols) {
        while (entry.closesBeforeTodayCount < entry.adjustedDailyCloses.length && entry.adjustedDailyCloses[entry.closesBeforeTodayCount]!.date < todayIso) entry.closesBeforeTodayCount += 1;
        const hasFileDay = entry.completeDays.has(todayIso);
        const splitFactor = splitFactorToday(entry);
        // A split since the open cycle began: its open options become today's contracts on the cycle's share scale.
        const aligned = alignOpenOptionLegsToSplitFactor(ledger, entry.symbol, splitFactor);
        if (!aligned.representable) notes.push(noteFor(entry, "the open cycle spans a split whose contracts do not fit its share scale: no option order until it ends"));
        const previousFileDay = hasFileDay ? (entry.previousFileDayOf.get(todayIso) ?? null) : null;
        const capture = hasFileDay ? captureOf(entry, todayIso) : null;
        const quotes = capture?.quotes ?? [];
        const tenOclockPrice = capture?.stockPrice ?? null;
        const adjustedFallbackPrice: number | null = tenOclockPrice !== null ? null : (entry.bars.previousClose(todayIso)?.close ?? entry.lastAdjustedStockPrice);
        const stockPrice: number | null = tenOclockPrice ?? (adjustedFallbackPrice === null ? null : adjustedFallbackPrice * splitFactor);
        const legsOfSymbol = openLegs.filter((leg) => symbolOfLeg(leg) === entry);
        if (stockPrice === null) {
          if (legsOfSymbol.length > 0 || !severalSymbols) throw new Error(`${entry.symbol} ${todayIso}: no IBKR 10:00 price and no earlier close to mark the account with.`);
          notes.push(noteFor(entry, "not scored: no data for the day and no earlier close"));
          continue;
        }
        const unmarkedByTheDayQuotes = markLegs(entry, legsOfSymbol, stockPrice, quotes, splitFactor);
        const unmarkedAtCapture = unmarkedByTheDayQuotes.length > 0 && hasFileDay && (hedgeOnFor(entry.symbol) || leapsOn) ? markLongDatedOptionLegs(entry, unmarkedByTheDayQuotes, splitFactor) : unmarkedByTheDayQuotes;
        if (unmarkedAtCapture.length > 0 && hasFileDay) {
          for (const [legId, mark] of laterMarksOfDay(entry, unmarkedAtCapture, splitFactor)) {
            laterMarkByLegId.set(legId, mark);
            decisionMarkByLegId.set(legId, priceByLegId.get(legId));
          }
        }
        entry.lastAdjustedStockPrice = stockPrice / splitFactor;

        // e. Buy and hold: the symbol's part in whole shares on its first day with a price (as traded that day).
        if (!entry.baseline.bought) {
          entry.baseline = { shares: Math.floor(baselineDollarsOf(entry.symbol) / stockPrice), splitFactorAtPurchase: splitFactor, bought: true };
          baselineCash -= entry.baseline.shares * stockPrice;
        }
        baselineSharesValue += (entry.baseline.shares * stockPrice * entry.baseline.splitFactorAtPurchase) / splitFactor;

        if (!hasFileDay) {
          notes.push(noteFor(entry, `not scored: ${entry.unavailableDaysInPeriod.includes(todayIso) ? "the day could not be downloaded" : todayIso > entry.lastCompleteDay ? `its data file ends ${entry.lastCompleteDay}` : "no data for the day"}; marked at the previous close ${stockPrice.toFixed(2)}`));
          continue;
        }
        if (tenOclockPrice === null) {
          const reason = `no IBKR 30-minute bar ending by 10:00; marked at the previous close ${stockPrice.toFixed(2)}`;
          if (severalSymbols) notes.push(noteFor(entry, `not scored: ${reason}`));
          else nothingScoredReason = reason;
          continue;
        }
        const previousBarDate = entry.bars.previousClose(todayIso)?.dateIso ?? null;
        if (previousFileDay !== null && previousBarDate !== null && previousBarDate < previousFileDay) notes.push(noteFor(entry, `IBKR bars end ${previousBarDate}: the forecast and the day's move use that close`));
        const previousSessionVolumeByContract = capture!.previousSessionVolumeByContract;
        notes.push(...describeDataGaps(entry.file, todayIso, previousFileDay, previousSessionVolumeByContract).map((note) => noteFor(entry, note)));
        const hedgePutQuotes = hedgePutQuotesAt(entry, captureLookTimeEt);
        const leapsCallQuotes = leapsCallQuotesOf(entry);
        const nextSessionIso = sessionDays[dayIndex + 1];
        daySymbols.push({
          entry,
          splitFactor,
          lookSymbol: {
            profile: entry.profile,
            bars: entry.barsOnTradedScale(splitFactor),
            market: capture!.market!,
            splitFactorToday: splitFactor,
            splitFactorNextSession: nextSessionIso === undefined ? splitFactor : (splitFactorOnDay(entry, nextSessionIso) ?? splitFactor),
            optionContractsRepresentable: aligned.representable,
            adjustedDailyClosesBeforeToday: entry.adjustedDailyCloses.slice(0, entry.closesBeforeTodayCount),
            ...(hedgePutQuotes ? { hedgePutQuotes } : {}),
            ...(leapsCallQuotes ? { leapsCallQuotes } : {}),
          },
        });
      }
      const accountValueForDecisions = ledgerNetLiquidationValue(ledger, priceByLegId);
      const sharesValueDollars = ledgerSharesValue(ledger, priceByLegId);
      // A baseline session may leave open options out of the day's value (dayValueOptions "excluded"): cash, premiums
      // included, and shares at the 10:00 price; the options held at the end are valued apart from the account.
      const optionsLeftOut = settings.decisionMaker === "baseline" && settings.baseline.dayValueOptions === "excluded";
      const accountValue = optionsLeftOut
        ? ledgerNetLiquidationValue(ledger, new Map([...priceByLegId, ...openLegsOf(ledger).filter((leg) => leg.legType === "option").map((leg) => [leg.id, 0] as const)]))
        : laterMarkByLegId.size === 0
          ? accountValueForDecisions
          : ledgerNetLiquidationValue(ledger, new Map([...priceByLegId, ...laterMarkByLegId]));
      const cashAtMark = ledger.cash;
      const exposureDollars = ledgerCommittedDollars(ledger);
      const baselineValue = baselineSharesValue + baselineCash;

      // d. The looks inside Pluto's window, over every symbol of the day.
      const lookTimes = lookTimesInWindow(pluto.windowStartEt, pluto.windowEndEt, closeMinutesByDay.get(todayIso) ?? regularCloseMinutesEt);
      const laterLookTimes = lookTimes.filter((lookTimeEt) => lookTimeEt > captureLookTimeEt);
      const modelTables = tables.tablesFor(todayIso);
      /** A symbol's quotes at the looks after 10:00, read once, at the first of them. */
      const intradayQuotesBySymbol = new Map<string, Map<string, SymbolFileQuote[]>>();
      const intradayQuotesOf = (entry: SessionSymbol, stockPriceAtCapture: number, splitFactor: number): Map<string, SymbolFileQuote[]> => {
        let quotesByLookTime = intradayQuotesBySymbol.get(entry.symbol);
        if (!quotesByLookTime) {
          const priceToCycleScale = cycleSplitFactorFor(ledger, entry.symbol, splitFactor) / splitFactor;
          const heldStrikes = openLegsOf(ledger).filter((leg) => leg.legType === "option" && symbolOfLeg(leg) === entry).map((leg) => leg.strikePrice! / priceToCycleScale);
          const lowestStrike = Math.min(stockPriceAtCapture * lookStrikeRangeOfStockPrice.lowest, ...heldStrikes) - 0.005;
          const highestStrike = Math.max(stockPriceAtCapture * lookStrikeRangeOfStockPrice.highest, ...heldStrikes) + 0.005;
          quotesByLookTime = entry.prefetchedDays.get(todayIso)?.intradayQuotes(captureLookTimeEt, laterLookTimes.at(-1)!, lowestStrike, highestStrike) ?? entry.file.loadIntradayQuotes(todayIso, captureLookTimeEt, laterLookTimes.at(-1)!, lowestStrike, highestStrike);
          intradayQuotesBySymbol.set(entry.symbol, quotesByLookTime);
        }
        return quotesByLookTime;
      };
      const looksOfDay: DayLookSummary[] = [];
      let filledActionsToday = 0;
      let lookedAfterCapture = false;
      /** The Vol Farmer: unwinds a position whose Call's strike today's bars reached, by `throughEt`, before the look that reads it (none when its Calls are held to expiry). */
      const scanVolFarmerCrossings = (throughEt: string) => {
        if (settings.decisionMaker !== "vol_farmer" || settings.volFarmer.crossing === "hold_to_expiry") return;
        for (const entry of symbols) {
          const crossing = scanVolFarmerCrossing({ ledger, symbol: entry.symbol, todayIso, adjustedBars: entry.intradayPrices.barsOn(todayIso), splitFactorToday: splitFactorToday(entry), throughEt, riskFreeRate: (riskFreeRatePercentOn(todayIso) ?? 0) / 100, priceByLegId, nextActionId, onlyIfCycleNetPositive: settings.volFarmer.crossing === "unwind_if_net_positive" });
          if (crossing === null) continue;
          actions.push(...crossing.actions);
          filledActionsToday += crossing.actions.length;
          // A crossing held (no actions) is an unwind refused: the day's summary shows it.
          looksOfDay.push({ lookTimeEt: crossing.lookTimeEt, summary: crossing.summary, filledCount: crossing.actions.length, refusedCount: crossing.actions.length === 0 ? 1 : 0, opensStopped: [] });
        }
      };
      // The Steady Stake and Vol Farmer v2 decide at 10:00 only, the Vol Farmer too but reads every look's quotes (the IVs
      // a crossing is priced on), the baseline at every look unless its looks say the first only.
      const decidesAtCaptureLookOnly = settings.decisionMaker === "baseline" ? settings.baseline.looks === "first_look" : settings.decisionMaker === "steady_stake" || settings.decisionMaker === "vol_farmer_v2";
      const runLook = settings.decisionMaker === "baseline" ? runBaselineLook : settings.decisionMaker === "steady_stake" ? runSteadyStakeLook : settings.decisionMaker === "vol_farmer_v2" ? runVolFarmerV2Look : runVolFarmerLook;
      for (const lookTimeEt of lookTimes) {
        const isCaptureLook = lookTimeEt === captureLookTimeEt;
        scanVolFarmerCrossings(lookTimeEt);
        const lookSymbols: BacktestLookSymbol[] = [];
        if (isCaptureLook) lookSymbols.push(...daySymbols.map((daySymbol) => daySymbol.lookSymbol));
        else {
          const openLegsAtLook = openLegsOf(ledger);
          for (const { entry, lookSymbol, splitFactor } of daySymbols) {
            if (!entry.intradayDays.has(todayIso)) continue;
            const quotes = intradayQuotesOf(entry, lookSymbol.market.stockPrice, splitFactor).get(lookTimeEt);
            const adjustedPrice = entry.intradayPrices.priceAt(todayIso, lookTimeEt);
            const lookPrice = adjustedPrice === null ? null : adjustedPrice * splitFactorToday(entry);
            // Without this look's quotes or an IBKR price then, the symbol keeps its last marks and is left out of the look.
            if (!quotes || lookPrice === null) continue;
            markLegs(entry, openLegsAtLook.filter((leg) => symbolOfLeg(leg) === entry), lookPrice, quotes, splitFactor);
            entry.lastAdjustedStockPrice = lookPrice / splitFactor;
            const hedgePutQuotes = hedgePutQuotesAt(entry, lookTimeEt);
            lookSymbols.push({ ...lookSymbol, intraday: { quotes, stockPrice: lookPrice }, ...(hedgePutQuotes ? { hedgePutQuotes } : {}) });
          }
        }
        if (lookSymbols.length === 0) continue;
        if (decidesAtCaptureLookOnly && !isCaptureLook) continue;
        const look = await runLook({ todayIso, lookTimeEt, symbols: lookSymbols, sectorBySymbol, calendar, settings, modelTables, ledger, previousSessionDateIso: previousSessionDay, priceByLegId, nextActionId, ...(tickerSetupBySymbol ? { tickerSetupBySymbol } : {}) });
        actions.push(...look.actions);
        optionSales.push(...look.optionSales);
        if (look.shortfalls) keepShortfalls(look.shortfalls);
        if (look.ladderLevels) keepLadderLevels(look.ladderLevels);
        if (look.breakEvenLevels) keepBreakEvenLevels(look.breakEvenLevels);
        if (look.noSaleNotes) for (const note of look.noSaleNotes) noSaleNotes.push(note);
        if (look.noCandidateNotes) keepNoCandidateNotes(look.noCandidateNotes);
        const filledAtLook = look.actions.filter((action) => action.outcome === "filled").length;
        filledActionsToday += filledAtLook;
        looksOfDay.push({ lookTimeEt, summary: look.summaryOfActions, filledCount: filledAtLook, refusedCount: look.actions.length - filledAtLook, opensStopped: look.opensStopped });
        if (!isCaptureLook) lookedAfterCapture = true;
      }
      scanVolFarmerCrossings(clockTime(closeMinutesByDay.get(todayIso) ?? regularCloseMinutesEt));
      if (lookedAfterCapture) runStatistics.daysWithIntradayLooks += 1;
      runStatistics.looksRun += looksOfDay.length;
      const summaryParts = looksOfDay.length > 0 ? summarizeDayLooks(looksOfDay) : [`No action: ${daySymbols.length > 0 ? `no look inside the trading window ${pluto.windowStartEt}–${pluto.windowEndEt} ET has quotes` : nothingScoredReason}`];
      // The day is recorded as marked at 10:00, before its looks: an action's cash and exposure show from the next day.
      days.push({ tradingDate: todayIso, accountValue, cash: cashAtMark, exposureDollars, sharesValueDollars, interestDollars, baselineValue, baselineExposureDollars: baselineSharesValue, baselineInterestDollars, spyBaselineValue: spyBaselineDay?.value ?? null, spyBaselineExposureDollars: spyBaselineDay?.exposureDollars ?? null, spyBaselineInterestDollars: spyBaselineDay?.interestDollars ?? null, decisionSummary: [...summaryParts, ...notes].join(" · "), looksRun: looksOfDay.length, actionsTaken: filledActionsToday });

      // The later marks of the day replace the ones the 10:00 decisions kept, unless a later look marked the option since.
      const openLegIdsAfterLooks = new Set(openLegsOf(ledger).map((leg) => leg.id));
      for (const [legId, mark] of laterMarkByLegId) {
        if (openLegIdsAfterLooks.has(legId) && priceByLegId.get(legId) === decisionMarkByLegId.get(legId)) priceByLegId.set(legId, mark);
      }
    }
    const elapsedSeconds = (Date.now() - startedAtMs) / 1000;
    const lastSessionDateIso = sessionDays.at(-1)!;
    // What the run tells about the session as a whole.
    const sessionNotes: string[] = [];
    const lookTimesOfFullDay = lookTimesInWindow(pluto.windowStartEt, pluto.windowEndEt, regularCloseMinutesEt);
    sessionNotes.push(`Looks: ${lookTimesOfFullDay.length === 0 ? `none: the trading window ${pluto.windowStartEt}–${pluto.windowEndEt} ET holds none of the half hours 10:00 to 15:30` : `${lookTimesOfFullDay.join(", ")} ET on a full day (window ${pluto.windowStartEt}–${pluto.windowEndEt} ET, never later than 30 minutes before the close)`}; ${formatCount(runStatistics.looksRun)} run over ${formatCount(sessionDays.length)} days.`);
    if (lookTimesOfFullDay.some((lookTimeEt) => lookTimeEt > captureLookTimeEt)) {
      for (const entry of symbols) {
        const ownSessionDays = sessionDays.filter((dateIso) => entry.completeDays.has(dateIso));
        const daysWithoutIntradayQuotes = ownSessionDays.filter((dateIso) => !entry.intradayDays.has(dateIso)).length;
        if (daysWithoutIntradayQuotes > 0) sessionNotes.push(describeDaysWithoutIntradayQuotes(entry.symbol, daysWithoutIntradayQuotes, ownSessionDays.length));
      }
    }
    const spyPurchase = spyBuyAndHold?.purchase ?? null;
    sessionNotes.push(
      spyPurchase === null
        ? `Buy and hold of SPY (comparison only) is not shown: the local DB has no SPY price for the session's days (npm run backtest:backfill-market-stress-bars).`
        : `Buy and hold of SPY (comparison only): ${formatCount(spyPurchase.shares)} shares at ${spyPurchase.price.toFixed(2)} on ${spyPurchase.dateIso}, SPY's price at 10:00, the rest in cash at the same interest; dividends not counted${spyBuyAndHold!.daysMarkedAtAnEarlierPrice > 0 ? `; ${formatCount(spyBuyAndHold!.daysMarkedAtAnEarlierPrice)} day(s) without a SPY price marked at the last one` : ""}.`,
    );
    sessionNotes.push(`Buy and hold of ${symbols.map((entry) => entry.symbol).join(", ")} (comparison only): the starting value in equal parts, whole shares at each symbol's first 10:00 price, never rebalanced; dividends not counted.`);
    if (skippedUnavailableDays.length > 0) sessionNotes.push(`${formatCount(skippedUnavailableDays.length)} day(s) inside the period could not be downloaded for any symbol and were skipped: ${skippedUnavailableDays.join(", ")}.`);
    if (symbols.some((entry) => hedgeOnFor(entry.symbol))) {
      runStatistics.hedge = summarizeHedge(ledger, actions, priceByLegId);
      sessionNotes.push(describeHedgeTotals(runStatistics.hedge));
    }
    const volFarmerCashNote = settings.decisionMaker === "vol_farmer" ? describeVolFarmerCash(ledger, symbols.map((entry) => entry.symbol)) : null;
    if (volFarmerCashNote !== null) sessionNotes.push(volFarmerCashNote);
    const volFarmerV2Note = settings.decisionMaker === "vol_farmer_v2" ? describeVolFarmerV2Run(ledger, symbols.map((entry) => entry.symbol)) : null;
    if (volFarmerV2Note !== null) sessionNotes.push(volFarmerV2Note);
    const bookRecords = buildBookRecords({ ledger, symbols, optionSales, actions, priceByLegId, lastSessionDateIso, calendar, noSaleRecords: { shortfalls, notes: noSaleNotes, noCandidates: noCandidateNotes } });
    // The book holds every share it sells (the ledger refuses anything else); the platform's cycle derivation reading it
    // must agree. A cycle whose shares do not reconcile is named in the notes, its figures not to be trusted.
    const unreconciledCycles = bookRecords.cycles.filter((cycle) => cycle.dataFlags.some(isShareReconciliationFlag));
    if (unreconciledCycles.length > 0) sessionNotes.push(`The cycle figures do not reconcile with the book's shares for ${unreconciledCycles.map((cycle) => `${cycle.symbol} cycle ${cycle.cycleNumber} (${cycle.dataFlags.filter(isShareReconciliationFlag).join("; ")})`).join(", ")}: their P&L is not to be trusted.`);
    const result: SimulatedSessionResult = {
      days,
      trades: buildOptionTrades(ledger, optionSales, actions, bookRecords.positions, bookRecords.cycles),
      ...bookRecords,
      actions,
      shortfalls,
      ladderLevels,
      breakEvenLevels,
      notes: sessionNotes,
      runStatistics,
    };
    console.log(`backtest ${sessionId}: ${symbols.length} symbol(s), ${sessionDays.length} days, ${runStatistics.looksRun} looks, ${actions.filter((action) => action.outcome === "filled").length} actions, ${result.trades.length} options sold, ${result.cycles.length} cycles in ${elapsedSeconds.toFixed(1)} s (${((elapsedSeconds / sessionDays.length) * 1000).toFixed(0)} ms a day)`);
    await hooks.reportProgress(sessionDays.length, sessionDays.length, `Saving ${formatCount(sessionDays.length)} days${skippedUnavailableDays.length > 0 ? ` (${formatCount(skippedUnavailableDays.length)} unavailable skipped)` : ""} and ${formatCount(result.trades.length)} trades`);
    await persistSessionResult(sessionId, startingValue, result, dataLastDate, connection);
  } finally {
    for (const file of files) file.close();
    await dayDataReader.close();
  }
}

/** A cycle flag saying its shares do not add up (src/lib/cycles.ts trust checks). */
export const isShareReconciliationFlag = (flag: string): boolean => / sh sold\/called away that the ledger never acquired$|^cycle closed with \d+ sh unaccounted|^ledger says \d+ sh held but/.test(flag);

/** The positions, fills, cycles and gaps of the finished ledger, marked at the session's last look. */
function buildBookRecords(input: { ledger: SimulatedLedger; symbols: readonly SessionSymbol[]; optionSales: readonly BacktestOptionSale[]; actions: readonly BacktestAction[]; priceByLegId: ReadonlyMap<string, number>; lastSessionDateIso: string; calendar: BacktestTradingCalendar; noSaleRecords: NoSaleRecords }): Pick<SimulatedSessionResult, "positions" | "fills" | "cycles" | "cycleGaps"> {
  const scheduleBySymbol = new Map(input.symbols.map((entry) => [entry.symbol, entry.schedule]));
  // Cycles are valued like the account: the shares still held at the symbol's last mark, not a later close.
  const closesThroughLastLook = (entry: SessionSymbol) => [...entry.adjustedDailyCloses.filter((bar) => bar.date < input.lastSessionDateIso), ...(entry.lastAdjustedStockPrice === null ? [] : [{ date: input.lastSessionDateIso, close: entry.lastAdjustedStockPrice }])];
  const recordInputs = {
    ledger: input.ledger,
    symbols: input.symbols.map((entry) => entry.symbol),
    optionSales: input.optionSales,
    actions: input.actions,
    priceByLegId: input.priceByLegId,
    adjustedDailyClosesBySymbol: new Map(input.symbols.map((entry) => [entry.symbol, closesThroughLastLook(entry)])),
    splitFactorOn: (symbol: string, dateIso: string) => splitFactorOn(scheduleBySymbol.get(symbol)!, dateIso),
    calendar: input.calendar,
    lastSessionDateIso: input.lastSessionDateIso,
    sessionDaysBySymbol: new Map(input.symbols.flatMap((entry) => (entry.ownSessionDays.length === 0 ? [] : [[entry.symbol, { firstDay: entry.ownSessionDays[0]!, lastDay: entry.ownSessionDays.at(-1)! }] as const]))),
    allAdjustedDailyClosesBySymbol: new Map(input.symbols.map((entry) => [entry.symbol, entry.adjustedDailyCloses])),
    noSaleRecords: input.noSaleRecords,
  };
  const cycles = buildCycleRecords(recordInputs);
  return { positions: buildPositionRecords(recordInputs).map((position) => withPositionCycle(position, cycles)), fills: buildFillRecords(recordInputs), cycles, cycleGaps: buildCycleGapRecords(recordInputs, cycles) };
}

/**
 * The session's own series and its buy-and-hold series, measured with the same formulas. The session's win rate,
 * averages and edge capture are its wheel cycles' (sessionAnalytics.ts): `trades` are its options sold, each naming its
 * cycle, and `cycles` its cycles.
 */
export function computeSessionMetrics(startingValue: number, days: readonly SimulatedDay[], trades: readonly SimulatedTrade[], cycles: readonly BacktestCycle[]) {
  const sessionDays: AccountDay[] = days.map((day) => ({ tradingDate: day.tradingDate, value: day.accountValue, exposureDollars: day.exposureDollars, interestDollars: day.interestDollars }));
  const baselineDays: AccountDay[] = days.map((day) => ({ tradingDate: day.tradingDate, value: day.baselineValue, exposureDollars: day.baselineExposureDollars, interestDollars: day.baselineInterestDollars }));
  const hasSpyBaseline = days.length > 0 && days.every((day) => day.spyBaselineValue !== null);
  const spyBaselineDays: AccountDay[] = hasSpyBaseline ? days.map((day) => ({ tradingDate: day.tradingDate, value: day.spyBaselineValue!, exposureDollars: day.spyBaselineExposureDollars ?? 0, interestDollars: day.spyBaselineInterestDollars ?? 0 })) : [];
  return {
    metrics: computeBacktestMetrics(sessionDays, { optionSales: trades, cycles: cycleFiguresOf(cycles, trades) }, startingValue),
    baselineMetrics: computeBacktestMetrics(baselineDays, null, startingValue),
    spyBaselineMetrics: hasSpyBaseline ? computeBacktestMetrics(spyBaselineDays, null, startingValue) : null,
  };
}

const sessionResultTables = ["backtest_session_days", "backtest_trades", "backtest_positions", "backtest_position_legs", "backtest_fills", "backtest_actions", "backtest_cycles", "backtest_cycle_gaps", "backtest_look_shortfalls", "backtest_ladder_levels", "backtest_break_even_levels"] as const;

async function clearSessionResult(sessionId: string, connection: Knex): Promise<void> {
  for (const table of sessionResultTables) await connection(table).where({ session_id: sessionId }).delete();
}

async function persistSessionResult(sessionId: string, startingValue: number, result: SimulatedSessionResult, dataLastDate: string | null, connection: Knex): Promise<void> {
  const { days, trades } = result;
  const { metrics, baselineMetrics, spyBaselineMetrics } = computeSessionMetrics(startingValue, days, trades, result.cycles);
  const dailyReturns = computeDailyReturns(days.map((day) => day.accountValue));
  const baselineDailyReturns = computeDailyReturns(days.map((day) => day.baselineValue));
  const spyBaselineDailyReturns = spyBaselineMetrics === null ? null : computeDailyReturns(days.map((day) => day.spyBaselineValue!));
  const dayRows = days.map((day, index) => ({
    session_id: sessionId,
    trading_date: day.tradingDate,
    account_value: day.accountValue,
    cash: day.cash,
    exposure_dollars: day.exposureDollars,
    shares_value_dollars: day.sharesValueDollars,
    interest_dollars: day.interestDollars,
    daily_return: dailyReturns[index],
    baseline_value: day.baselineValue,
    baseline_daily_return: baselineDailyReturns[index],
    spy_baseline_value: day.spyBaselineValue,
    spy_baseline_daily_return: spyBaselineDailyReturns?.[index] ?? null,
    decision_summary: day.decisionSummary,
    looks_run: day.looksRun,
    actions_taken: day.actionsTaken,
  }));
  const tradeRows = trades.map((trade) => ({
    session_id: sessionId,
    symbol: trade.symbol,
    leg_id: trade.legId,
    ended_by: trade.endedBy,
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
    position_id: trade.positionId,
    position_status: trade.positionStatus,
    position_pnl_dollars: trade.positionPnlDollars,
    cycle_number: trade.cycleNumber,
    cycle_status: trade.cycleStatus,
    cycle_total_dollars: trade.cycleTotalDollars,
  }));
  const positionRows = result.positions.map((position, sequence) => ({
    session_id: sessionId,
    position_id: position.positionId,
    sequence,
    symbol: position.symbol,
    strategy_key: position.strategyKey,
    status: position.status,
    opened_at: position.openedAt,
    closed_at: position.closedAt,
    close_reason: position.closeReason,
    unstructured_reason: position.unstructuredReason,
    capital_at_risk_dollars: position.capitalAtRiskDollars,
    capital_deployed_dollars: position.capitalDeployedDollars,
    realized_pnl_dollars: position.realizedPnlDollars,
    realized_premium_pnl_dollars: position.realizedPremiumPnlDollars,
    realized_stock_pnl_dollars: position.realizedStockPnlDollars,
    unrealized_pnl_dollars: position.unrealizedPnlDollars,
    share_source_position_ids: JSON.stringify(position.shareSourcePositionIds),
  }));
  const legRows = result.positions
    .flatMap((position) => position.legs.map((leg) => ({ position, leg })))
    .map(({ position, leg }, sequence) => ({
      session_id: sessionId,
      leg_id: leg.legId,
      sequence,
      position_id: position.positionId,
      parent_leg_id: leg.parentLegId,
      leg_type: leg.legType,
      side: leg.side,
      quantity: leg.quantity,
      option_type: leg.optionType,
      strike_price: leg.strike,
      expiry_date: leg.expiry,
      multiplier: leg.multiplier,
      entry_price: leg.entryPrice,
      entry_at: leg.entryAt,
      exit_price: leg.exitPrice,
      exit_at: leg.exitAt,
      settled_as: leg.settledAs,
      expiry_close: leg.expiryClose,
      dte_at_entry: leg.dteAtEntry,
      realized_pnl_dollars: leg.realizedPnlDollars,
      price_scale: leg.priceScale,
    }));
  const fillRows = result.fills.map((fill, sequence) => ({
    session_id: sessionId,
    fill_id: fill.fillId,
    sequence,
    position_id: fill.positionId,
    leg_id: fill.legId,
    symbol: fill.symbol,
    instrument: fill.instrument,
    side: fill.side,
    quantity: fill.quantity,
    multiplier: fill.multiplier,
    price: fill.price,
    price_scale: fill.priceScale,
    commission_dollars: fill.commissionDollars,
    executed_at: fill.executedAt,
    trading_date: fill.tradingDate,
    is_closing: fill.isClosing,
    action_id: fill.actionId,
  }));
  const actionRows = result.actions.map((action, sequence) => ({
    session_id: sessionId,
    action_id: action.actionId,
    sequence,
    trading_date: action.tradingDate,
    at: action.at,
    look_time: action.lookTimeEt,
    pass_number: action.passNumber,
    symbol: action.symbol,
    kind: action.kind,
    candidate_id: action.candidateId,
    description: action.description,
    automatic: action.automatic,
    chosen_because: action.chosenBecause,
    outcome: action.outcome,
    block_reason: action.blockReason,
    gate_results: JSON.stringify(action.gateResults),
    contract: action.contract === null ? null : JSON.stringify(action.contract),
    candidate_scores: action.candidateScores === null ? null : JSON.stringify(action.candidateScores),
    quantity: action.quantity,
    limit_price: action.limitPrice,
    fill_price: action.fillPrice,
    position_ids: JSON.stringify(action.positionIds),
  }));
  const cycleRows = result.cycles.map((cycle) => ({
    session_id: sessionId,
    symbol: cycle.symbol,
    cycle_number: cycle.cycleNumber,
    status: cycle.status,
    opened_at: cycle.openedAt,
    closed_at: cycle.closedAt,
    opened_on: cycle.openedOn,
    closed_on: cycle.closedOn,
    assigned_on: cycle.assignedOn,
    recovery_sessions: cycle.recoverySessions,
    age_sessions: cycle.ageSessions,
    total_dollars: cycle.totalDollars,
    net_premium_dollars: cycle.netPremiumDollars,
    shares_held: cycle.sharesHeld,
    break_even_per_share: cycle.breakEvenPerShare,
    buckets: JSON.stringify(cycle.buckets),
    data_flags: JSON.stringify(cycle.dataFlags),
    timeline: JSON.stringify(cycle.timeline),
    stock_only_stretches: JSON.stringify(cycle.stockOnlyStretches),
  }));
  const cycleGapRows = result.cycleGaps.map((gap) => ({
    session_id: sessionId,
    symbol: gap.symbol,
    after_cycle_number: gap.afterCycleNumber,
    before_cycle_number: gap.beforeCycleNumber,
    first_idle_day: gap.firstIdleDay,
    last_idle_day: gap.lastIdleDay,
    idle_sessions: gap.idleSessions,
    stock_move: gap.stockMove,
    no_sale_days: JSON.stringify(gap.noSaleDays),
    entry_filter_limits: JSON.stringify(gap.entryFilterLimits),
    no_candidate: gap.noCandidate === null ? null : JSON.stringify(gap.noCandidate),
  }));
  const shortfallRows = result.shortfalls.map((shortfall) => ({
    session_id: sessionId,
    trading_date: shortfall.tradingDate,
    at: shortfall.at,
    look_time: shortfall.lookTimeEt,
    symbol: shortfall.symbol,
    step: shortfall.step,
    option_right: shortfall.right,
    wanted_contracts: shortfall.wantedContracts,
    filled_contracts: shortfall.filledContracts,
    unsold_contracts: shortfall.unsoldContracts,
    reason: shortfall.reason,
    look_count: shortfall.lookCount,
    best_candidate: shortfall.bestCandidate === null ? null : JSON.stringify(shortfall.bestCandidate),
  }));
  const ladderLevelRows = result.ladderLevels.map(({ tradingDate, at, lookTimeEt, symbol, splitFactor, levels }) => ({
    session_id: sessionId,
    trading_date: tradingDate,
    at,
    look_time: lookTimeEt,
    symbol,
    split_factor: splitFactor,
    ladder_top: levels.top,
    floor: levels.floor,
    shock: levels.shock,
    reserve_committed: levels.committed,
    reserve: levels.reserve,
    first_rung_cap: levels.firstRungCap,
    next_put_cap: levels.nextPutCap,
    blocked_because: levels.blockedBecause,
  }));
  const breakEvenLevelRows = result.breakEvenLevels.map(({ tradingDate, at, lookTimeEt, symbol, splitFactor, firstBreakEven, secondBreakEven }) => ({
    session_id: sessionId,
    trading_date: tradingDate,
    at,
    look_time: lookTimeEt,
    symbol,
    split_factor: splitFactor,
    first_break_even: firstBreakEven,
    second_break_even: secondBreakEven,
  }));
  const rowsByTable: [string, Record<string, unknown>[]][] = [
    ["backtest_session_days", dayRows],
    ["backtest_trades", tradeRows],
    ["backtest_positions", positionRows],
    ["backtest_position_legs", legRows],
    ["backtest_fills", fillRows],
    ["backtest_actions", actionRows],
    ["backtest_cycles", cycleRows],
    ["backtest_cycle_gaps", cycleGapRows],
    ["backtest_look_shortfalls", shortfallRows],
    ["backtest_ladder_levels", ladderLevelRows],
    ["backtest_break_even_levels", breakEvenLevelRows],
  ];
  await connection.transaction(async (transaction) => {
    for (const [table, rows] of rowsByTable) for (let index = 0; index < rows.length; index += insertBatchSize) await transaction(table).insert(rows.slice(index, index + insertBatchSize));
    await transaction("backtest_sessions")
      .where({ id: sessionId })
      .update({ status: "succeeded", metrics: JSON.stringify(metrics), baseline_metrics: JSON.stringify(baselineMetrics), spy_baseline_metrics: spyBaselineMetrics === null ? null : JSON.stringify(spyBaselineMetrics), pnl_basis: "wheel_cycle", data_last_date: dataLastDate, finished_at: transaction.fn.now(), error: null, notes: JSON.stringify(result.notes), run_statistics: JSON.stringify(result.runStatistics) });
  });
}
