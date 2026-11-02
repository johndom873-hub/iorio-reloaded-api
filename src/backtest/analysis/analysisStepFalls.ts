import { computeYangZhangVolatility, type DailyOhlcvBar } from "../../lib/realizedVolatility.js";
import { percentileInclusive } from "./analysisPriceFigures.js";

// The Step and the falls of a Step over a ticker's daily bars (approved by Marcelo 2026-10-29, carried over for Vol
// Farmer v4 on 2026-11-01):
// - F9 the Step on any day = IV × √(21 ÷ 252) with IBKR's IV on that bar; before the ticker's first IV, or on a bar without
//   one, the 63-day Yang-Zhang volatility ending that day stands in for the IV. Median, 10th and 90th percentile over every
//   bar with a Step (PERCENTILE.INC).
// - F7 falls of a Step: a fall runs from a peak close to its lowest close before the first close back at or above the peak
//   (or to the last bar). Its yardstick S = the larger of the peak day's Step and the median Step; it counts when its depth
//   (1 − low ÷ peak) is at least S. In Steps = depth ÷ S. Days down: calendar days from the peak to the low; days back: from
//   the low to the first close at or above the peak.
// - F11 v4's account during a fall: from the later of the peak and the backtest's first day to the stock's back day (or
//   the backtest's end); its fall = the lowest account value there ÷ the value on its first day − 1, back on the first
//   later day the account is at or above that first-day value.

export const stepFactor = Math.sqrt(21 / 252);
const realisedStandInDays = 63;
const dayMilliseconds = 86_400_000;
const calendarDaysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / dayMilliseconds);

export interface StepOnDay {
  /** A fraction: 0.0807 = a Step of 8.07%. */
  step: number;
  /** The volatility it was taken from: IBKR's IV, or the 63-day Yang-Zhang standing in for it. */
  volatility: number;
  source: "implied" | "realised";
}

/** F9 for every bar (null when neither an IV nor 63 bars of history are there). */
export function stepsOfBars(bars: readonly (DailyOhlcvBar & { impliedVolatility: number | null })[]): (StepOnDay | null)[] {
  const ohlcv = bars as unknown as DailyOhlcvBar[];
  return bars.map((bar, index) => {
    if (bar.impliedVolatility !== null && bar.impliedVolatility > 0) return { step: bar.impliedVolatility * stepFactor, volatility: bar.impliedVolatility, source: "implied" };
    const realised = computeYangZhangVolatility(ohlcv, realisedStandInDays, index + 1);
    return realised.available ? { step: realised.annualizedVolatility * stepFactor, volatility: realised.annualizedVolatility, source: "realised" } : null;
  });
}

export interface StepStatistics {
  median: number | null;
  tenth: number | null;
  ninetieth: number | null;
  barsWithStep: number;
  /** Bars whose Step is the 63-day Yang-Zhang's. */
  barsFromRealised: number;
}

export function stepStatistics(steps: readonly (StepOnDay | null)[]): StepStatistics {
  const values = steps.flatMap((entry) => (entry === null ? [] : [entry.step]));
  return {
    median: percentileInclusive(values, 0.5),
    tenth: percentileInclusive(values, 0.1),
    ninetieth: percentileInclusive(values, 0.9),
    barsWithStep: values.length,
    barsFromRealised: steps.filter((entry) => entry?.source === "realised").length,
  };
}

export interface FallOfAStep {
  peakDate: string;
  peakClose: number;
  lowDate: string;
  lowClose: number;
  /** The first close at or above the peak; null when not back yet. */
  backDate: string | null;
  /** 1 − low ÷ peak, a positive fraction. */
  depth: number;
  /** The yardstick S: the larger of the peak day's Step and the median Step. */
  yardstick: number;
  /** Where S came from: the peak day's Step (from its IV or the realised stand-in) or the median. */
  yardstickFrom: "implied" | "realised" | "median";
  /** depth ÷ S. */
  steps: number;
  daysDown: number;
  daysBack: number | null;
}

/** F7 over every bar, oldest first. */
export function fallsOfAStep(bars: readonly { tradingDate: string; close: number }[], steps: readonly (StepOnDay | null)[], medianStep: number): FallOfAStep[] {
  const episodes: { peak: number; low: number; back: number | null }[] = [];
  let peak = 0;
  let low = 0;
  for (let index = 1; index < bars.length; index++) {
    if (bars[index]!.close >= bars[peak]!.close) {
      if (low !== peak) episodes.push({ peak, low, back: index });
      peak = index;
      low = index;
    } else if (bars[index]!.close < bars[low]!.close) low = index;
  }
  if (bars.length > 0 && low !== peak) episodes.push({ peak, low, back: null });
  return episodes.flatMap((episode) => {
    const atPeak = steps[episode.peak] ?? null;
    const peakStepCounts = atPeak !== null && atPeak.step >= medianStep;
    const yardstick = peakStepCounts ? atPeak.step : medianStep;
    const peakBar = bars[episode.peak]!;
    const lowBar = bars[episode.low]!;
    const depth = 1 - lowBar.close / peakBar.close;
    if (!(yardstick > 0) || depth < yardstick) return [];
    const backDate = episode.back === null ? null : bars[episode.back]!.tradingDate;
    return [{
      peakDate: peakBar.tradingDate,
      peakClose: peakBar.close,
      lowDate: lowBar.tradingDate,
      lowClose: lowBar.close,
      backDate,
      depth,
      yardstick,
      yardstickFrom: peakStepCounts ? atPeak.source : "median",
      steps: depth / yardstick,
      daysDown: calendarDaysBetween(peakBar.tradingDate, lowBar.tradingDate),
      daysBack: backDate === null ? null : calendarDaysBetween(lowBar.tradingDate, backDate),
    }];
  });
}

export interface AccountDuringFall {
  fromDate: string;
  toDate: string;
  startValue: number;
  lowestValue: number;
  lowestOn: string;
  /** lowestValue ÷ startValue − 1, ≤ 0. */
  fall: number;
  /** The first day after the lowest that the account is at or above startValue; null when not yet. */
  backOn: string | null;
}

/** F11 for one fall; null when the fall ends before the backtest starts. `days`: the backtest's, ascending. */
export function accountDuringFall(fall: Pick<FallOfAStep, "peakDate" | "backDate">, days: readonly { tradingDate: string; accountValue: number }[]): AccountDuringFall | null {
  if (days.length === 0) return null;
  const backtestFirst = days[0]!.tradingDate;
  const fromDate = fall.peakDate < backtestFirst ? backtestFirst : fall.peakDate;
  const toDate = fall.backDate ?? days.at(-1)!.tradingDate;
  const inside = days.filter((day) => day.tradingDate >= fromDate && day.tradingDate <= toDate);
  if (inside.length === 0) return null;
  const start = inside[0]!;
  const lowest = inside.reduce((best, day) => (day.accountValue < best.accountValue ? day : best), start);
  const back = days.find((day) => day.tradingDate > lowest.tradingDate && day.accountValue >= start.accountValue) ?? null;
  return { fromDate: start.tradingDate, toDate, startValue: start.accountValue, lowestValue: lowest.accountValue, lowestOn: lowest.tradingDate, fall: lowest.accountValue / start.accountValue - 1, backOn: back?.tradingDate ?? null };
}
