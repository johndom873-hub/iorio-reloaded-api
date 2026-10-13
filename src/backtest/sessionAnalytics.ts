import type { BacktestAccuracyBand, BacktestMetrics, BacktestMonthlyReturn } from "./backtestTypes.js";

// The backtest's headline figures, exactly as approved in docs/backtesting/FORMULAS.md (Marcelo 2026-10-12). Pure.

export const tradingDaysPerYear = 252;
export const calendarDaysPerYear = 365;

/** One day of an account (a session or the buy-and-hold baseline), marked at 10:00 ET. */
export interface AccountDay {
  tradingDate: string;
  value: number;
  /** Σ EXP $ of what is held (net of premium for options; the shares' value for buy and hold). */
  exposureDollars: number;
  interestDollars: number;
}

/** One option sold of a session measured per option (the sessions run before wheel cycles carried the P&L). */
export interface ClosedTradeFigures {
  openedOn: string;
  settledOn: string | null;
  exposureDollars: number;
  pnlDollars: number | null;
  /** Null for a baseline wheel's sale: no model figures. */
  expectedPnlDollars: number | null;
  calibratedExpectedPnlDollars: number | null;
  edgeMargin: number | null;
  inTheMoneyAtExpiry: boolean | null;
}

/** One wheel cycle with what the model predicted for the options sold in it. */
export interface CycleFigures {
  status: "open" | "closed";
  /** The cycle's P&L as the platform derives it; an open cycle's counts what it holds at the last marks. */
  totalDollars: number;
  /** The edge margin of the first option sold in the cycle; null when it sold none. */
  firstSaleEdgeMargin: number | null;
  /** Σ Edge $ (and Σ history-corrected Edge $) of the options sold in the cycle. */
  expectedPnlDollars: number;
  calibratedExpectedPnlDollars: number;
  optionSaleCount: number;
}

/** What a session's book gives its metrics: its options sold (for their count and how they ended) and its wheel cycles (for the P&L). */
export interface SessionBookFigures {
  optionSales: readonly { inTheMoneyAtExpiry: boolean | null }[];
  cycles: readonly CycleFigures[];
}

/** The cycles of a session with the predictions of their options sold: a sale belongs to the cycle its row names. */
export function cycleFiguresOf(cycles: readonly { symbol: string; cycleNumber: number; status: "open" | "closed"; totalDollars: number }[], optionSales: readonly { symbol: string; cycleNumber: number | null; edgeMargin: number | null; expectedPnlDollars: number | null; calibratedExpectedPnlDollars: number | null }[]): CycleFigures[] {
  return cycles.map((cycle) => {
    // In the order sold: the first is the cycle's opening sale.
    const sales = optionSales.filter((sale) => sale.symbol === cycle.symbol && sale.cycleNumber === cycle.cycleNumber);
    return {
      status: cycle.status,
      totalDollars: cycle.totalDollars,
      firstSaleEdgeMargin: sales[0]?.edgeMargin ?? null,
      expectedPnlDollars: sales.reduce((sum, sale) => sum + (sale.expectedPnlDollars ?? 0), 0),
      calibratedExpectedPnlDollars: sales.reduce((sum, sale) => sum + (sale.calibratedExpectedPnlDollars ?? 0), 0),
      optionSaleCount: sales.length,
    };
  });
}

export function calendarDaysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** value ÷ previous value − 1; null on the first day. */
export function computeDailyReturns(values: readonly number[]): (number | null)[] {
  return values.map((value, index) => (index === 0 ? null : value / values[index - 1]! - 1));
}

/** Each day's fall from the highest value so far, ≤ 0 (−0.097 = 9.7% below the peak). */
export function computeDrawdowns(values: readonly number[]): number[] {
  let peak = -Infinity;
  return values.map((value) => {
    peak = Math.max(peak, value);
    return value / peak - 1;
  });
}

/** mean(r) × 252 ÷ (downside deviation × √252), downside deviation = √(mean of min(r, 0)²) over all days; null without a downside. */
export function computeSortino(dailyReturns: readonly number[]): number | null {
  if (dailyReturns.length < 2) return null;
  const mean = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;
  const downsideDeviation = Math.sqrt(dailyReturns.reduce((sum, r) => sum + Math.min(r, 0) ** 2, 0) / dailyReturns.length);
  if (!(downsideDeviation > 0)) return null;
  return (mean * tradingDaysPerYear) / (downsideDeviation * Math.sqrt(tradingDaysPerYear));
}

