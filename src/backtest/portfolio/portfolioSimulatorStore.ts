import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { effectiveAllocationPctBySymbol } from "../../lib/tickerAllocation.js";
import { loadDailyBarsOf } from "../analysis/analysisFigures.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { BacktestRequestError } from "../jobs/backtestJobStore.js";
import { loadTreasuryBillRates, type TreasuryBillRates } from "../engine/treasuryBillRates.js";
import { groupsOf, independentTickersOf, pairMatrixOf, correlationOf, worstWeeksTogetherOf, type PairMatrix } from "./portfolioCorrelation.js";
import { marketHistoryOf, mondayOf, tickerHistoryOf, weeklyBarsOf, weeksPerYear, type MarketHistory, type TickerHistory, type WeeklyBar } from "./portfolioPaths.js";
import { portfolioWarningsOf, worstFallWithin, type PortfolioWarning } from "./portfolioWarnings.js";

// The portfolio simulator's book (the lab only, Marcelo 2026-11-03): how its tickers move together (weekly returns from
// each data file's daily bars, else the local DB's, against SPY's), its groups, its warnings and its 2020–2026 replay from
// the tickers' analysis backtests. The projection is portfolioProjectionStore.ts's, the suggestions
// portfolioLibrarySuggestions.ts's. A ticker's inputs are kept in memory until its analysis or its bars change.

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
  excessAllowancePct: number;
  priceAsTraded: number | null;
  firstBarDate: string | null;
  weeklyBars: WeeklyBar[];
  /** The analysis backtest's daily account values (the 2020–2026 replay). */
  accountByDate: Map<string, number>;
}

const inputsCache = new Map<string, { key: string; inputs: TickerInputs }>();

/** The analysis backtest's daily account values (the 2020–2026 replay) and its first and last day. */
async function loadBacktestAccountByDate(sessionId: string, connection: Knex): Promise<{ accountByDate: Map<string, number>; from: string; to: string }> {
  const days: { d: string; account_value: string }[] = await connection("backtest_session_days").where({ session_id: sessionId }).orderBy("trading_date").select(connection.raw("trading_date::text as d"), "account_value");
  return { accountByDate: new Map(days.map((row) => [row.d, Number(row.account_value)])), from: days[0]?.d ?? "", to: days.at(-1)?.d ?? "" };
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
  const profile: { sector: string | null } | undefined = await connection("backtest_ticker_profiles").where({ symbol }).first("sector");
  const { bars } = await loadDailyBarsOf(symbol, connection);
  const weeklyBars = weeklyBarsOf(bars);
  const { accountByDate, from, to } = await loadBacktestAccountByDate(analysis.session_id, connection);
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
    excessAllowancePct,
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
  return { tickers, accountDollars, horizonYears: horizonYears as HorizonYears };
}

interface PreparedBook {
  inputs: TickerInputs[];
  marketInputs: MarketInputs;
  allocationPct: Map<string, number>;
  allocationTotalPct: number;
  excessAllowancePct: number;
  histories: Map<string, TickerHistory>;
}

async function prepareBook(request: PortfolioBookRequest, connection: Knex): Promise<PreparedBook> {
  const marketInputs = await loadMarketInputs(connection);
  const symbols = request.tickers.map((ticker) => ticker.symbol);
  const inputs = await Promise.all(symbols.map((symbol) => loadTickerInputs(symbol, connection)));
  const allocationPct = effectiveAllocationPctBySymbol(request.tickers);
  const allocationTotalPct = [...allocationPct.values()].reduce((sum, pct) => sum + pct, 0);
  const allowances = inputs.slice(0, request.tickers.length).map((input) => input.excessAllowancePct);
  const excessAllowancePct = allowances.sort((a, b) => allowances.filter((value) => value === b).length - allowances.filter((value) => value === a).length)[0] ?? 20;
  const histories = new Map(inputs.map((input) => [input.symbol, tickerHistoryOf(input.symbol, input.weeklyBars, marketInputs.market, null, marketInputs.riskFreeNowWeek, marketInputs.riskFreeMeanWeek)]));
  return { inputs, marketInputs, allocationPct, allocationTotalPct, excessAllowancePct, histories };
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
  tickers: {
    symbol: string;
    verdict: string | null;
    sector: string | null;
    analysedAt: string | null;
    backtestFrom: string;
    backtestTo: string;
    beta: number;
    ownHistoryYears: number;
    priceAsTraded: number | null;
  }[];
  correlation: PairMatrix;
  worstWeeksTogether: PairMatrix;
  groups: { symbols: string[]; share: number }[];
  independentTickers: number | null;
  historyReplay: HistoryReplay | null;
  warnings: PortfolioWarning[];
}

/** How a book's tickers move together, its groups, its 2020–2026 replay and its warnings. */
export async function simulatePortfolio(request: PortfolioBookRequest, connection: Knex = db): Promise<PortfolioSimulation> {
  const prepared = await prepareBook(request, connection);
  const { marketInputs, allocationPct, excessAllowancePct, histories } = prepared;
  const inputsBySymbol = new Map(prepared.inputs.map((input) => [input.symbol, input]));
  const symbols = request.tickers.map((ticker) => ticker.symbol);
  const weights = symbols.map((symbol) => allocationPct.get(symbol)! / 100);
  const tickerHistories = symbols.map((symbol) => histories.get(symbol)!);
  const correlation = pairMatrixOf(tickerHistories, correlationOf);
  const worstWeeksTogether = pairMatrixOf(tickerHistories, worstWeeksTogetherOf);
  const groups = groupsOf(worstWeeksTogether)
    .map((members) => ({ symbols: members.map((index) => symbols[index]!), share: members.reduce((sum, index) => sum + weights[index]!, 0) }))
    .filter((group) => group.symbols.length > 1);
  const lastDate = marketInputs.spyCloses.at(-1)!.tradingDate;
  const yearsOfOwnHistory = (inputs: TickerInputs) => (inputs.firstBarDate === null ? 0 : (Date.parse(lastDate) - Date.parse(inputs.firstBarDate)) / (365.25 * 86_400_000));
  const warnings = portfolioWarningsOf({
    tickers: symbols.map((symbol, index) => {
      const inputs = inputsBySymbol.get(symbol)!;
      return {
        symbol,
        verdict: inputs.verdict,
        potDollars: weights[index]! * (1 + excessAllowancePct / 100) * request.accountDollars,
        priceAsTraded: inputs.priceAsTraded,
        ownHistoryYears: yearsOfOwnHistory(inputs),
        backtestWorstSpyFall: worstFallWithin(marketInputs.spyCloses, inputs.backtestFrom, inputs.backtestTo),
      };
    }),
    groups,
    allocationTotalPct: prepared.allocationTotalPct,
  });
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
    tickers: symbols.map((symbol) => {
      const inputs = inputsBySymbol.get(symbol)!;
      return {
        symbol,
        verdict: inputs.verdict,
        sector: inputs.sector,
        analysedAt: inputs.analysedAt,
        backtestFrom: inputs.backtestFrom,
        backtestTo: inputs.backtestTo,
        beta: histories.get(symbol)!.beta,
        ownHistoryYears: yearsOfOwnHistory(inputs),
        priceAsTraded: inputs.priceAsTraded,
      };
    }),
    correlation,
    worstWeeksTogether,
    groups,
    independentTickers: independentTickersOf(correlation, weights),
    historyReplay: historyReplayOf(prepared, new Map(symbols.map((symbol, index) => [symbol, weights[index]!]))),
    warnings,
  };
}

/** The one-change suggestions on the neutral projection, `onProgress` after each candidate. */
