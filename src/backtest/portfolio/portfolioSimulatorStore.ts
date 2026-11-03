import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { effectiveAllocationPctBySymbol } from "../../lib/tickerAllocation.js";
import { loadDailyBarsOf } from "../analysis/analysisFigures.js";
import { expiryDaysAmong } from "../analysis/analysisDayInputs.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { BacktestRequestError } from "../jobs/backtestJobStore.js";
import { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { loadTreasuryBillRates, type TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { groupsOf, independentTickersOf, pairMatrixOf, correlationOf, worstWeeksTogetherOf, type PairMatrix } from "./portfolioCorrelation.js";
import { callDaysPerWeekAtTodaysPace, lotFitScale, tickerPartsFromWeeks, type BacktestWeek, type TickerParts } from "./portfolioParts.js";
import { marketHistoryOf, mondayOf, tickerHistoryOf, weeklyBarsOf, weeksPerYear, type MarketHistory, type TickerHistory, type WeeklyBar } from "./portfolioPaths.js";
import { bookBetaOf, bookOutcome, drawPaths, replaysOf, tickerPathExcess, type BookOutcome, type Drift, type ProjectedTicker, type Replay } from "./portfolioProjection.js";
import { rankSuggestions, suggestionCandidatesOf, type Suggestion } from "./portfolioSuggestions.js";
import { portfolioWarningsOf, worstFallWithin, type PortfolioWarning } from "./portfolioWarnings.js";

// The portfolio simulator's inputs and its two answers (the lab only, Marcelo 2026-11-03): a book's projection, and the
// one-change suggestions. Each ticker's parts come from its latest analysis backtest, its history from its data file's
// daily bars (else the local DB's), SPY's history from SPY's; the T-bill now is the latest rate, its average the cached
// series' (from 2010). A ticker's inputs are kept in memory until its analysis or its bars change.

export const projectionPathCount = 2000;
/** The projection's own paths, so a suggestion's "before" is the headline figure. */
export const suggestionPathCount = projectionPathCount;
export const projectionSeed = 20261103;
export const horizonYearsChoices = [3, 5] as const;
export type HorizonYears = (typeof horizonYearsChoices)[number];
const treasuryBillAverageFromIso = "2010-01-04";
const historyReplayFromIso = "2020-01-02";

/** A book the simulator can't answer: a 400 with the message. */
export class PortfolioRequestError extends BacktestRequestError {
  constructor(message: string) {
    super(message, 400);
  }
}

export interface PortfolioTickerListing {
  symbol: string;
  verdict: string | null;
  sector: string | null;
  analysedAt: string | null;
}

/** Every ticker with a finished analysis, for the book's picker: its verdict, sector and when it was analysed. */
export async function listPortfolioTickers(connection: Knex = db): Promise<PortfolioTickerListing[]> {
  const rows: { symbol: string; verdict: string | null; sector: string | null; finished_at: Date | null }[] = await connection
    .select("latest.symbol", "latest.verdict", "profile.sector", "latest.finished_at")
    .from(
      connection.raw(
        "(select distinct on (symbol) symbol, table_figures->>'verdict' as verdict, finished_at from backtest_ticker_analyses where status = 'succeeded' and session_id is not null order by symbol, created_at desc) latest",
      ),
    )
    .leftJoin("backtest_ticker_profiles as profile", "profile.symbol", "latest.symbol")
    .orderBy("latest.symbol");
  return rows.map((row) => ({ symbol: row.symbol, verdict: row.verdict, sector: row.sector, analysedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString() }));
}

interface TickerInputs {
  symbol: string;
  analysisId: string;
  sessionId: string;
  verdict: string | null;
  sector: string | null;
  analysedAt: string | null;
  backtestFrom: string;
  backtestTo: string;
  parts: TickerParts;
  /** P2 at today's pace, else the backtest's own Call days a week. */
  callDaysPerWeek: number;
  callDaysPace: "today" | "backtest";
  analysisPotDollars: number;
  excessAllowancePct: number;
  firstPositionShare: number;
  priceAsTraded: number | null;
  firstBarDate: string | null;
  weeklyBars: WeeklyBar[];
  /** The analysis backtest's daily account values (the 2020–2026 replay). */
  accountByDate: Map<string, number>;
}

const inputsCache = new Map<string, { key: string; inputs: TickerInputs }>();

async function loadBacktestWeeks(sessionId: string, connection: Knex): Promise<{ weeks: BacktestWeek[]; accountByDate: Map<string, number>; callDates: string[]; from: string; to: string }> {
  const days: { d: string; account_value: string; shares_value_dollars: string | null; interest_dollars: string; baseline_value: string }[] = await connection("backtest_session_days")
    .where({ session_id: sessionId })
    .orderBy("trading_date")
    .select(connection.raw("trading_date::text as d"), "account_value", "shares_value_dollars", "interest_dollars", "baseline_value");
  const premiumRows: { d: string; premium: string }[] = await connection("backtest_fills")
    .where({ session_id: sessionId, instrument: "option", side: "sell", is_closing: false })
    .groupBy("trading_date")
    .select(connection.raw("trading_date::text as d"), connection.raw("sum(price * quantity * multiplier - commission_dollars) as premium"));
  const callRows: { d: string }[] = await connection("backtest_fills as f")
    .join("backtest_position_legs as l", function joinLeg() {
      this.on("l.session_id", "f.session_id").andOn("l.leg_id", "f.leg_id");
    })
    .where({ "f.session_id": sessionId, "f.instrument": "option", "f.side": "sell", "f.is_closing": false, "l.option_type": "call" })
    .distinct(connection.raw("f.trading_date::text as d"));
  const premiumByDate = new Map(premiumRows.map((row) => [row.d, Number(row.premium)]));
  const callDates = new Set(callRows.map((row) => row.d));
  const byWeek = new Map<string, typeof days>();
  for (const row of days) {
    const week = mondayOf(row.d);
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week)!.push(row);
  }
  const weeks: BacktestWeek[] = [];
  const grouped = [...byWeek];
  for (let index = 1; index < grouped.length; index++) {
    const before = grouped[index - 1]![1].at(-1)!;
    const [week, inWeek] = grouped[index]!;
    const last = inWeek.at(-1)!;
    weeks.push({
      week,
      accountStart: Number(before.account_value),
      accountEnd: Number(last.account_value),
      premium: inWeek.reduce((sum, row) => sum + (premiumByDate.get(row.d) ?? 0), 0),
      callDays: inWeek.filter((row) => callDates.has(row.d)).length,
      interest: inWeek.reduce((sum, row) => sum + Number(row.interest_dollars), 0),
      sharesShare: inWeek.reduce((sum, row) => sum + (Number(row.account_value) > 0 ? Number(row.shares_value_dollars ?? 0) / Number(row.account_value) : 0), 0) / inWeek.length,
      stockReturn: Number(before.baseline_value) > 0 ? Number(last.baseline_value) / Number(before.baseline_value) - 1 : 0,
    });
  }
  return { weeks, accountByDate: new Map(days.map((row) => [row.d, Number(row.account_value)])), callDates: [...callDates].sort(), from: days[0]?.d ?? "", to: days.at(-1)?.d ?? "" };
}

const addDays = (dateIso: string, days: number) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** P2's counts from the data file's expiry days and the backtest's Call days; null without a file. */
function todaysPaceOf(symbol: string, callDates: readonly string[]): number | null {
  let file: BacktestSymbolFile;
  try {
    file = BacktestSymbolFile.open(symbol);
  } catch {
    return null;
  }
  try {
    const completeDays = file.loadDays().filter((day) => day.status === "complete").map((day) => day.tradingDate);
    const lastDay = completeDays.at(-1);
    if (lastDay === undefined) return null;
    const threeMonthsFrom = addDays(lastDay, -91);
    const twelveMonthsFrom = addDays(lastDay, -365);
    const lastTwelveMonths = completeDays.filter((date) => date > twelveMonthsFrom);
    const expiryDays = expiryDaysAmong(file, lastTwelveMonths);
    return callDaysPerWeekAtTodaysPace({
      expiryDaysLastThreeMonths: [...expiryDays].filter((date) => date > threeMonthsFrom).length,
      weeksLastThreeMonths: 13,
      expiryDaysLastTwelveMonths: expiryDays.size,
      callDaysLastTwelveMonths: callDates.filter((date) => date > twelveMonthsFrom && date <= lastDay && expiryDays.has(date)).length,
    });
  } finally {
    file.close();
  }
}

async function loadTickerInputs(symbol: string, connection: Knex): Promise<TickerInputs> {
  const analysis: { id: string; session_id: string; verdict: string | null; finished_at: Date | null; bars_last_date: string | null } | undefined = await connection("backtest_ticker_analyses")
    .where({ symbol, status: "succeeded" })
    .whereNotNull("session_id")
    .orderBy("created_at", "desc")
    .first("id", "session_id", connection.raw("table_figures->>'verdict' as verdict"), "finished_at", connection.raw("bars_last_date::text as bars_last_date"));
  if (!analysis) throw new PortfolioRequestError(`${symbol} has no finished analysis: analyse it on Backtesting → Data files first.`);
  const key = `${analysis.id}:${analysis.bars_last_date ?? ""}`;
  const cached = inputsCache.get(symbol);
  if (cached && cached.key === key) return cached.inputs;
  const session: { starting_value: string; settings_snapshot: unknown; overrides: unknown } = await connection("backtest_sessions").where({ id: analysis.session_id }).first("starting_value", "settings_snapshot", "overrides");
  const effective = applyBacktestOverrides(session.settings_snapshot as never, (session.overrides ?? {}) as never);
  const excessAllowancePct = Number(effective.volFarmerV4.excessAllowancePct);
  const firstPositionShare = Number(effective.volFarmerV4.firstPositionPct) / 100;
  const profile: { sector: string | null } | undefined = await connection("backtest_ticker_profiles").where({ symbol }).first("sector");
  const { bars } = await loadDailyBarsOf(symbol, connection);
  const weeklyBars = weeklyBarsOf(bars);
  const ivByWeek = new Map(weeklyBars.map((bar, index) => [bar.week, index]));
  const ivAtWeekStart = (week: string) => {
    const index = ivByWeek.get(week);
    if (index === undefined) return null;
    for (let back = index - 1; back >= Math.max(0, index - 4); back--) if (weeklyBars[back]!.impliedVolatility !== null) return weeklyBars[back]!.impliedVolatility;
    return null;
  };
  const { weeks, accountByDate, callDates, from, to } = await loadBacktestWeeks(analysis.session_id, connection);
  const parts = tickerPartsFromWeeks(weeks, ivAtWeekStart);
  const pace = todaysPaceOf(symbol, callDates);
  const lastBar = [...bars].reverse().find((bar) => bar.close !== null);
  const inputs: TickerInputs = {
    symbol,
    analysisId: analysis.id,
    sessionId: analysis.session_id,
    verdict: analysis.verdict,
    sector: profile?.sector ?? null,
    analysedAt: analysis.finished_at === null ? null : new Date(analysis.finished_at).toISOString(),
    backtestFrom: from,
    backtestTo: to,
    parts,
    callDaysPerWeek: pace ?? parts.backtestCallDaysPerWeek,
    callDaysPace: pace === null ? "backtest" : "today",
    analysisPotDollars: Number(session.starting_value) * (1 + excessAllowancePct / 100),
    excessAllowancePct,
    firstPositionShare,
    priceAsTraded: lastBar?.close ?? null,
    firstBarDate: bars.find((bar) => bar.close !== null)?.tradingDate ?? null,
    weeklyBars,
    accountByDate,
  };
  inputsCache.set(symbol, { key, inputs });
  return inputs;
}

interface MarketInputs {
  market: MarketHistory;
  spyCloses: { tradingDate: string; close: number }[];
  rates: TreasuryBillRates;
  riskFreeNowYear: number;
  riskFreeNowWeek: number;
  riskFreeMeanWeek: number;
}

async function loadMarketInputs(connection: Knex): Promise<MarketInputs> {
  const { bars } = await loadDailyBarsOf("SPY", connection);
  if (bars.length === 0) throw new PortfolioRequestError("SPY's daily bars are missing: download SPY's data file first.");
  const spyCloses = bars.filter((bar) => bar.close !== null).map((bar) => ({ tradingDate: bar.tradingDate, close: bar.close! }));
  const lastDate = spyCloses.at(-1)!.tradingDate;
  const rates = await loadTreasuryBillRates(requireBacktestDataDirectory(), treasuryBillAverageFromIso, lastDate);
  const market = marketHistoryOf(weeklyBarsOf(bars));
  const riskFreeNowYear = (rates.ratePercentOnOrBefore(lastDate) ?? 0) / 100;
  const averageWeeks = market.weeks.filter((week) => week >= treasuryBillAverageFromIso);
  const riskFreeMeanWeek = averageWeeks.reduce((sum, week) => sum + (rates.ratePercentOnOrBefore(week) ?? 0) / 100, 0) / Math.max(1, averageWeeks.length) / weeksPerYear;
  return { market, spyCloses, rates, riskFreeNowYear, riskFreeNowWeek: riskFreeNowYear / weeksPerYear, riskFreeMeanWeek };
}

export interface PortfolioBookRequest {
  tickers: { symbol: string; allocationPct: number | null }[];
  accountDollars: number;
  horizonYears: HorizonYears;
  /** P2's Call days a week: "today", the approved pace (the file's last 3 months); "backtest", the analysis backtest's own. */
  callDaysPace?: "today" | "backtest";
}

/** The request's book, checked: 1–80 distinct tickers, allocations above 0 and at most 100 (or empty), an account above 0. */
export function parsePortfolioBookRequest(body: unknown): PortfolioBookRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(value.tickers) || value.tickers.length === 0) throw new PortfolioRequestError("tickers must list at least one ticker.");
  if (value.tickers.length > 80) throw new PortfolioRequestError("tickers may list at most 80 tickers.");
  const tickers = value.tickers.map((entry, index) => {
    const ticker = (entry ?? {}) as Record<string, unknown>;
    if (typeof ticker.symbol !== "string" || !/^[A-Z][A-Z0-9.]{0,9}$/.test(ticker.symbol)) throw new PortfolioRequestError(`tickers[${index}].symbol must be a ticker symbol.`);
    const allocationPct = ticker.allocationPct ?? null;
    if (allocationPct !== null && (typeof allocationPct !== "number" || !Number.isFinite(allocationPct) || allocationPct <= 0 || allocationPct > 100)) throw new PortfolioRequestError(`tickers[${index}].allocationPct must be above 0 and at most 100, or empty for an equal share.`);
    return { symbol: ticker.symbol, allocationPct: allocationPct as number | null };
  });
  if (new Set(tickers.map((ticker) => ticker.symbol)).size !== tickers.length) throw new PortfolioRequestError("tickers lists a ticker twice.");
  const accountDollars = value.accountDollars;
  if (typeof accountDollars !== "number" || !Number.isFinite(accountDollars) || accountDollars <= 0 || accountDollars > 1e10) throw new PortfolioRequestError("accountDollars must be a number above 0.");
  const horizonYears = value.horizonYears ?? 5;
  if (!(horizonYearsChoices as readonly unknown[]).includes(horizonYears)) throw new PortfolioRequestError(`horizonYears must be one of ${horizonYearsChoices.join(", ")}.`);
  const callDaysPace = value.callDaysPace ?? "today";
  if (callDaysPace !== "today" && callDaysPace !== "backtest") throw new PortfolioRequestError("callDaysPace must be today or backtest.");
  return { tickers, accountDollars, horizonYears: horizonYears as HorizonYears, callDaysPace };
}