/** Each month's daily returns compounded: Π (1 + r) − 1. The first month starts from `startValue`. */
export function computeMonthlyReturnsOf(days: readonly { tradingDate: string; value: number }[], startValue: number): { month: string; monthlyReturn: number }[] {
  const months: { month: string; monthlyReturn: number }[] = [];
  let previousMonthEnd = startValue;
  for (let index = 0; index < days.length; index++) {
    const day = days[index]!;
    const month = day.tradingDate.slice(0, 7);
    const isMonthEnd = index === days.length - 1 || days[index + 1]!.tradingDate.slice(0, 7) !== month;
    if (isMonthEnd) {
      months.push({ month, monthlyReturn: day.value / previousMonthEnd - 1 });
      previousMonthEnd = day.value;
    }
  }
  return months;
}

/** The session's and its two baselines' monthly returns side by side (SPY's null when the session has no SPY series). */
export function computeMonthlyReturns(days: readonly { tradingDate: string; accountValue: number; baselineValue: number; spyBaselineValue?: number | null }[], startValue: number): BacktestMonthlyReturn[] {
  const session = computeMonthlyReturnsOf(days.map((day) => ({ tradingDate: day.tradingDate, value: day.accountValue })), startValue);
  const baseline = computeMonthlyReturnsOf(days.map((day) => ({ tradingDate: day.tradingDate, value: day.baselineValue })), startValue);
  const hasSpyBaseline = days.length > 0 && days.every((day) => day.spyBaselineValue !== null && day.spyBaselineValue !== undefined);
  const spyBaseline = hasSpyBaseline ? computeMonthlyReturnsOf(days.map((day) => ({ tradingDate: day.tradingDate, value: day.spyBaselineValue! })), startValue) : null;
  return session.map((entry, index) => ({ month: entry.month, sessionReturn: entry.monthlyReturn, baselineReturn: baseline[index]!.monthlyReturn, spyBaselineReturn: spyBaseline?.[index]!.monthlyReturn ?? null }));
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The headline figures for one account series. `book` is the session's options sold and wheel cycles; null for a
 * buy-and-hold series (no trades, no cycles: those figures are then 0 or null).
 *
 * On the cycles (Marcelo 2026-10-12: a sale made money when its wheel cycle did):
 *   win rate                    = closed cycles with a total above 0 ÷ closed cycles
 *   average win / average loss  = mean total of the closed cycles above 0 / below 0
 *   edge capture                = Σ closed cycles' totals ÷ Σ Edge $ predicted for the options sold in those cycles
 *   return on capital in use    = Σ every cycle's total ÷ Σ over the days of (EXP $ held that day × calendar days to the
 *                                 next session day) × 365
 */
