import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { easternIsoDate } from "../../lib/easternIsoDate.js";
import { defaultBacktestVolFarmerV4Settings, type BacktestMetrics, type BacktestPnlSources, type BacktestPosition, type BacktestDaysWithNoOptions } from "../backtestTypes.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { openBacktestDataFileReadOnly } from "../backtestDataFile.js";
import { readFileIntradayPrices } from "../backtestFileStockBars.js";
import { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import { optionSaleFillPrice } from "../engine/ledger/ledgerFills.js";
import { readSplitScheduleCache, type SplitSchedule } from "../engine/splitFactors.js";
import { loadTreasuryBillRates } from "../engine/treasuryBillRates.js";
import { loadBacktestSessionDetail } from "../jobs/backtestSessionStore.js";
import { excessCalmarOf, treasuryBillCagr } from "./analysisSessions.js";
import { loadCashAvailableByDay } from "./sessionFreeCash.js";
import { expiryDaysAmong, tenOclockPriceAsTraded } from "./analysisDayInputs.js";
import { expiryWeeksBy, wholeWeeksBetween } from "./analysisExpiryWeeks.js";
import { median } from "./analysisPriceFigures.js";
import { accountDuringFall, type AccountDuringFall, type FallOfAStep } from "./analysisStepFalls.js";
import { applySuitabilityRule, type SuitabilityVerdict, type SuitabilityWindow } from "./analysisSuitabilityRule.js";
import { oneTickerPotShareOfAccount } from "./analysisPotSizing.js";

// The analysis's own backtest (Marcelo 2026-11-01): each saved analysis runs the ticker alone under Vol Farmer v4 at the
// lab's values, from the steady-weeklies start to the file's last day, as an ordinary session visible in Sessions. Its
// records give the rule (S1–S4 over its last 12, 6 and 3 months), each year's P&L by source by marks (F17, F18), the
// options year by year (F19 for v4), the year rows of the month table (F21), the tiles' averages (F22), the upside given up
// at call-aways (F6), the shares against the target band (F24), the top-ups and trims (F25), each Call's IV at its sale
// (F26) and v4's account during each fall of a Step (F11).

/** "Analysis · AMD · Vol Farmer v4 · $100k" (at most 120 characters, as any session name); a trial's says so. */
export function analysisSessionName(symbol: string, accountDollars: number, trial: boolean): string {
  const account = accountDollars >= 1_000_000 ? `$${+(accountDollars / 1_000_000).toFixed(2)}M` : `$${+(accountDollars / 1000).toFixed(1)}k`;
  return `Analysis${trial ? " trial" : ""} · ${symbol} · Vol Farmer v4 · ${account}`;
}

export interface AnalysisYearRow {
  year: string;
  /** The day the year is measured from: the previous year's last backtest day; null for the backtest's first year (its start). */
  fromDate: string | null;
  toDate: string;
  startValue: number;
  endValue: number;
  /** F21. */
  v4Return: number;
  holdReturn: number | null;
  spyReturn: number | null;
  treasuryBillReturn: number | null;
  v4MaxDrawdown: number;
  holdMaxDrawdown: number | null;
  /** F17: each source's P&L in the year, by marks; they add up to the account's change. */
  sources: { calls: number; puts: number; leaps: number; interest: number; shares: number };
  /** F18: each source's P&L ÷ the account's value at the year's start. */
  parts: { calls: number; puts: number; leaps: number; interest: number; shares: number };
  /** F19 for v4. */
  callsSold: number;
  callYieldMedian: number | null;
  /** The Calls' own IV at their sale, weighted by contracts. */
  callImpliedVolatility: number | null;
  expiryDays: number;
  expiryDaysSold: number;
  wholeWeeks: number;
  weeksWithExpiryDay: number;
  calledAway: number;
  putsSold: number;
  putsAssigned: number;
  topUps: number;
  trims: number;
}

export interface AnalysisBacktestFigures {
  sessionId: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
  startingValue: number;
  /** The pot the analysis starts with: the starting account × 1.2. */
  startingPotDollars: number;
  metrics: BacktestMetrics | null;
  buyAndHoldMetrics: BacktestMetrics | null;
  spyMetrics: BacktestMetrics | null;
  excessCalmar: { v4: number | null; hold: number | null; spy: number | null };
  treasuryBillCagr: number | null;
  /** The account's Max drawdown: its peak, trough and the first day back at the peak (null when not yet). */
  maxDrawdownDates: { peak: string; trough: string; back: string | null } | null;
  rule: { windows: SuitabilityWindow[]; verdict: SuitabilityVerdict };
  /** The session tiles' P&L by source. */
  sources: BacktestPnlSources | null;
  /** The T-bill interest credited, and its part of the CAGR as the tiles' sources (CAGR × its P&L ÷ the account's P&L). */
  interest: { pnlDollars: number; cagrPart: number | null } | null;
  daysWithNoOptions: BacktestDaysWithNoOptions | null;
  /** F22: the means of the shares' value, all cash and the free cash ÷ the account at the 10:00 marks. */
  averages: { sharesShare: number | null; cashShare: number | null; freeCashShare: number | null };
  /** F6: at each call-away, (the next session's 10:00 price − strike) × shares, when positive. */
  upsideGivenUp: { dollars: number; callAways: number; callAwaysWithUpside: number };
  /** F25 over the backtest. */
  topUps: { count: number; lots: number; dollars: number };
  trims: { count: number; lots: number; dollars: number };
  years: AnalysisYearRow[];
  /** The whole backtest as one row of F19's figures. */
  allYears: Pick<AnalysisYearRow, "callsSold" | "callYieldMedian" | "callImpliedVolatility" | "expiryDays" | "expiryDaysSold" | "wholeWeeks" | "weeksWithExpiryDay" | "calledAway" | "putsSold" | "putsAssigned" | "topUps" | "trims">;
  /** Month by month: [month, v4's return, the stock held's, SPY's]. */
  monthly: [string, number, number, number | null][];
  /** Each backtest day: [date, account, stock held, SPY held, drawdown, free cash ÷ account, shares' value ÷ the pot (F24)]. */
  days: [string, number, number, number | null, number, number | null, number][];
  /** Each Call sold: [date, strike as traded, contracts, fill, its IV at the sale (F26), premium yield]. */
  callSales: [string, number, number, number, number | null, number | null][];
  /** F25's marks and the call-aways: [date, lots before, lots after, price] and [date, strike, contracts]. */
  events: { topUps: [string, number | null, number | null, number][]; trims: [string, number | null, number | null, number][]; calledAway: [string, number, number][] };
  /** F19's replacement for F20: each expiry day without a Call sold, with what that day's look recorded. */
  expiryDaysWithoutCall: [string, string | null][];
  /** The wheel cycles: [number, open, opened, closed, days, P&L, return, the stock's change, Calls sold, premium, shares' P&L]. */
  cycles: [number, boolean, string, string | null, number, number, number | null, number | null, number, number, number][];
  /** F11 for each fall that reaches into the backtest, by the fall's peak date, with the top-ups inside its window. */
  falls: Record<string, AccountDuringFall & { topUps: number; topUpDollars: number }>;
  /** Cash-Secured Puts and LEAPS happened: the price chart's B-E, B-E2, LEAPS and Step panes show. */
  putsSold: number;
  leapsBought: number;
}

const dayMilliseconds = 86_400_000;
const calendarDaysBetween = (fromIso: string, toIso: string) => (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / dayMilliseconds;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]) => (values.length === 0 ? null : sum(values) / values.length);
const lotsOf = (shares: number) => shares / 100;

