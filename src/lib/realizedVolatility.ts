// Yang-Zhang realized volatility from daily OHLCV bars (IORIO Signal Engine,
// Phase 0). Formula approved as written 2026-09-21 (artifact Formula 3a):
//
//   σ²_YZ = σ²_o + k·σ²_c + (1 − k)·σ²_RS
//
//   σ²_o   sample variance (n−1) of overnight returns   o_i = ln(O_i / C_{i−1})
//   σ²_c   sample variance (n−1) of open-to-close returns c_i = ln(C_i / O_i)
//   σ²_RS  window MEAN of Rogers-Satchell terms
//          ln(H/C)·ln(H/O) + ln(L/C)·ln(L/O)
//   k      0.34 / (1.34 + (n + 1)/(n − 1))   for a window of n trading days
//
//   annualized volatility = √(252 · σ²_YZ)
//
// Windows: 10, 21, 63 and 126 trading days. Overnight returns span weekends
// and holidays unscaled (Yang & Zhang's own treatment), and earnings gaps stay
// IN — they are real risk; a later phase can compute an ex-earnings variant.
//
// Yang & Zhang (2000) is drift-independent and handles opening jumps, which is
// why it is used rather than close-to-close (ignores overnight gaps) or
// Parkinson/Garman-Klass (assume no gaps / zero drift).
//
// SPLIT GUARD — the stored bars are NOT split-adjusted (see priceBarCache.ts),
// so a split would read as a huge overnight "move" and wreck the estimate. A
// window returns "unavailable / suspected_split" — never a wrong number — if
// any of its overnight moves is:
//   (a) beyond ±70% (simple return), on its own; or
//   (b) within ±15% (relative) of a common split ratio — 1/m for a forward
//       split or m for a reverse split, m in {2, 3, 4, 5, 10, 20} — AND the
//       bar's volume confirms it (forward: volume ≥ 0.5·m × the prior-20-bar
//       median; reverse: volume ≤ (2/m) × that median).
// Rule (b) exists because rule (a) alone misses 2-for-1 (−50%) and 3-for-1
// (−67%) splits. A real −50% crash on doubled volume looks identical to a
// 2-for-1 split and is excluded too: that errs toward "insufficient clean
// history", the safe direction. With fewer than 5 prior bars the volume can't
// be checked, so a ratio-match is conservatively treated as a suspected split.
//
// Bars must be in ascending date order.