interface PreparedBook {
  inputs: TickerInputs[];
  marketInputs: MarketInputs;
  allocationPct: Map<string, number>;
  allocationTotalPct: number;
  excessAllowancePct: number;
  horizonWeeks: number;
  histories: Map<string, TickerHistory>;
}

function projectedTickerOf(inputs: TickerInputs, history: TickerHistory, weight: number, accountDollars: number, excessAllowancePct: number, callDaysPace: "today" | "backtest" = "today"): ProjectedTicker {
  const potDollars = weight * (1 + excessAllowancePct / 100) * accountDollars;
  return {
    symbol: inputs.symbol,
    weight,
    lotScale: inputs.priceAsTraded === null ? 1 : lotFitScale(potDollars, inputs.analysisPotDollars, inputs.priceAsTraded, inputs.firstPositionShare),
    premiumRatio: inputs.parts.premiumRatio,
    callDaysPerWeek: callDaysPace === "backtest" ? inputs.parts.backtestCallDaysPerWeek : inputs.callDaysPerWeek,
    upCapture: inputs.parts.upCapture,
    downCapture: inputs.parts.downCapture,
    sharesHeldShare: inputs.parts.sharesHeldShare,
    history,
  };
}

async function prepareBook(request: PortfolioBookRequest, connection: Knex, extraSymbols: readonly string[] = []): Promise<PreparedBook> {
  const marketInputs = await loadMarketInputs(connection);
  const symbols = [...request.tickers.map((ticker) => ticker.symbol), ...extraSymbols.filter((symbol) => !request.tickers.some((ticker) => ticker.symbol === symbol))];
  const inputs = await Promise.all(symbols.map((symbol) => loadTickerInputs(symbol, connection)));
  const allocationPct = effectiveAllocationPctBySymbol(request.tickers);
  const allocationTotalPct = [...allocationPct.values()].reduce((sum, pct) => sum + pct, 0);
  const allowances = inputs.slice(0, request.tickers.length).map((input) => input.excessAllowancePct);
  const excessAllowancePct = allowances.sort((a, b) => allowances.filter((value) => value === b).length - allowances.filter((value) => value === a).length)[0] ?? 20;
  const histories = new Map(inputs.map((input) => [input.symbol, tickerHistoryOf(input.symbol, input.weeklyBars, marketInputs.market, input.parts.highestIv, marketInputs.riskFreeNowWeek, marketInputs.riskFreeMeanWeek)]));
  return { inputs, marketInputs, allocationPct, allocationTotalPct, excessAllowancePct, horizonWeeks: Math.round(request.horizonYears * weeksPerYear), histories };
}