interface SessionAction {
  trading_date: string;
  kind: string;
  quantity: string | null;
  fill_price: string | null;
  candidate_scores: Record<string, number | null> | null;
  chosen_because: string | null;
  contract: { strike?: number; expiry?: string } | null;
}

/** The share purchases and sales v4 records for its band (volFarmerV2Steps.ts rebalanceHolding): "under the band", "over the band". */
const isTopUp = (action: SessionAction) => action.kind === "buy_shares" && (action.chosen_because ?? "").includes("under the band");
const isTrim = (action: SessionAction) => action.kind !== "buy_shares" && (action.chosen_because ?? "").includes("over the band");

/** The P&L of each Call or Put sold after commissions, an open one's share of what the tiles hold for it at the last marks. */
function optionsSoldWithPnl(positions: readonly BacktestPosition[], sources: BacktestPnlSources | null): { saleDate: string; exitDate: string | null; right: "C" | "P"; pnlDollars: number; leg: BacktestPosition["legs"][number] }[] {
  const sold = positions.flatMap((position) =>
    position.legs
      .filter((leg) => leg.legType === "option" && leg.side === "short" && (position.strategyKey === "covered_call" || position.strategyKey === "cash_secured_put"))
      .map((leg) => ({ saleDate: easternIsoDate(new Date(leg.entryAt)), exitDate: leg.exitAt === null ? null : easternIsoDate(new Date(leg.exitAt)), right: (leg.optionType === "put" ? "P" : "C") as "C" | "P", pnlDollars: leg.realizedPnlDollars ?? 0, leg })),
  );
  // The tiles count an open option at its last mark: the part of their total the closed ones don't hold is the open ones'.
  for (const right of ["C", "P"] as const) {
    const open = sold.filter((entry) => entry.right === right && entry.leg.realizedPnlDollars === null);
    if (open.length === 0) continue;
    const tilesTotal = (right === "C" ? sources?.coveredCalls?.pnlDollars : sources?.cashSecuredPuts?.pnlDollars) ?? 0;
    const closedTotal = sum(sold.filter((entry) => entry.right === right && entry.leg.realizedPnlDollars !== null).map((entry) => entry.pnlDollars));
    for (const entry of open) entry.pnlDollars = (tilesTotal - closedTotal) / open.length;
  }
  return sold;
}

