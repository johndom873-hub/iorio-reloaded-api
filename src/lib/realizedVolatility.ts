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
// Splits: stored bars are kept on IBKR's split-adjusted basis when they are written
// (dailyBarSplitCheck.ts), so every overnight move here is a real one and counts.
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

export type YangZhangUnavailableReason = "insufficient_history" | "invalid_bar";

export interface YangZhangComponents {
  overnightVariance: number;
  openToCloseVariance: number;
  rogersSatchellVariance: number;
  weightK: number;
  combinedDailyVariance: number;
}

export type YangZhangResult =
  | { available: true; windowDays: number; annualizedVolatility: number; components: YangZhangComponents }
  | { available: false; windowDays: number; reason: YangZhangUnavailableReason; detail: string };

function isValidBar(bar: DailyOhlcvBar): boolean {
  const { open, high, low, close, volume } = bar;
  if (![open, high, low, close].every((price) => Number.isFinite(price) && price > 0)) return false;
  if (!Number.isFinite(volume) || volume < 0) return false;
  return high >= Math.max(open, close) && low <= Math.min(open, close) && high >= low;
}

function sampleVariance(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

/**
 * Yang-Zhang annualized volatility over the LAST `windowDays` trading days of
 * `bars` (which therefore needs windowDays + 1 bars — the first overnight
 * return needs the prior close). `endIndex` (exclusive, default all bars)
 * ends the window earlier without copying the array: the result is exactly
 * that of `bars.slice(0, endIndex)`. Never throws for bad data; returns
 * `available: false` with a reason instead.
 */
export function computeYangZhangVolatility(bars: DailyOhlcvBar[], windowDays: number, endIndex: number = bars.length): YangZhangResult {
  if (!Number.isInteger(windowDays) || windowDays < 2) throw new RangeError(`windowDays must be an integer >= 2, got ${windowDays}`);

  if (endIndex < windowDays + 1) {
    return { available: false, windowDays, reason: "insufficient_history", detail: `${endIndex} bars, need ${windowDays + 1}` };
  }

  const firstWindowIndex = endIndex - windowDays;
  for (let index = firstWindowIndex - 1; index < endIndex; index++) {
    if (!isValidBar(bars[index]!)) {
      return { available: false, windowDays, reason: "invalid_bar", detail: `invalid OHLCV bar on ${bars[index]!.tradingDate}` };
    }
  }

  const overnightReturns: number[] = [];
  const openToCloseReturns: number[] = [];
  let rogersSatchellSum = 0;
  for (let index = firstWindowIndex; index < endIndex; index++) {
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