export interface HistoryReplay {
  from: string;
  to: string;
  cagr: number;
  maxDrawdown: number;
  spyCagr: number;
  spyMaxDrawdown: number;
  /** The book and SPY each week's last day, 1 at the start. */
  weekly: { date: string; book: number; spy: number }[];
}

/** The book's analysis backtests combined at fixed weights every day (2020 on); a ticker before its backtest starts earns the T-bill. */
function historyReplayOf(prepared: PreparedBook, weights: Map<string, number>): HistoryReplay | null {
  const dates = prepared.marketInputs.spyCloses.filter((close) => close.tradingDate >= historyReplayFromIso);
  if (dates.length < 2) return null;
  const spyByDate = new Map(dates.map((close) => [close.tradingDate, close.close]));
  const lastBacktestDay = prepared.inputs.filter((input) => weights.has(input.symbol)).reduce((earliest, input) => (input.backtestTo < earliest ? input.backtestTo : earliest), dates.at(-1)!.tradingDate);
  const used = dates.filter((close) => close.tradingDate <= lastBacktestDay);
  let book = 1;
  const values = [1];
  const weekly: HistoryReplay["weekly"] = [];
  for (let index = 1; index < used.length; index++) {
    const date = used[index]!.tradingDate;
    const previousDate = used[index - 1]!.tradingDate;
    const cashDay = ((prepared.marketInputs.rates.ratePercentOnOrBefore(previousDate) ?? 0) / 100) * ((Date.parse(date) - Date.parse(previousDate)) / 86_400_000 / 365);
    let dayReturn = 0;
    for (const input of prepared.inputs) {
      const weight = weights.get(input.symbol);
      if (weight === undefined) continue;
      const today = input.accountByDate.get(date);
      const yesterday = input.accountByDate.get(previousDate);
      dayReturn += weight * (today !== undefined && yesterday !== undefined && yesterday > 0 ? today / yesterday - 1 : cashDay);
    }
    book *= 1 + dayReturn;
    values.push(book);
    const nextDate = used[index + 1]?.tradingDate;
    if (nextDate === undefined || mondayOf(nextDate) !== mondayOf(date)) weekly.push({ date, book, spy: spyByDate.get(date)! / used[0]!.close });
  }
  const figuresOf = (series: readonly number[]) => {
    let peak = series[0]!;
    let worst = 0;
    for (const value of series) {
      peak = Math.max(peak, value);
      worst = Math.min(worst, value / peak - 1);
    }
    const years = (Date.parse(used.at(-1)!.tradingDate) - Date.parse(used[0]!.tradingDate)) / (365.25 * 86_400_000);
    return { cagr: (series.at(-1)! / series[0]!) ** (1 / years) - 1, maxDrawdown: worst };
  };
  const bookFigures = figuresOf(values);
  const spyFigures = figuresOf(used.map((close) => close.close));
  return { from: used[0]!.tradingDate, to: used.at(-1)!.tradingDate, cagr: bookFigures.cagr, maxDrawdown: bookFigures.maxDrawdown, spyCagr: spyFigures.cagr, spyMaxDrawdown: spyFigures.maxDrawdown, weekly };
}