/**
 * F17 for the LEAPS: each one's P&L by year, at the engine's 10:00 mark at each year end it spans (the mid less the LEAPS'
 * share of the half-spread, re-read from the data file; a year end without a quote keeps the last mark); the last year
 * takes the rest of what the tiles hold for it.
 */
function leapsPnlByYear(file: BacktestSymbolFile, positions: readonly BacktestPosition[], yearEnds: ReadonlyMap<string, string>, spreadShareCharged: number, tilesLeapsDollars: number): Map<string, number> {
  const byYear = new Map<string, number>();
  const add = (year: string, dollars: number) => byYear.set(year, (byYear.get(year) ?? 0) + dollars);
  const lastYear = [...yearEnds.keys()].at(-1)!;
  let closedTotal = 0;
  let openCounted = 0;
  let openLegs = 0;
  for (const position of positions.filter((entry) => entry.strategyKey === "leaps")) {
    for (const leg of position.legs.filter((entry) => entry.legType === "option")) {
      const entryDate = easternIsoDate(new Date(leg.entryAt));
      const exitDate = leg.exitAt === null ? null : easternIsoDate(new Date(leg.exitAt));
      const dollarsPerPrice = leg.quantity * leg.multiplier * (leg.side === "long" ? 1 : -1);
      let value = leg.entryPrice;
      let counted = 0;
      for (const [year, yearEnd] of yearEnds) {
        if (yearEnd < entryDate || (exitDate !== null && yearEnd >= exitDate)) continue;
        const quote = leg.expiry === null || leg.strike === null ? null : file.loadCallQuotesOfExpiry(yearEnd, leg.expiry).find((entry) => Math.abs(entry.strike * leg.priceScale - leg.strike!) < 1e-6);
        const mark = quote && quote.bid !== null && quote.ask !== null && quote.bid > 0 && quote.ask >= quote.bid ? optionSaleFillPrice(quote.bid, quote.ask, spreadShareCharged) * leg.priceScale : value;
        add(year, (mark - value) * dollarsPerPrice);
        counted += (mark - value) * dollarsPerPrice;
        value = mark;
      }
      if (leg.realizedPnlDollars === null) {
        openCounted += counted;
        openLegs += 1;
        continue;
      }
      closedTotal += leg.realizedPnlDollars;
      add(exitDate!.slice(0, 4), leg.realizedPnlDollars - counted);
    }
  }
  // An open LEAPS since the last year end: the rest of what the tiles hold for the LEAPS.
  if (openLegs > 0) add(lastYear, tilesLeapsDollars - closedTotal - openCounted);
  return byYear;
}

