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

export interface ClosedTradeFigures {
  openedOn: string;
  settledOn: string | null;
  exposureDollars: number;
  pnlDollars: number | null;
  expectedPnlDollars: number;
  calibratedExpectedPnlDollars: number;
  edgeMargin: number;
  inTheMoneyAtExpiry: boolean | null;
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

/** The session's and the baseline's monthly returns side by side. */
export function computeMonthlyReturns(days: readonly { tradingDate: string; accountValue: number; baselineValue: number }[], startValue: number): BacktestMonthlyReturn[] {
  const session = computeMonthlyReturnsOf(days.map((day) => ({ tradingDate: day.tradingDate, value: day.accountValue })), startValue);
  const baseline = computeMonthlyReturnsOf(days.map((day) => ({ tradingDate: day.tradingDate, value: day.baselineValue })), startValue);
  return session.map((entry, index) => ({ month: entry.month, sessionReturn: entry.monthlyReturn, baselineReturn: baseline[index]!.monthlyReturn }));
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The headline figures for one account series; `trades` empty for buy and hold (trade figures then null). */
export function computeBacktestMetrics(days: readonly AccountDay[], trades: readonly ClosedTradeFigures[], startValue: number): BacktestMetrics {
  const values = days.map((day) => day.value);
  const endValue = values.at(-1) ?? startValue;
  const totalReturn = endValue / startValue - 1;
  const calendarDays = days.length > 1 ? calendarDaysBetween(days[0]!.tradingDate, days.at(-1)!.tradingDate) : 0;
  const cagr = calendarDays > 0 ? (endValue / startValue) ** (calendarDaysPerYear / calendarDays) - 1 : 0;
  const dailyReturns = computeDailyReturns(values).filter((r): r is number => r !== null);
  const monthly = computeMonthlyReturnsOf(days.map((day) => ({ tradingDate: day.tradingDate, value: day.value })), startValue);

  const closed = trades.filter((trade) => trade.pnlDollars !== null) as (ClosedTradeFigures & { pnlDollars: number })[];
  const wins = closed.filter((trade) => trade.pnlDollars > 0).map((trade) => trade.pnlDollars);
  const losses = closed.filter((trade) => trade.pnlDollars < 0).map((trade) => trade.pnlDollars);
  const totalPnl = closed.reduce((sum, trade) => sum + trade.pnlDollars, 0);
  const totalExpected = closed.reduce((sum, trade) => sum + trade.expectedPnlDollars, 0);
  // Return on capital in use: Σ P&L ÷ Σ (EXP $ × calendar days held) × 365; a same-day expiry counts one day.
  const exposureDays = closed.reduce((sum, trade) => sum + trade.exposureDollars * Math.max(1, calendarDaysBetween(trade.openedOn, trade.settledOn ?? trade.openedOn)), 0);
  const settledWithOutcome = trades.filter((trade) => trade.inTheMoneyAtExpiry !== null);

  return {
    startValue,
    endValue,
    totalReturn,
    cagr,
    sortino: computeSortino(dailyReturns),
    maxDrawdown: Math.min(0, ...computeDrawdowns(values)),
    worstMonth: monthly.length === 0 ? null : Math.min(...monthly.map((entry) => entry.monthlyReturn)),
    tradeCount: trades.length,
    winRate: closed.length === 0 ? null : wins.length / closed.length,
    averageWinDollars: mean(wins),
    averageLossDollars: mean(losses),
    edgeCapture: closed.length === 0 || !(totalExpected > 0) ? null : totalPnl / totalExpected,
    capitalInUse: mean(days.map((day) => (day.value > 0 ? day.exposureDollars / day.value : 0))) ?? 0,
    returnOnCapitalInUse: exposureDays > 0 ? (totalPnl / exposureDays) * calendarDaysPerYear : null,
    inTheMoneyAtExpiryShare: settledWithOutcome.length === 0 ? null : settledWithOutcome.filter((trade) => trade.inTheMoneyAtExpiry).length / settledWithOutcome.length,
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

/** Closed trades grouped by the edge margin at the open: what the model predicted (raw and history-corrected) vs what they earned. */
export function computeAccuracyBands(trades: readonly ClosedTradeFigures[]): BacktestAccuracyBand[] {
  return accuracyBandEdges.map((band) => {
    const inBand = trades.filter((trade) => trade.pnlDollars !== null && trade.edgeMargin >= band.from && trade.edgeMargin < band.to);
    return {
      label: band.label,
      tradeCount: inBand.length,
      predictedPnlDollars: inBand.reduce((sum, trade) => sum + trade.expectedPnlDollars, 0),
      calibratedPnlDollars: inBand.reduce((sum, trade) => sum + trade.calibratedExpectedPnlDollars, 0),
      realizedPnlDollars: inBand.reduce((sum, trade) => sum + (trade.pnlDollars ?? 0), 0),
    };
  });
}