export function computeBacktestMetrics(days: readonly AccountDay[], book: SessionBookFigures | null, startValue: number): BacktestMetrics {
  const values = days.map((day) => day.value);
  const endValue = values.at(-1) ?? startValue;
  const totalReturn = endValue / startValue - 1;
  const calendarDays = days.length > 1 ? calendarDaysBetween(days[0]!.tradingDate, days.at(-1)!.tradingDate) : 0;
  const cagr = calendarDays > 0 ? (endValue / startValue) ** (calendarDaysPerYear / calendarDays) - 1 : 0;
  const dailyReturns = computeDailyReturns(values).filter((r): r is number => r !== null);
  const monthly = computeMonthlyReturnsOf(days.map((day) => ({ tradingDate: day.tradingDate, value: day.value })), startValue);

  const closedCycles = (book?.cycles ?? []).filter((cycle) => cycle.status === "closed");
  const wins = closedCycles.filter((cycle) => cycle.totalDollars > 0).map((cycle) => cycle.totalDollars);
  const losses = closedCycles.filter((cycle) => cycle.totalDollars < 0).map((cycle) => cycle.totalDollars);
  const closedTotal = closedCycles.reduce((sum, cycle) => sum + cycle.totalDollars, 0);
  const closedExpected = closedCycles.reduce((sum, cycle) => sum + cycle.expectedPnlDollars, 0);
  const everyCycleTotal = (book?.cycles ?? []).reduce((sum, cycle) => sum + cycle.totalDollars, 0);
  const exposureDays = days.reduce((sum, day, index) => sum + (index < days.length - 1 ? day.exposureDollars * calendarDaysBetween(day.tradingDate, days[index + 1]!.tradingDate) : 0), 0);
  const settledWithOutcome = (book?.optionSales ?? []).filter((sale) => sale.inTheMoneyAtExpiry !== null);

  return {
    startValue,
    endValue,
    totalReturn,
    cagr,
    sortino: computeSortino(dailyReturns),
    maxDrawdown: Math.min(0, ...computeDrawdowns(values)),
    worstMonth: monthly.length === 0 ? null : Math.min(...monthly.map((entry) => entry.monthlyReturn)),
    tradeCount: book?.optionSales.length ?? 0,
    ...(book ? { cycleCount: book.cycles.length, closedCycleCount: closedCycles.length } : {}),
    winRate: closedCycles.length === 0 ? null : wins.length / closedCycles.length,
    averageWinDollars: mean(wins),
    averageLossDollars: mean(losses),
    edgeCapture: closedCycles.length === 0 || !(closedExpected > 0) ? null : closedTotal / closedExpected,
    capitalInUse: mean(days.map((day) => (day.value > 0 ? day.exposureDollars / day.value : 0))) ?? 0,
    returnOnCapitalInUse: book && exposureDays > 0 ? (everyCycleTotal / exposureDays) * calendarDaysPerYear : null,
    inTheMoneyAtExpiryShare: settledWithOutcome.length === 0 ? null : settledWithOutcome.filter((sale) => sale.inTheMoneyAtExpiry).length / settledWithOutcome.length,
    interestDollars: days.reduce((sum, day) => sum + day.interestDollars, 0),
  };
}

const accuracyBandEdges: { label: string; from: number; to: number }[] = [
  { label: "under 0%", from: -Infinity, to: 0 },
  { label: "0–10%", from: 0, to: 0.1 },
  { label: "10–20%", from: 0.1, to: 0.2 },
  { label: "20–30%", from: 0.2, to: 0.3 },
  { label: "30% and over", from: 0.3, to: Infinity },
];

/**
 * Closed wheel cycles grouped by the edge margin of the first option sold in each: what the model predicted for the
 * cycle's options sold (raw and history-corrected) vs the cycle's total.
 */
export function computeCycleAccuracyBands(cycles: readonly CycleFigures[]): BacktestAccuracyBand[] {
  return accuracyBandEdges.map((band) => {
    const inBand = cycles.filter((cycle) => cycle.status === "closed" && cycle.firstSaleEdgeMargin !== null && cycle.firstSaleEdgeMargin >= band.from && cycle.firstSaleEdgeMargin < band.to);
    return {
      label: band.label,
      tradeCount: inBand.reduce((sum, cycle) => sum + cycle.optionSaleCount, 0),
      cycleCount: inBand.length,
      predictedPnlDollars: inBand.reduce((sum, cycle) => sum + cycle.expectedPnlDollars, 0),
      calibratedPnlDollars: inBand.reduce((sum, cycle) => sum + cycle.calibratedExpectedPnlDollars, 0),
      realizedPnlDollars: inBand.reduce((sum, cycle) => sum + cycle.totalDollars, 0),
    };
  });
}

/** For a session measured per option: its closed options grouped by their own edge margin, predicted vs what each earned. */
export function computeTradeAccuracyBands(trades: readonly ClosedTradeFigures[]): BacktestAccuracyBand[] {
  return accuracyBandEdges.map((band) => {
    const inBand = trades.filter((trade) => trade.pnlDollars !== null && trade.edgeMargin !== null && trade.edgeMargin >= band.from && trade.edgeMargin < band.to);
    return {
      label: band.label,
      tradeCount: inBand.length,
      cycleCount: null,
      predictedPnlDollars: inBand.reduce((sum, trade) => sum + (trade.expectedPnlDollars ?? 0), 0),
      calibratedPnlDollars: inBand.reduce((sum, trade) => sum + (trade.calibratedExpectedPnlDollars ?? 0), 0),
      realizedPnlDollars: inBand.reduce((sum, trade) => sum + (trade.pnlDollars ?? 0), 0),
    };
  });
}