/**
 * The figures of a finished analysis session; `falls`: F7's over the file's daily bars, for F11; `closes`: those bars'
 * split-adjusted closes, for each wheel cycle's stock change.
 */
export async function computeAnalysisBacktestFigures(sessionId: string, symbol: string, falls: readonly FallOfAStep[], closes: readonly { tradingDate: string; close: number }[], connection: Knex = db): Promise<AnalysisBacktestFigures> {
  const detail = await loadBacktestSessionDetail(sessionId);
  const { session } = detail;
  const days = detail.days;
  if (days.length === 0) throw new Error("The analysis backtest has no days.");
  const sessionDates = days.map((day) => day.tradingDate);
  const first = sessionDates[0]!;
  const last = sessionDates.at(-1)!;
  const startingValue = Number(session.startingValue);
  // The session's own v4 values: its first position's share of the pot, and the pot's of the account with one ticker.
  const v4 = { ...defaultBacktestVolFarmerV4Settings, ...applyBacktestOverrides(session.settingsSnapshot, session.overrides).volFarmerV4 };
  const firstPositionShare = v4.firstPositionPct / 100;
  const potShareOfAccount = oneTickerPotShareOfAccount(v4);
  const startingPotDollars = startingValue * potShareOfAccount;
  const pnlSources = detail.pnlSources;

  const extraDays: { trading_date: string; shares_value_dollars: string | null }[] = await connection("backtest_session_days").where({ session_id: sessionId }).orderBy("trading_date").select(connection.raw("trading_date::text"), "shares_value_dollars");
  const sharesValueOn = new Map(extraDays.map((day) => [day.trading_date, Number(day.shares_value_dollars ?? 0)]));
  const actions: SessionAction[] = await connection("backtest_actions").where({ session_id: sessionId, outcome: "filled" }).orderBy(["trading_date", "sequence"]).select(connection.raw("trading_date::text"), "kind", "quantity", "fill_price", "candidate_scores", "chosen_because", "contract");
  const callSales = actions.filter((action) => action.kind === "open_covered_call");
  const putSales = actions.filter((action) => action.kind === "open_cash_secured_put");
  const topUps = actions.filter(isTopUp);
  const trims = actions.filter(isTrim);
  const callSaleDays = new Set(callSales.map((action) => action.trading_date));
  const symbolFile = BacktestSymbolFile.open(symbol);
  let expiryDays: Set<string>;
  try {
    expiryDays = expiryDaysAmong(symbolFile, sessionDates);
  } finally {
    symbolFile.close();
  }
  const optionsSold = optionsSoldWithPnl(detail.positions, pnlSources);
  const callLegs = optionsSold.filter((entry) => entry.right === "C");
  const putLegs = optionsSold.filter((entry) => entry.right === "P");
  const leapsBought = detail.positions.filter((position) => position.strategyKey === "leaps").length;

  // The 10:00 prices as traded, the split schedule's factors on each day.
  const dataDirectory = requireBacktestDataDirectory();
  const schedule: SplitSchedule | null = readSplitScheduleCache(dataDirectory, symbol)?.schedule ?? null;
  const database = openBacktestDataFileReadOnly(symbol);
  const intradayPrices = database ? (() => {
    try {
      return readFileIntradayPrices(database, first, last);
    } finally {
      database.close();
    }
  })() : null;
  const tenOclock = (date: string) => (intradayPrices === null ? null : tenOclockPriceAsTraded(date, intradayPrices, schedule));

  const rule = applySuitabilityRule({
    days,
    expiryDays,
    callSaleDays,
    optionsSold: optionsSold.map((entry) => ({ saleDate: entry.saleDate, pnlDollars: entry.pnlDollars })),
    tenOclockPriceAsTraded: tenOclock,
    startingPotDollars,
    firstPositionShare,
  });

  // F6: each call-away's shares × (the next session's 10:00 price − strike), when positive (prices as traded).
  let upsideDollars = 0;
  let callAwaysWithUpside = 0;
  const calledAwayLegs = callLegs.filter((entry) => entry.leg.settledAs === "assigned" && entry.exitDate !== null);
  for (const entry of calledAwayLegs) {
    const next = sessionDates.find((date) => date > entry.exitDate!);
    const price = next === undefined ? null : tenOclock(next);
    const strikeAsTraded = entry.leg.strike! / entry.leg.priceScale;
    if (price !== null && price > strikeAsTraded) {
      upsideDollars += (price - strikeAsTraded) * entry.leg.quantity * entry.leg.multiplier;
      callAwaysWithUpside += 1;
    }
  }

  // F17–F19 and F21 by calendar year.
  const rates = await loadTreasuryBillRates(dataDirectory, first, last);
  const years = [...new Set(sessionDates.map((date) => date.slice(0, 4)))];
  const yearEnds = new Map(years.map((year) => [year, sessionDates.filter((date) => date.startsWith(year)).at(-1)!]));
  const leapsFile = BacktestSymbolFile.open(symbol);
  let leapsByYear: Map<string, number>;
  try {
    leapsByYear = leapsPnlByYear(leapsFile, detail.positions, yearEnds, v4.leapsSpreadCostChargedPct / 100, pnlSources?.leaps?.pnlDollars ?? 0);
  } finally {
    leapsFile.close();
  }
  const dayByDate = new Map(days.map((day) => [day.tradingDate, day]));
  const wholeWeeks = wholeWeeksBetween(sessionDates, expiryDays, first, last);
  const weeksByYear = expiryWeeksBy(wholeWeeks, "year");
  const yieldsOf = (sales: readonly SessionAction[]) => sales.flatMap((sale) => (sale.candidate_scores?.premiumYield == null ? [] : [sale.candidate_scores.premiumYield]));
  const ivByContracts = (sales: readonly SessionAction[]) => {
    const withIv = sales.filter((sale) => sale.candidate_scores?.impliedVolatility != null);
    const contracts = sum(withIv.map((sale) => Number(sale.quantity ?? 0)));
    return contracts === 0 ? null : sum(withIv.map((sale) => sale.candidate_scores!.impliedVolatility! * Number(sale.quantity ?? 0))) / contracts;
  };
  const yearRows: AnalysisYearRow[] = years.map((year, index) => {
    const fromDate = index === 0 ? null : yearEnds.get(years[index - 1]!)!;
    const inYear = days.filter((day) => day.tradingDate.startsWith(year));
    const end = inYear.at(-1)!;
    const startDay = fromDate === null ? null : dayByDate.get(fromDate)!;
    const startValue = startDay?.accountValue ?? startingValue;
    const holdStart = startDay?.baselineValue ?? startingValue;
    const spyStart = startDay === null ? startingValue : startDay.spyBaselineValue;
    const change = end.accountValue - startValue;
    const inYearSold = (entry: { saleDate: string; exitDate: string | null }) => (entry.exitDate ?? entry.saleDate).startsWith(year);
    const calls = sum(callLegs.filter(inYearSold).map((entry) => entry.pnlDollars));
    const puts = sum(putLegs.filter(inYearSold).map((entry) => entry.pnlDollars));
    const leaps = leapsByYear.get(year) ?? 0;
    const interest = sum(inYear.map((day) => day.interestDollars));
    const shares = change - calls - puts - leaps - interest;
    const drawdownIn = (valueOf: (day: (typeof days)[number]) => number | null, startValueOfYear: number | null) => {
      let peak = startValueOfYear ?? Number.NEGATIVE_INFINITY;
      let worst = 0;
      for (const day of inYear) {
        const value = valueOf(day);
        if (value === null) return null;
        peak = Math.max(peak, value);
        worst = Math.min(worst, value / peak - 1);
      }
      return worst;
    };
    const spanStart = fromDate ?? first;
    const span = calendarDaysBetween(spanStart, end.tradingDate);
    const yearCallSales = callSales.filter((sale) => sale.trading_date.startsWith(year));
    const expiryInYear = sessionDates.filter((date) => date.startsWith(year) && expiryDays.has(date));
    const weeks = weeksByYear.get(year) ?? { wholeWeeks: 0, weeksWithExpiryDay: 0 };
    const tbill = rates.ratePercentOnOrBefore(spanStart) === null ? null : (1 + treasuryBillCagr(rates, spanStart, end.tradingDate)) ** (span / 365.25) - 1;
    return {
      year,
      fromDate,
      toDate: end.tradingDate,
      startValue,
      endValue: end.accountValue,
      v4Return: end.accountValue / startValue - 1,
      holdReturn: holdStart > 0 ? end.baselineValue / holdStart - 1 : null,
      spyReturn: spyStart === null || end.spyBaselineValue === null || !(spyStart > 0) ? null : end.spyBaselineValue / spyStart - 1,
      treasuryBillReturn: tbill,
      v4MaxDrawdown: drawdownIn((day) => day.accountValue, startValue) ?? 0,
      holdMaxDrawdown: drawdownIn((day) => day.baselineValue, holdStart),
      sources: { calls, puts, leaps, interest, shares },
      parts: { calls: calls / startValue, puts: puts / startValue, leaps: leaps / startValue, interest: interest / startValue, shares: shares / startValue },
      callsSold: yearCallSales.length,
      callYieldMedian: median(yieldsOf(yearCallSales)),
      callImpliedVolatility: ivByContracts(yearCallSales),
      expiryDays: expiryInYear.length,
      expiryDaysSold: expiryInYear.filter((date) => callSaleDays.has(date)).length,
      wholeWeeks: weeks.wholeWeeks,
      weeksWithExpiryDay: weeks.weeksWithExpiryDay,
      calledAway: calledAwayLegs.filter((entry) => entry.exitDate!.startsWith(year)).length,
      putsSold: putSales.filter((sale) => sale.trading_date.startsWith(year)).length,
      putsAssigned: putLegs.filter((entry) => entry.leg.settledAs === "assigned" && (entry.exitDate ?? "").startsWith(year)).length,
      topUps: topUps.filter((action) => action.trading_date.startsWith(year)).length,
      trims: trims.filter((action) => action.trading_date.startsWith(year)).length,
    };
  });
  const allExpiryDays = sessionDates.filter((date) => expiryDays.has(date));

  // The daily series: values, drawdown, free cash and the shares against the pot (F24).
  const cashAvailable = new Map((await loadCashAvailableByDay(sessionId, connection)).map(([date, freeCash, , accountValue]) => [date, accountValue > 0 ? freeCash / accountValue : null]));
  let peakValue = 0;
  const dailyRows: AnalysisBacktestFigures["days"] = days.map((day) => {
    peakValue = Math.max(peakValue, day.accountValue);
    const pot = day.accountValue * potShareOfAccount;
    return [day.tradingDate, day.accountValue, day.baselineValue, day.spyBaselineValue, day.accountValue / peakValue - 1, cashAvailable.get(day.tradingDate) ?? null, pot > 0 ? (sharesValueOn.get(day.tradingDate) ?? 0) / pot : 0];
  });
  let maxDrawdownDates: AnalysisBacktestFigures["maxDrawdownDates"] = null;
  {
    let peak = 0;
    let worst = { depth: 0, peak: 0, trough: 0 };
    days.forEach((day, index) => {
      if (day.accountValue > days[peak]!.accountValue) peak = index;
      const depth = day.accountValue / days[peak]!.accountValue - 1;
      if (depth < worst.depth) worst = { depth, peak, trough: index };
    });
    if (worst.depth < 0) {
      const back = days.find((day, index) => index > worst.trough && day.accountValue >= days[worst.peak]!.accountValue);
      maxDrawdownDates = { peak: days[worst.peak]!.tradingDate, trough: days[worst.trough]!.tradingDate, back: back?.tradingDate ?? null };
    }
  }

  // The wheel cycles, as the session screen's table lists them, with the account's return and the stock's change over each:
  // its B&H, close to close on split-adjusted closes (the close of its last day ÷ the close of the session before its first − 1).
  const indexOf = new Map(sessionDates.map((date, index) => [date, index]));
  const closeIndexOf = new Map(closes.map((bar, index) => [bar.tradingDate, index]));
  const closeToClose = (firstDate: string, lastDate: string) => {
    const firstIndex = closeIndexOf.get(firstDate);
    const before = firstIndex !== undefined && firstIndex > 0 ? closes[firstIndex - 1]!.close : null;
    const lastIndex = closeIndexOf.get(lastDate);
    const lastClose = lastIndex === undefined ? null : closes[lastIndex]!.close;
    return before === null || lastClose === null || before <= 0 ? null : lastClose / before - 1;
  };
  const cycles: AnalysisBacktestFigures["cycles"] = detail.cycles.filter((cycle) => cycle.symbol === symbol).map((cycle) => {
    const openIndex = indexOf.get(cycle.openedOn) ?? 0;
    const closeIndex = cycle.closedOn === null ? sessionDates.length - 1 : (indexOf.get(cycle.closedOn) ?? sessionDates.length - 1);
    const afterClose = cycle.closedOn === null ? last : (sessionDates[closeIndex + 1] ?? last);
    const openedValue = dayByDate.get(cycle.openedOn)?.accountValue ?? null;
    const closedValue = dayByDate.get(afterClose)?.accountValue ?? null;
    const callsInCycle = callSales.filter((sale) => sale.trading_date >= cycle.openedOn && sale.trading_date <= sessionDates[closeIndex]!).length;
    return [cycle.cycleNumber, cycle.status === "open", cycle.openedOn, cycle.closedOn, closeIndex - openIndex + 1, cycle.totalDollars, openedValue && closedValue ? closedValue / openedValue - 1 : null, closeToClose(cycle.openedOn, cycle.closedOn ?? last), callsInCycle, cycle.netPremiumDollars, cycle.totalDollars - cycle.netPremiumDollars];
  });

  // F11 for each fall that reaches into the backtest, with the top-ups inside its window.
  const fallsInBacktest: AnalysisBacktestFigures["falls"] = {};
  for (const fall of falls) {
    const during = accountDuringFall(fall, days);
    if (during === null) continue;
    const inside = topUps.filter((action) => action.trading_date >= during.fromDate && action.trading_date <= during.toDate);
    fallsInBacktest[fall.peakDate] = { ...during, topUps: inside.length, topUpDollars: sum(inside.map((action) => Number(action.quantity ?? 0) * Number(action.fill_price ?? 0))) };
  }

  const tbillCagr = rates.ratePercentOnOrBefore(first) === null ? null : treasuryBillCagr(rates, first, last);
  const metrics = session.metrics;
  const hold = session.baselineMetrics;
  const spy = session.spyBaselineMetrics;
  const calmar = (entry: BacktestMetrics | null) => (entry === null || tbillCagr === null ? null : excessCalmarOf(Number(entry.cagr), Number(entry.maxDrawdown), tbillCagr));
  const share = (action: SessionAction) => Number(action.quantity ?? 0);
  return {
    sessionId,
    name: session.name,
    status: session.status,
    startDate: first,
    endDate: last,
    startingValue,
    startingPotDollars,
    metrics,
    buyAndHoldMetrics: hold,
    spyMetrics: spy,
    excessCalmar: { v4: detail.excessCalmar, hold: calmar(hold), spy: calmar(spy) },
    treasuryBillCagr: tbillCagr,
    maxDrawdownDates,
    rule,
    sources: pnlSources,
    interest: metrics === null ? null : { pnlDollars: Number(metrics.interestDollars), cagrPart: Number(metrics.endValue) === Number(metrics.startValue) ? null : (Number(metrics.cagr) * Number(metrics.interestDollars)) / (Number(metrics.endValue) - Number(metrics.startValue)) },
    daysWithNoOptions: detail.daysWithNoOptions,
    averages: {
      sharesShare: mean(days.map((day) => (day.accountValue > 0 ? (sharesValueOn.get(day.tradingDate) ?? 0) / day.accountValue : 0))),
      cashShare: mean(days.map((day) => (day.accountValue > 0 ? day.cash / day.accountValue : 0))),
      freeCashShare: mean([...cashAvailable.values()].flatMap((value) => (value === null ? [] : [value]))),
    },
    upsideGivenUp: { dollars: upsideDollars, callAways: calledAwayLegs.length, callAwaysWithUpside },
    topUps: { count: topUps.length, lots: sum(topUps.map((action) => lotsOf(share(action)))), dollars: sum(topUps.map((action) => share(action) * Number(action.fill_price ?? 0))) },
    trims: { count: trims.length, lots: sum(trims.map((action) => lotsOf(share(action)))), dollars: sum(trims.map((action) => share(action) * Number(action.fill_price ?? 0))) },
    years: yearRows,
    allYears: {
      callsSold: callSales.length,
      callYieldMedian: median(yieldsOf(callSales)),
      callImpliedVolatility: ivByContracts(callSales),
      expiryDays: allExpiryDays.length,
      expiryDaysSold: allExpiryDays.filter((date) => callSaleDays.has(date)).length,
      wholeWeeks: wholeWeeks.length,
      weeksWithExpiryDay: wholeWeeks.filter((week) => week.hasExpiryDay).length,
      calledAway: calledAwayLegs.length,
      putsSold: putSales.length,
      putsAssigned: putLegs.filter((entry) => entry.leg.settledAs === "assigned").length,
      topUps: topUps.length,
      trims: trims.length,
    },
    monthly: detail.monthlyReturns.map((month) => [month.month, month.sessionReturn, month.baselineReturn, month.spyBaselineReturn]),
    days: dailyRows,
    callSales: callSales.map((sale) => [sale.trading_date, Number(sale.contract?.strike ?? 0), Number(sale.quantity ?? 0), Number(sale.fill_price ?? 0), sale.candidate_scores?.impliedVolatility ?? null, sale.candidate_scores?.premiumYield ?? null]),
    events: {
      topUps: topUps.map((action) => [action.trading_date, action.candidate_scores?.lotsBefore ?? null, action.candidate_scores?.lotsAfter ?? null, Number(action.fill_price ?? 0)]),
      trims: trims.map((action) => [action.trading_date, action.candidate_scores?.lotsBefore ?? null, action.candidate_scores?.lotsAfter ?? null, Number(action.fill_price ?? 0)]),
      calledAway: calledAwayLegs.map((entry) => [entry.exitDate!, entry.leg.strike! / entry.leg.priceScale, entry.leg.quantity]),
    },
    expiryDaysWithoutCall: allExpiryDays.filter((date) => !callSaleDays.has(date)).map((date) => [date, dayByDate.get(date)?.decisionSummary ?? null]),
    cycles,
    falls: fallsInBacktest,
    putsSold: putSales.length,
    leapsBought,
  };
}
