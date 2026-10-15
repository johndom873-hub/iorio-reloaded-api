import { computeYangZhangVolatility, type DailyOhlcvBar } from "../../lib/realizedVolatility.js";
import { isCompleteBar, type StoredDailyBar } from "../engine/backtestBarHistory.js";

// The Analyse window's figures from a symbol's IBKR daily bars (split-adjusted, not adjusted for dividends), the formulas
// approved 2026-10-15 (docs: the Analyse Modal Decisions page): Max drawdown per range, 21- and 63-day Yang-Zhang
// volatility, implied minus what followed (F7), the stock profile (F14 trend, F15 swings, F16 jumps, F17 trending or
// range-bound) and the bar checks (one-day moves over 35%, calendar gaps over 10 days, F18 runs of 5+ identical closes).

const dayMilliseconds = 86_400_000;
const daysBetween = (fromIso: string, toIso: string) => (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / dayMilliseconds;
const yearsBefore = (dateIso: string, years: number) => `${Number(dateIso.slice(0, 4)) - years}${dateIso.slice(4)}`;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sampleVariance(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

/** The bars Yang-Zhang can read: complete OHLC, a missing volume taken as 0. */
export function toOhlcvBars(bars: readonly StoredDailyBar[]): (DailyOhlcvBar & { impliedVolatility: number | null })[] {
  return bars.filter(isCompleteBar).map((bar) => ({ tradingDate: bar.tradingDate, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume ?? 0, impliedVolatility: bar.impliedVolatility }));
}

export interface AnalysisMaxDrawdown {
  /** A positive fraction (0.902 = −90.2%). */
  depth: number;
  peakDate: string;
  peak: number;
  troughDate: string;
  trough: number;
  /** The first close back at or above the peak, from all the bars; null when not yet. */
  recoveredOn: string | null;
}

/** Max drawdown = max over days of (1 − close ÷ the highest close before it), within the bars given. */
export function maxDrawdownOf(bars: readonly { tradingDate: string; close: number }[], allBars: readonly { tradingDate: string; close: number }[] = bars): AnalysisMaxDrawdown | null {
  if (bars.length < 2) return null;
  let peakIndex = 0;
  let best = { depth: 0, peakIndex: 0, troughIndex: 0 };
  bars.forEach((bar, index) => {
    if (bar.close > bars[peakIndex]!.close) peakIndex = index;
    const depth = 1 - bar.close / bars[peakIndex]!.close;
    if (depth > best.depth) best = { depth, peakIndex, troughIndex: index };
  });
  const peak = bars[best.peakIndex]!;
  const trough = bars[best.troughIndex]!;
  const recovered = allBars.find((bar) => bar.tradingDate > trough.tradingDate && bar.close >= peak.close) ?? null;
  return { depth: best.depth, peakDate: peak.tradingDate, peak: peak.close, troughDate: trough.tradingDate, trough: trough.close, recoveredOn: recovered?.tradingDate ?? null };
}

export const analysisPriceRanges = [
  { key: "All", years: null },
  { key: "10Y", years: 10 },
  { key: "5Y", years: 5 },
  { key: "2Y", years: 2 },
  { key: "1Y", years: 1 },
] as const;
export type AnalysisPriceRange = (typeof analysisPriceRanges)[number]["key"];

/** Max drawdown of each range: the bars after the last bar's date less N years (All: every bar). */
export function maxDrawdownByRange(bars: readonly { tradingDate: string; close: number }[]): Record<AnalysisPriceRange, AnalysisMaxDrawdown | null> {
  const last = bars.at(-1)?.tradingDate ?? "";
  return Object.fromEntries(analysisPriceRanges.map(({ key, years }) => [key, maxDrawdownOf(years === null ? bars : bars.filter((bar) => bar.tradingDate > yearsBefore(last, years)), bars)])) as Record<AnalysisPriceRange, AnalysisMaxDrawdown | null>;
}

/** 21- and 63-day Yang-Zhang volatility ending at each bar (null until the window fills). */
export function yangZhangSeries(bars: readonly DailyOhlcvBar[], windowDays: number): (number | null)[] {
  return bars.map((_, index) => {
    const result = computeYangZhangVolatility(bars as DailyOhlcvBar[], windowDays, index + 1);
    return result.available ? result.annualizedVolatility : null;
  });
}

export interface AnalysisIvPremiumStats {
  days: number;
  medianPremium: number | null;
  shareAbove: number | null;
  medianImplied: number | null;
  medianForwardRealised: number | null;
}

/**
 * F7: premium on day t = IBKR's implied volatility on t − the 21-day Yang-Zhang volatility of the 21 sessions after t.
 * Stats over all days, the last year (days after the last bar's date less a year) and each calendar year.
 */
export function impliedVersusRealised(bars: (DailyOhlcvBar & { impliedVolatility: number | null })[]): { all: AnalysisIvPremiumStats; lastYear: AnalysisIvPremiumStats; byYear: Record<string, AnalysisIvPremiumStats> } {
  const points: { date: string; implied: number; forward: number }[] = [];
  for (let index = 0; index + 21 < bars.length; index++) {
    const implied = bars[index]!.impliedVolatility;
    if (implied === null || !(implied > 0)) continue;
    const forward = computeYangZhangVolatility(bars as DailyOhlcvBar[], 21, index + 22);
    if (!forward.available) continue;
    points.push({ date: bars[index]!.tradingDate, implied, forward: forward.annualizedVolatility });
  }
  const stats = (subset: typeof points): AnalysisIvPremiumStats => ({
    days: subset.length,
    medianPremium: median(subset.map((point) => point.implied - point.forward)),
    shareAbove: subset.length === 0 ? null : subset.filter((point) => point.implied > point.forward).length / subset.length,
    medianImplied: median(subset.map((point) => point.implied)),
    medianForwardRealised: median(subset.map((point) => point.forward)),
  });
  const lastDate = bars.at(-1)?.tradingDate ?? "";
  const byYear: Record<string, AnalysisIvPremiumStats> = {};
  for (const year of new Set(points.map((point) => point.date.slice(0, 4)))) byYear[year] = stats(points.filter((point) => point.date.startsWith(year)));
  return { all: stats(points), lastYear: stats(points.filter((point) => point.date > yearsBefore(lastDate, 1))), byYear };
}

export interface AnalysisProfile {
  from: string;
  to: string;
  closes: number;
  /** F14: (last ÷ first close)^(365 ÷ calendar days) − 1. */
  cagr: number;
  /** F14: R² of a straight line through ln(close) on the session number. */
  r2: number;
  /** F15: zigzag at 20%. */
  swings: number;
  swingsPerYear: number;
  medianSwing: number | null;
  /** F16: |ln return| above 3 × the 63-day Yang-Zhang daily volatility ending the day before. */
  jumps: number;
  jumpsPerYear: number;
  /** The largest jump: its simple move (e^ln − 1) and its log move. */
  largestJump: { date: string; move: number; logMove: number } | null;
  /** Jumps on a report's two sessions (the report day and the session after). */
  jumpsOnReports: number;
  /** F17: variance ratio of 21-session returns, its standard error and the label. */
  varianceRatio: number | null;
  standardError: number | null;
  label: "trending" | "range-bound" | "neither" | null;
}

/** F15: the completed swings of a zigzag at `threshold`: each leg from a turning point reaches ≥ threshold and is reversed by ≥ threshold. */
export function zigzagSwings(closes: readonly number[], threshold = 0.2): number[] {
  if (closes.length < 2) return [];
  const swings: number[] = [];
  let pivot = closes[0]!;
  let direction: 0 | 1 | -1 = 0;
  let extreme = pivot;
  let high = pivot;
  let low = pivot;
  for (const close of closes.slice(1)) {
    if (direction === 0) {
      high = Math.max(high, close);
      low = Math.min(low, close);
      if (high >= pivot * (1 + threshold)) [direction, extreme] = [1, high];
      else if (low <= pivot * (1 - threshold)) [direction, extreme] = [-1, low];
      continue;
    }
    if (direction === 1) {
      if (close > extreme) extreme = close;
      else if (close <= extreme * (1 - threshold)) {
        swings.push(extreme / pivot - 1);
        [pivot, extreme, direction] = [extreme, close, -1];
      }
    } else {
      if (close < extreme) extreme = close;
      else if (close >= extreme * (1 + threshold)) {
        swings.push(1 - extreme / pivot);
        [pivot, extreme, direction] = [extreme, close, 1];
      }
    }
  }
  return swings;
}

/**
 * F14–F17 over the bars from `fromDate` (all when null); the jumps' 63-day volatility reads the bars before the window too.
 * `reportSessionDates`: the report day and the next session of each report.
 */
export function stockProfile(allBars: DailyOhlcvBar[], fromDate: string | null = null, reportSessionDates: ReadonlySet<string> = new Set()): AnalysisProfile | null {
  const offset = fromDate === null ? 0 : allBars.findIndex((bar) => bar.tradingDate > fromDate);
  if (offset < 0) return null;
  const bars = allBars.slice(offset);
  if (bars.length < 30) return null;
  const first = bars[0]!;
  const last = bars.at(-1)!;
  const years = daysBetween(first.tradingDate, last.tradingDate) / 365.25;
  const cagr = (last.close / first.close) ** (365 / daysBetween(first.tradingDate, last.tradingDate)) - 1;
  const logs = bars.map((bar) => Math.log(bar.close));
  const meanX = (logs.length - 1) / 2;
  const meanY = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  logs.forEach((y, x) => {
    sxy += (x - meanX) * (y - meanY);
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
  });
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  const swings = zigzagSwings(bars.map((bar) => bar.close));
  const returns = logs.slice(1).map((value, index) => value - logs[index]!);
  const jumps: { date: string; move: number }[] = [];
  for (let index = 1; index < bars.length; index++) {
    const volatility = computeYangZhangVolatility(allBars, 63, offset + index);
    if (!volatility.available) continue;
    const move = returns[index - 1]!;
    if (Math.abs(move) > (3 * volatility.annualizedVolatility) / Math.sqrt(252)) jumps.push({ date: bars[index]!.tradingDate, move });
  }
  const largestJump = jumps.reduce<{ date: string; move: number } | null>((best, jump) => (best === null || Math.abs(jump.move) > Math.abs(best.move) ? jump : best), null);
  const q = 21;
  let varianceRatio: number | null = null;
  let standardError: number | null = null;
  if (returns.length > q * 3) {
    const longReturns = logs.slice(q).map((value, index) => value - logs[index]!);
    varianceRatio = sampleVariance(longReturns) / (q * sampleVariance(returns));
    standardError = Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * returns.length));
  }
  const label = varianceRatio === null || standardError === null ? null : varianceRatio > 1 + 2 * standardError ? "trending" : varianceRatio < 1 - 2 * standardError ? "range-bound" : "neither";
  return {
    from: first.tradingDate,
    to: last.tradingDate,
    closes: bars.length,
    cagr,
    r2,
    swings: swings.length,
    swingsPerYear: swings.length / years,
    medianSwing: median(swings),
    jumps: jumps.length,
    jumpsPerYear: jumps.length / years,
    largestJump: largestJump && { date: largestJump.date, move: Math.exp(largestJump.move) - 1, logMove: largestJump.move },
    jumpsOnReports: jumps.filter((jump) => reportSessionDates.has(jump.date)).length,
    varianceRatio,
    standardError,
    label,
  };
}