export interface PortfolioSimulation {
  asOf: string;
  book: { accountDollars: number; excessAllowancePct: number; horizonYears: HorizonYears; allocationTotalPct: number; tickers: { symbol: string; allocationPct: number; setAllocation: boolean; potDollars: number }[] };
  riskFree: { nowPct: number; averagePct: number };
  projection: Record<Drift, BookOutcome>;
  tickers: {
    symbol: string;
    verdict: string | null;
    sector: string | null;
    analysedAt: string | null;
    backtestFrom: string;
    backtestTo: string;
    premiumRatio: number;
    callDaysPerWeek: number;
    callDaysPace: "today" | "backtest";
    upCapture: number;
    downCapture: number;
    sharesHeldShare: number;
    lotScale: number;
    beta: number;
    ownHistoryYears: number;
    priceAsTraded: number | null;
    ivCap: number | null;
    optionsIncomeYear: number;
    averageYear: Record<Drift, number>;
    shareOfFall: Record<Drift, number | null>;
    shareOfReturn: Record<Drift, number | null>;
  }[];
  correlation: PairMatrix;
  worstWeeksTogether: PairMatrix;
  groups: { symbols: string[]; share: number }[];
  independentTickers: number | null;
  bookBeta: number;
  replays: Replay[];
  historyReplay: HistoryReplay | null;
  warnings: PortfolioWarning[];
}