export interface DailyOhlcvBar {
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const yangZhangWindowDays = [10, 21, 63, 126] as const;
export type YangZhangWindowDays = (typeof yangZhangWindowDays)[number];

const tradingDaysPerYear = 252;
const yangZhangWeightConstant = 0.34;

const suspectedSplitSimpleReturnThreshold = 0.7;
const splitRatioRelativeTolerance = 0.15;
const commonSplitFactors = [2, 3, 4, 5, 10, 20] as const;
const forwardSplitMinimumVolumeFraction = 0.5;
const reverseSplitVolumeCeilingNumerator = 2;
const volumeMedianLookbackBars = 20;
const minimumPriorBarsToConfirmVolume = 5;

export type YangZhangUnavailableReason = "insufficient_history" | "suspected_split" | "invalid_bar";

export interface YangZhangComponents {
  overnightVariance: number;
  openToCloseVariance: number;
  rogersSatchellVariance: number;
  weightK: number;
  combinedDailyVariance: number;
}

export type YangZhangResult =
  | { available: true; windowDays: number; annualizedVolatility: number; components: YangZhangComponents }
  | { available: false; windowDays: number; reason: YangZhangUnavailableReason; detail: string; /** Trading date of the flagged overnight move; only with reason "suspected_split". */ splitDateIso?: string };

function isValidBar(bar: DailyOhlcvBar): boolean {
  const { open, high, low, close, volume } = bar;
  if (![open, high, low, close].every((price) => Number.isFinite(price) && price > 0)) return false;
  if (!Number.isFinite(volume) || volume < 0) return false;
  return high >= Math.max(open, close) && low <= Math.min(open, close) && high >= low;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function sampleVariance(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

/** True when the overnight move into bars[index] looks like a stock split (rules (a)/(b) in the file header). */
function isSuspectedSplitAt(bars: DailyOhlcvBar[], index: number): boolean {
  const previousClose = bars[index - 1]!.close;
  const bar = bars[index]!;
  const overnightRatio = bar.open / previousClose;

  if (Math.abs(overnightRatio - 1) > suspectedSplitSimpleReturnThreshold) return true;

  const matchingForwardFactors = commonSplitFactors.filter((factor) => Math.abs(overnightRatio * factor - 1) <= splitRatioRelativeTolerance);
  const matchingReverseFactors = commonSplitFactors.filter((factor) => Math.abs(overnightRatio / factor - 1) <= splitRatioRelativeTolerance);
  if (matchingForwardFactors.length === 0 && matchingReverseFactors.length === 0) return false;

  const priorVolumes = bars.slice(Math.max(0, index - volumeMedianLookbackBars), index).map((priorBar) => priorBar.volume);
  if (priorVolumes.length < minimumPriorBarsToConfirmVolume) return true;
  const medianPriorVolume = medianOf(priorVolumes);

  const forwardConfirmed = matchingForwardFactors.some((factor) => bar.volume >= forwardSplitMinimumVolumeFraction * factor * medianPriorVolume);
  const reverseConfirmed = matchingReverseFactors.some((factor) => bar.volume <= (reverseSplitVolumeCeilingNumerator / factor) * medianPriorVolume);
  return forwardConfirmed || reverseConfirmed;
}

/** Indices (into `bars`) of every bar whose overnight move is a suspected split. Index 0 has no prior close and is never flagged. */
export function findSuspectedSplitBarIndices(bars: DailyOhlcvBar[]): number[] {
  const suspectedIndices: number[] = [];
  for (let index = 1; index < bars.length; index++) {
    if (isSuspectedSplitAt(bars, index)) suspectedIndices.push(index);
  }
  return suspectedIndices;
}

/**
 * Yang-Zhang annualized volatility over the LAST `windowDays` trading days of
 * `bars` (which therefore needs windowDays + 1 bars — the first overnight
 * return needs the prior close). Never throws for bad data; returns
 * `available: false` with a reason instead.
 */
export function computeYangZhangVolatility(bars: DailyOhlcvBar[], windowDays: number): YangZhangResult {
  if (!Number.isInteger(windowDays) || windowDays < 2) throw new RangeError(`windowDays must be an integer >= 2, got ${windowDays}`);

  if (bars.length < windowDays + 1) {
    return { available: false, windowDays, reason: "insufficient_history", detail: `${bars.length} bars, need ${windowDays + 1}` };
  }

  const firstWindowIndex = bars.length - windowDays;
  for (let index = firstWindowIndex - 1; index < bars.length; index++) {
    if (!isValidBar(bars[index]!)) {
      return { available: false, windowDays, reason: "invalid_bar", detail: `invalid OHLCV bar on ${bars[index]!.tradingDate}` };
    }
  }
  for (let index = firstWindowIndex; index < bars.length; index++) {
    if (isSuspectedSplitAt(bars, index)) {
      return { available: false, windowDays, reason: "suspected_split", detail: `suspected split on ${bars[index]!.tradingDate}`, splitDateIso: bars[index]!.tradingDate };
    }
  }

  const overnightReturns: number[] = [];
  const openToCloseReturns: number[] = [];
  let rogersSatchellSum = 0;
  for (let index = firstWindowIndex; index < bars.length; index++) {
    const { open, high, low, close } = bars[index]!;
    overnightReturns.push(Math.log(open / bars[index - 1]!.close));
    openToCloseReturns.push(Math.log(close / open));
    rogersSatchellSum += Math.log(high / close) * Math.log(high / open) + Math.log(low / close) * Math.log(low / open);
  }

  const overnightVariance = sampleVariance(overnightReturns);
  const openToCloseVariance = sampleVariance(openToCloseReturns);
  const rogersSatchellVariance = rogersSatchellSum / windowDays;
  const weightK = yangZhangWeightConstant / (1.34 + (windowDays + 1) / (windowDays - 1));
  const combinedDailyVariance = overnightVariance + weightK * openToCloseVariance + (1 - weightK) * rogersSatchellVariance;

  return {
    available: true,
    windowDays,
    annualizedVolatility: Math.sqrt(tradingDaysPerYear * combinedDailyVariance),
    components: { overnightVariance, openToCloseVariance, rogersSatchellVariance, weightK, combinedDailyVariance },
  };
}

/** The four approved windows (10/21/63/126 trading days) in one call. */
export function computeYangZhangVolatilityAllWindows(bars: DailyOhlcvBar[]): Record<YangZhangWindowDays, YangZhangResult> {
  return {
    10: computeYangZhangVolatility(bars, 10),
    21: computeYangZhangVolatility(bars, 21),
    63: computeYangZhangVolatility(bars, 63),
    126: computeYangZhangVolatility(bars, 126),
  };
}
