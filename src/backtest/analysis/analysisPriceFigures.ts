import { computeYangZhangVolatility, type DailyOhlcvBar } from "../../lib/realizedVolatility.js";
import { isCompleteBar, type StoredDailyBar } from "../engine/backtestBarHistory.js";

// The Analyse window's figures from a symbol's IBKR daily bars (split-adjusted, not adjusted for dividends), the formulas
// approved 2026-10-15 (docs: the Analyse Modal Decisions page): Max drawdown per range, 21- and 63-day Yang-Zhang
// volatility, implied minus what followed (F7), the stock profile (F14 trend, F15 swings, F16 jumps, F17 trending or
// range-bound) and the bar checks (one-day moves over 35%, calendar gaps over 10 days, F18 runs of 5+ identical closes);
// and the Vol Farmer v4 profile's (approved 2026-10-29, carried over 2026-11-01): F12 trend split, F13 market, F14 opening
// gaps, F15 weekly skew, F16 IV range.

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

/** The price chart's indicators for each bar, aligned with the bars they were worked out on (approved 2026-10-26). */
export interface AnalysisBarIndicators {
  /** [share, bars at or below, bars with an IV]: of the last 252 bars (the bar's own included), those with an implied
   *  volatility at or below the bar's ÷ those with one (the Analyse window's IV percentile tile); null for a bar without
   *  an IV or a window under 20 IVs. */
  ivPercentile: ([number, number, number] | null)[];
}

const ivPercentileWindowBars = 252;
const ivPercentileMinimumDays = 20;
const toFourDecimals = (value: number) => Math.round(value * 10_000) / 10_000;

/** Work them out over a symbol's whole history, then cut them to the bars shown, so the first bar shown has its look-back. */
export function barIndicatorsOf(bars: readonly { close: number; impliedVolatility: number | null }[]): AnalysisBarIndicators {
  const ivPercentile = bars.map((bar, index): [number, number, number] | null => {
    if (bar.impliedVolatility === null) return null;
    const window = bars.slice(Math.max(0, index - ivPercentileWindowBars + 1), index + 1).flatMap((entry) => (entry.impliedVolatility === null ? [] : [entry.impliedVolatility]));
    if (window.length < ivPercentileMinimumDays) return null;
    const atOrBelow = window.filter((value) => value <= bar.impliedVolatility!).length;
    return [toFourDecimals(atOrBelow / window.length), atOrBelow, window.length];
  });
  return { ivPercentile };
}

/** The indicators of the bars from `from` to `to` (inclusive), cut from those of every bar. */
export function sliceBarIndicators(indicators: AnalysisBarIndicators, from: number, to: number): AnalysisBarIndicators {
  return { ivPercentile: indicators.ivPercentile.slice(from, to + 1) };
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

/** PERCENTILE.INC: the value at rank (n − 1) × p of the sorted values, interpolated between ranks; null without values. */
export function percentileInclusive(values: readonly number[], share: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * share;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

const mondayKeyOf = (dateIso: string) => {
  const weekday = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) - ((weekday + 6) % 7) * dayMilliseconds).toISOString().slice(0, 10);
};

export interface AnalysisTrendSplit {
  days: number;
  uptrend: number;
  downtrend: number;
  neither: number;
}

const trendAverageBars = 200;
const trendSlopeSessions = 20;

/**
 * F12: each day from the 220th bar is in an uptrend when its close is above its 200-day average and that average above
 * its level 20 sessions earlier, in a downtrend when both are below, else neither.
 */
export function trendSplit(closes: readonly number[]): AnalysisTrendSplit {
  const split: AnalysisTrendSplit = { days: 0, uptrend: 0, downtrend: 0, neither: 0 };
  const prefix = [0];
  for (const close of closes) prefix.push(prefix.at(-1)! + close);
  const averageEndingAt = (index: number) => (prefix[index + 1]! - prefix[index + 1 - trendAverageBars]!) / trendAverageBars;
  for (let index = trendAverageBars + trendSlopeSessions - 1; index < closes.length; index++) {
    const average = averageEndingAt(index);
    const earlier = averageEndingAt(index - trendSlopeSessions);
    split.days += 1;
    if (closes[index]! > average && average > earlier) split.uptrend += 1;
    else if (closes[index]! < average && average < earlier) split.downtrend += 1;
    else split.neither += 1;
  }
  return split;
}

export interface AnalysisMarketFit {
  days: number;
  beta: number | null;
  correlation: number | null;
}

function marketFitOf(pairs: readonly [number, number][]): AnalysisMarketFit {
  if (pairs.length < 2) return { days: pairs.length, beta: null, correlation: null };
  const meanTicker = pairs.reduce((sum, [ticker]) => sum + ticker, 0) / pairs.length;
  const meanMarket = pairs.reduce((sum, [, market]) => sum + market, 0) / pairs.length;
  let covariance = 0;
  let tickerVariance = 0;
  let marketVariance = 0;
  for (const [ticker, market] of pairs) {
    covariance += (ticker - meanTicker) * (market - meanMarket);
    tickerVariance += (ticker - meanTicker) ** 2;
    marketVariance += (market - meanMarket) ** 2;
  }
  return { days: pairs.length, beta: marketVariance === 0 ? null : covariance / marketVariance, correlation: tickerVariance === 0 || marketVariance === 0 ? null : covariance / Math.sqrt(tickerVariance * marketVariance) };
}