/** A book's projection, how its tickers move together, the replays and the warnings. */
export async function simulatePortfolio(request: PortfolioBookRequest, connection: Knex = db): Promise<PortfolioSimulation> {
  const prepared = await prepareBook(request, connection);
  const { marketInputs, allocationPct, excessAllowancePct, horizonWeeks, histories } = prepared;
  const inputsBySymbol = new Map(prepared.inputs.map((input) => [input.symbol, input]));
  const symbols = request.tickers.map((ticker) => ticker.symbol);
  const projected = symbols.map((symbol) => projectedTickerOf(inputsBySymbol.get(symbol)!, histories.get(symbol)!, allocationPct.get(symbol)! / 100, request.accountDollars, excessAllowancePct, request.callDaysPace));
  const paths = drawPaths(marketInputs.market.weeks.length, horizonWeeks, projectionPathCount, projectionSeed);
  const projection = {} as Record<Drift, BookOutcome>;
  for (const drift of ["as_it_happened", "neutral"] as const) {
    const excess = projected.map((ticker) => tickerPathExcess(ticker, paths, drift, marketInputs.riskFreeNowWeek));
    projection[drift] = bookOutcome(projected, excess, projectionPathCount, horizonWeeks, marketInputs.riskFreeNowWeek, marketInputs.riskFreeNowYear);
  }
  const tickerHistories = symbols.map((symbol) => histories.get(symbol)!);
  const correlation = pairMatrixOf(tickerHistories, correlationOf);
  const worstWeeksTogether = pairMatrixOf(tickerHistories, worstWeeksTogetherOf);
  const weights = projected.map((ticker) => ticker.weight);
  const groups = groupsOf(worstWeeksTogether)
    .map((members) => ({ symbols: members.map((index) => symbols[index]!), share: members.reduce((sum, index) => sum + weights[index]!, 0) }))
    .filter((group) => group.symbols.length > 1);
  const lastDate = marketInputs.spyCloses.at(-1)!.tradingDate;
  const yearsOfOwnHistory = (inputs: TickerInputs) => (inputs.firstBarDate === null ? 0 : (Date.parse(lastDate) - Date.parse(inputs.firstBarDate)) / (365.25 * 86_400_000));
  const warnings = portfolioWarningsOf({
    tickers: projected.map((ticker) => {
      const inputs = inputsBySymbol.get(ticker.symbol)!;
      return {
        symbol: ticker.symbol,
        verdict: inputs.verdict,
        potDollars: ticker.weight * (1 + excessAllowancePct / 100) * request.accountDollars,
        priceAsTraded: inputs.priceAsTraded,
        ownHistoryYears: yearsOfOwnHistory(inputs),
        backtestWorstSpyFall: worstFallWithin(marketInputs.spyCloses, inputs.backtestFrom, inputs.backtestTo),
      };
    }),
    groups,
    allocationTotalPct: prepared.allocationTotalPct,
  });
  const outcomeTicker = (drift: Drift, symbol: string) => projection[drift].tickers.find((ticker) => ticker.symbol === symbol)!;
  return {
    asOf: lastDate,
    book: {
      accountDollars: request.accountDollars,
      excessAllowancePct,
      horizonYears: request.horizonYears,
      allocationTotalPct: prepared.allocationTotalPct,
      tickers: request.tickers.map((ticker) => ({ symbol: ticker.symbol, allocationPct: allocationPct.get(ticker.symbol)!, setAllocation: ticker.allocationPct !== null, potDollars: (allocationPct.get(ticker.symbol)! / 100) * (1 + excessAllowancePct / 100) * request.accountDollars })),
    },
    riskFree: { nowPct: marketInputs.riskFreeNowYear * 100, averagePct: marketInputs.riskFreeMeanWeek * weeksPerYear * 100 },
    projection,
    tickers: projected.map((ticker) => {
      const inputs = inputsBySymbol.get(ticker.symbol)!;
      const history = histories.get(ticker.symbol)!;
      return {
        symbol: ticker.symbol,
        verdict: inputs.verdict,
        sector: inputs.sector,
        analysedAt: inputs.analysedAt,
        backtestFrom: inputs.backtestFrom,
        backtestTo: inputs.backtestTo,
        premiumRatio: ticker.premiumRatio,
        callDaysPerWeek: ticker.callDaysPerWeek,
        callDaysPace: request.callDaysPace === "backtest" ? "backtest" : inputs.callDaysPace,
        upCapture: ticker.upCapture,
        downCapture: ticker.downCapture,
        sharesHeldShare: ticker.sharesHeldShare,
        lotScale: ticker.lotScale,
        beta: history.beta,
        ownHistoryYears: yearsOfOwnHistory(inputs),
        priceAsTraded: inputs.priceAsTraded,
        ivCap: history.ivCap,
        optionsIncomeYear: ticker.lotScale * ticker.premiumRatio * (history.ivs.at(-1) ?? 0) * ticker.callDaysPerWeek * weeksPerYear,
        averageYear: { as_it_happened: outcomeTicker("as_it_happened", ticker.symbol).averageYear, neutral: outcomeTicker("neutral", ticker.symbol).averageYear },
        shareOfFall: { as_it_happened: outcomeTicker("as_it_happened", ticker.symbol).shareOfFall, neutral: outcomeTicker("neutral", ticker.symbol).shareOfFall },
        shareOfReturn: { as_it_happened: outcomeTicker("as_it_happened", ticker.symbol).shareOfReturn, neutral: outcomeTicker("neutral", ticker.symbol).shareOfReturn },
      };
    }),
    correlation,
    worstWeeksTogether,
    groups,
    independentTickers: independentTickersOf(correlation, weights),
    bookBeta: bookBetaOf(projected, marketInputs.market, marketInputs.riskFreeNowWeek),
    replays: replaysOf(projected, marketInputs.market, marketInputs.riskFreeNowWeek),
    historyReplay: historyReplayOf(prepared, new Map(projected.map((ticker) => [ticker.symbol, ticker.weight]))),
    warnings,
  };
}