export interface AnalysisBarChecks {
  /** One-day close-to-close moves over 35%: [date, move]. */
  bigMoves: [string, number][];
  /** Calendar gaps over 10 days between bars: [from, to]. */
  gaps: [string, string][];
  /** F18: runs of 5 or more identical closes: [from, to, length]. */
  flatRuns: [string, string, number][];
}

export function barChecks(bars: readonly { tradingDate: string; close: number }[]): AnalysisBarChecks {
  const bigMoves: [string, number][] = [];
  const gaps: [string, string][] = [];
  const flatRuns: [string, string, number][] = [];
  let runStart = 0;
  for (let index = 1; index <= bars.length; index++) {
    const bar = bars[index];
    const previous = bars[index - 1]!;
    if (bar) {
      const move = bar.close / previous.close - 1;
      if (Math.abs(move) > 0.35) bigMoves.push([bar.tradingDate, move]);
      if (daysBetween(previous.tradingDate, bar.tradingDate) > 10) gaps.push([previous.tradingDate, bar.tradingDate]);
    }
    if (!bar || bar.close !== previous.close) {
      const length = index - runStart;
      if (length >= 5) flatRuns.push([bars[runStart]!.tradingDate, previous.tradingDate, length]);
      runStart = index;
    }
  }
  return { bigMoves, gaps, flatRuns };
}