const logReturnsByDate = (bars: readonly { tradingDate: string; close: number }[]) => new Map(bars.slice(1).map((bar, index) => [bar.tradingDate, Math.log(bar.close / bars[index]!.close)]));

/**
 * F13: beta and correlation of the ticker's daily log returns on SPY's, on the days both traded: every shared day, those
 * from `sinceDate` (the backtest's first day), and SPY's down and up days only (downside and upside beta).
 */
export function marketFits(ticker: readonly { tradingDate: string; close: number }[], spy: readonly { tradingDate: string; close: number }[], sinceDate: string | null): { all: AnalysisMarketFit; sinceBacktest: AnalysisMarketFit | null; spyDownDays: AnalysisMarketFit; spyUpDays: AnalysisMarketFit } {
  const tickerReturns = logReturnsByDate(ticker);
  const spyReturns = logReturnsByDate(spy);
  const shared = [...tickerReturns.keys()].filter((date) => spyReturns.has(date)).sort().map((date) => ({ date, pair: [tickerReturns.get(date)!, spyReturns.get(date)!] as [number, number] }));
  return {
    all: marketFitOf(shared.map((entry) => entry.pair)),
    sinceBacktest: sinceDate === null ? null : marketFitOf(shared.filter((entry) => entry.date >= sinceDate).map((entry) => entry.pair)),
    spyDownDays: marketFitOf(shared.filter((entry) => entry.pair[1] < 0).map((entry) => entry.pair)),
    spyUpDays: marketFitOf(shared.filter((entry) => entry.pair[1] > 0).map((entry) => entry.pair)),
  };
}

export interface AnalysisOpeningGaps {
  gaps: number;
  up: number;
  down: number;
  /** gaps ÷ the years from the first day a gap could be measured to the last bar. */
  perYear: number | null;
  firstMeasuredOn: string | null;
  /** The largest by |ln(open ÷ previous close)|, as a simple move (e^gap − 1). */
  largest: { date: string; move: number } | null;
}

/** F14: gap = ln(open ÷ the previous close); it counts when |gap| > 2 × the 63-day Yang-Zhang ending the day before ÷ √252. */
export function openingGaps(bars: readonly DailyOhlcvBar[]): AnalysisOpeningGaps {
  const result: AnalysisOpeningGaps = { gaps: 0, up: 0, down: 0, perYear: null, firstMeasuredOn: null, largest: null };
  let largestLog = 0;
  for (let index = 1; index < bars.length; index++) {
    const volatility = computeYangZhangVolatility(bars as DailyOhlcvBar[], 63, index);
    if (!volatility.available) continue;
    result.firstMeasuredOn ??= bars[index]!.tradingDate;
    const gap = Math.log(bars[index]!.open / bars[index - 1]!.close);
    if (!(Math.abs(gap) > (2 * volatility.annualizedVolatility) / Math.sqrt(252))) continue;
    result.gaps += 1;
    if (gap > 0) result.up += 1;
    else result.down += 1;
    if (Math.abs(gap) > Math.abs(largestLog)) {
      largestLog = gap;
      result.largest = { date: bars[index]!.tradingDate, move: Math.exp(gap) - 1 };
    }
  }
  if (result.firstMeasuredOn !== null) {
    const years = daysBetween(result.firstMeasuredOn, bars.at(-1)!.tradingDate) / 365.25;
    result.perYear = years > 0 ? result.gaps / years : null;
  }
  return result;
}

/** F15: the skew (m₃ ÷ m₂^1.5) of the weekly log returns between the last closes of consecutive calendar weeks, and the worst week. */
export function weeklySkew(bars: readonly { tradingDate: string; close: number }[]): { weeks: number; skew: number | null; worstWeek: { endDate: string; move: number } | null } {
  const weekCloses = bars.filter((bar, index) => index === bars.length - 1 || mondayKeyOf(bars[index + 1]!.tradingDate) !== mondayKeyOf(bar.tradingDate));
  const returns = weekCloses.slice(1).map((bar, index) => ({ endDate: bar.tradingDate, value: Math.log(bar.close / weekCloses[index]!.close) }));
  if (returns.length < 3) return { weeks: returns.length, skew: null, worstWeek: null };
  const mean = returns.reduce((sum, entry) => sum + entry.value, 0) / returns.length;
  const secondMoment = returns.reduce((sum, entry) => sum + (entry.value - mean) ** 2, 0) / returns.length;
  const thirdMoment = returns.reduce((sum, entry) => sum + (entry.value - mean) ** 3, 0) / returns.length;
  const worst = returns.reduce((lowest, entry) => (entry.value < lowest.value ? entry : lowest), returns[0]!);
  return { weeks: returns.length, skew: secondMoment === 0 ? null : thirdMoment / secondMoment ** 1.5, worstWeek: { endDate: worst.endDate, move: Math.exp(worst.value) - 1 } };
}

/** F16: the median, 10th and 90th percentile of every daily IV. */
export function impliedVolatilityRange(bars: readonly { tradingDate: string; impliedVolatility: number | null }[]): { days: number; firstDate: string | null; median: number | null; tenth: number | null; ninetieth: number | null } {
  const withIv = bars.filter((bar) => bar.impliedVolatility !== null && bar.impliedVolatility > 0);
  const values = withIv.map((bar) => bar.impliedVolatility!);
  return { days: values.length, firstDate: withIv[0]?.tradingDate ?? null, median: percentileInclusive(values, 0.5), tenth: percentileInclusive(values, 0.1), ninetieth: percentileInclusive(values, 0.9) };
}