/** The replays with and without the IV cap (for checking the cap's effect). */
export async function replaysWithAndWithoutIvCap(request: PortfolioBookRequest, connection: Knex = db): Promise<{ capped: Replay[]; uncapped: Replay[] }> {
  const prepared = await prepareBook(request, connection);
  const inputsBySymbol = new Map(prepared.inputs.map((input) => [input.symbol, input]));
  const projected = request.tickers.map((ticker) => projectedTickerOf(inputsBySymbol.get(ticker.symbol)!, prepared.histories.get(ticker.symbol)!, prepared.allocationPct.get(ticker.symbol)! / 100, request.accountDollars, prepared.excessAllowancePct, request.callDaysPace));
  return { capped: replaysOf(projected, prepared.marketInputs.market, prepared.marketInputs.riskFreeNowWeek, true), uncapped: replaysOf(projected, prepared.marketInputs.market, prepared.marketInputs.riskFreeNowWeek, false) };
}

/** The one-change suggestions on the neutral projection, `onProgress` after each candidate. */
export async function suggestPortfolioChanges(request: PortfolioBookRequest, onProgress?: (done: number, total: number) => void, connection: Knex = db): Promise<{ baseline: { excessCalmar: number; cagr: number; maxDrawdown: number }; suggestions: Suggestion[] }> {
  const addable = (await listPortfolioTickers(connection)).filter((ticker) => ticker.verdict === "suits").map((ticker) => ticker.symbol);
  const prepared = await prepareBook(request, connection, addable);
  const { marketInputs, allocationPct, excessAllowancePct, horizonWeeks, histories } = prepared;
  const inputsBySymbol = new Map(prepared.inputs.map((input) => [input.symbol, input]));
  const paths = drawPaths(marketInputs.market.weeks.length, horizonWeeks, suggestionPathCount, projectionSeed);
  const excessCache = new Map<string, ReturnType<typeof tickerPathExcess>>();
  const excessFor = (symbol: string) => {
    let excess = excessCache.get(symbol);
    if (excess === undefined) {
      excess = tickerPathExcess(projectedTickerOf(inputsBySymbol.get(symbol)!, histories.get(symbol)!, 1, request.accountDollars, excessAllowancePct, request.callDaysPace), paths, "neutral", marketInputs.riskFreeNowWeek);
      excessCache.set(symbol, excess);
    }
    return excess;
  };
  const book = new Map(request.tickers.map((ticker) => [ticker.symbol, allocationPct.get(ticker.symbol)! / 100]));
  return rankSuggestions({
    book,
    candidates: suggestionCandidatesOf(book, addable),
    tickerFor: (symbol, weight) => projectedTickerOf(inputsBySymbol.get(symbol)!, histories.get(symbol)!, weight, request.accountDollars, excessAllowancePct, request.callDaysPace),
    excessFor,
    pathCount: suggestionPathCount,
    horizonWeeks,
    riskFreeWeek: marketInputs.riskFreeNowWeek,
    riskFreeYear: marketInputs.riskFreeNowYear,
    onProgress,
  });
}
