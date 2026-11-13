import { annualiseReturnPercent, chainReturnFractions, type DailyPerformancePoint } from "./performanceReturns.js";

// A book's return and risk figures over a range of nights (formulas approved by Marcelo 2026-11-13). r is the time-weighted
// daily return of performanceReturns.ts; rf is the 3-month T-bill (FRED TB3MS) in force that month, as a daily rate (÷ 252).
//
//   CAGR           (1 + R) ^ (365 / days) − 1                          shown from 90 calendar days
//   Max drawdown   min over the range of (growth index ÷ its running peak − 1), with its dollars, dates and length (always)
//   Volatility     sample stdev(r) × √252                              shown from 60 daily returns
//   Sharpe         (mean(r) − rf) ÷ stdev(r) × √252                     shown from 60 daily returns
//   Sortino        (mean(r) − rf) × √252 ÷ √(mean(min(r − rf, 0)²))     shown from 60 daily returns
//   Excess Calmar  (CAGR − T-bill) ÷ |Max drawdown|                     shown from 180 calendar days; T-bill = mean annual rf
//
// Example (Excess Calmar): CAGR 18%, T-bill 4.05%, Max drawdown −6% → (18 − 4.05) ÷ 6 = 2.33.
// Below its minimum a figure is null with how much history it has and needs, so the screen shows "—, 4 of 60 days".

export const minimumCalendarDaysForCagr = 90;
export const minimumDailyReturnsForVolatilityRatios = 60;
export const minimumCalendarDaysForExcessCalmar = 180;
const tradingDaysPerYear = 252;

export interface GatedFigure {
  value: number | null;
  have: number;
  need: number;
  unit: "calendar days" | "daily returns";
}

export interface DrawdownFigure {
  /** Negative percent, 0 when the index never fell below a peak. */
  percent: number;
  /** Cumulative P&L at the trough less at the peak (negative). */
  dollars: number;
  peakNight: string | null;
  troughNight: string | null;
  /** First night back at the peak's level; null while still under it. */
  recoveryNight: string | null;
  /** Calendar days from the peak to the recovery, or to the last night while not recovered. */
  lengthDays: number;
}

export interface SeriesPoint {
  night: string;
  pnl: number;
  cumulativePnl: number;
  growthIndex: number;
  drawdownPercent: number;
}

export interface BookRiskFigures {
  baselineNight: string;
  lastNight: string;
  calendarDays: number;
  dailyReturnCount: number;
  pnl: number;
  returnPercent: number | null;
  cagrPercent: GatedFigure;
  maxDrawdown: DrawdownFigure;
  currentDrawdownPercent: number;
  volatilityPercent: GatedFigure;
  sharpe: GatedFigure;
  sortino: GatedFigure;
  excessCalmar: GatedFigure;
  /** Mean annual T-bill rate over the range, percent; null when no rate is stored. */
  treasuryBillPercent: number | null;
  bestDay: { night: string; returnPercent: number } | null;
  worstDay: { night: string; returnPercent: number } | null;
  positiveDaysPercent: number | null;
  series: SeriesPoint[];
}

function calendarDaysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

function gated(value: number | null, have: number, need: number, unit: GatedFigure["unit"]): GatedFigure {
  return { value: have >= need ? value : null, have, need, unit };
}

/**
 * Pure. `points` are the range's daily returns (nights after `baselineNight`, up to the last); `annualRiskFreePercentAt`
 * gives the T-bill rate in force on a night, or null when none is known (the ratios that need it are then null).
 */
export function computeBookRiskFigures(baselineNight: string, points: readonly DailyPerformancePoint[], annualRiskFreePercentAt: (night: string) => number | null): BookRiskFigures {
  const ordered = [...points].sort((first, second) => first.snapshotDate.localeCompare(second.snapshotDate));
  const lastNight = ordered.at(-1)?.snapshotDate ?? baselineNight;
  const calendarDays = calendarDaysBetween(baselineNight, lastNight);
  const count = ordered.length;
  const chained = chainReturnFractions(ordered.map((point) => point.returnFraction));
  const returnPercent = chained === null ? null : chained * 100;
  const cagr = returnPercent === null ? null : annualiseReturnPercent(returnPercent, calendarDays);

  // Growth index and drawdown, the baseline night at 1.
  const series: SeriesPoint[] = [];
  let index = 1;
  let peakIndex = 1;
  let peakNight = baselineNight;
  let peakCumulativePnl = 0;
  let cumulativePnl = 0;
  const maxDrawdown: DrawdownFigure = { percent: 0, dollars: 0, peakNight: null, troughNight: null, recoveryNight: null, lengthDays: 0 };
  let worstPeakIndex = 1;
  for (const point of ordered) {
    index *= 1 + point.returnFraction;
    cumulativePnl += point.profitDollars;
    if (index >= peakIndex) {
      peakIndex = index;
      peakNight = point.snapshotDate;
      peakCumulativePnl = cumulativePnl;
    }
    const drawdownPercent = (index / peakIndex - 1) * 100;
    if (drawdownPercent < maxDrawdown.percent) {
      maxDrawdown.percent = drawdownPercent;
      maxDrawdown.dollars = cumulativePnl - peakCumulativePnl;
      maxDrawdown.peakNight = peakNight;
      maxDrawdown.troughNight = point.snapshotDate;
      worstPeakIndex = peakIndex;
    }
    series.push({ night: point.snapshotDate, pnl: point.profitDollars, cumulativePnl, growthIndex: index, drawdownPercent });
  }
  if (maxDrawdown.troughNight !== null) {
    const troughNight = maxDrawdown.troughNight;
    maxDrawdown.recoveryNight = series.find((point) => point.night > troughNight && point.growthIndex >= worstPeakIndex * (1 - 1e-12))?.night ?? null;
    maxDrawdown.lengthDays = calendarDaysBetween(maxDrawdown.peakNight!, maxDrawdown.recoveryNight ?? lastNight);
  }

  // Volatility and the T-bill ratios.
  const returns = ordered.map((point) => point.returnFraction);
  const mean = count > 0 ? returns.reduce((sum, value) => sum + value, 0) / count : 0;
  const standardDeviation = count > 1 ? Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1)) : null;
  const dailyRiskFree = ordered.map((point) => {
    const annual = annualRiskFreePercentAt(point.snapshotDate);
    return annual === null ? null : annual / 100 / tradingDaysPerYear;
  });
  const riskFreeKnown = dailyRiskFree.every((value) => value !== null) && count > 0;
  const excessReturns = riskFreeKnown ? returns.map((value, position) => value - dailyRiskFree[position]!) : null;
  const meanExcess = excessReturns === null ? null : excessReturns.reduce((sum, value) => sum + value, 0) / count;
  const downsideDeviation = excessReturns === null ? null : Math.sqrt(excessReturns.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / count);
  const treasuryBillPercent = riskFreeKnown ? (dailyRiskFree.reduce((sum, value) => sum + value!, 0) / count) * tradingDaysPerYear * 100 : null;

  const sharpe = meanExcess !== null && standardDeviation !== null && standardDeviation > 0 ? (meanExcess / standardDeviation) * Math.sqrt(tradingDaysPerYear) : null;
  const sortino = meanExcess !== null && downsideDeviation !== null && downsideDeviation > 0 ? (meanExcess * Math.sqrt(tradingDaysPerYear)) / downsideDeviation : null;
  const excessCalmar = cagr !== null && treasuryBillPercent !== null && maxDrawdown.percent < 0 ? (cagr - treasuryBillPercent) / Math.abs(maxDrawdown.percent) : null;

  const best = ordered.reduce<DailyPerformancePoint | null>((found, point) => (found === null || point.returnFraction > found.returnFraction ? point : found), null);
  const worst = ordered.reduce<DailyPerformancePoint | null>((found, point) => (found === null || point.returnFraction < found.returnFraction ? point : found), null);

  return {
    baselineNight,
    lastNight,
    calendarDays,
    dailyReturnCount: count,
    pnl: cumulativePnl,
    returnPercent,
    cagrPercent: gated(cagr, calendarDays, minimumCalendarDaysForCagr, "calendar days"),
    maxDrawdown,
    currentDrawdownPercent: series.at(-1)?.drawdownPercent ?? 0,
    volatilityPercent: gated(standardDeviation === null ? null : standardDeviation * Math.sqrt(tradingDaysPerYear) * 100, count, minimumDailyReturnsForVolatilityRatios, "daily returns"),
    sharpe: gated(sharpe, count, minimumDailyReturnsForVolatilityRatios, "daily returns"),
    sortino: gated(sortino, count, minimumDailyReturnsForVolatilityRatios, "daily returns"),
    excessCalmar: gated(excessCalmar, calendarDays, minimumCalendarDaysForExcessCalmar, "calendar days"),
    treasuryBillPercent,
    bestDay: best === null ? null : { night: best.snapshotDate, returnPercent: best.returnFraction * 100 },
    worstDay: worst === null ? null : { night: worst.snapshotDate, returnPercent: worst.returnFraction * 100 },
    positiveDaysPercent: count > 0 ? (ordered.filter((point) => point.returnFraction > 0).length / count) * 100 : null,
    series,
  };
}
