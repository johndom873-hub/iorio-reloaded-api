import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";
import { sviTotalVariance, type RawSviParameters, type SviSliceStatus } from "./impliedVolatilitySurface.js";

// Directional-tilt measures for the IORIO Signal Engine (approved 2026-09-22): THREE
// SEPARATE display measures, no blend and no weights (nothing here can be validated
// yet: momentum needs hundreds of stocks, skew needs months of chains). Never used to
// amplify anything or to change the rank.
//
//   Momentum   M = ln(P[t−21] / P[t−252])      12-1 month log return, closes up to the snapshot date
//   Skew       S = IV_SVI(k = −0.5·√w(0)) − IV_SVI(k = 0)
//                 from the 'ok' slice closest to 30 days (at least 14); a steeper smirk has
//                 historically predicted weaker returns (Xing, Zhang & Zhao 2010)
//   Elevated-volatility flag   YZ21 / YZ126 ≥ the ticker's OWN 90th percentile of that ratio
//                 over its earlier history (Marcelo's choice); a new ticker with fewer than 250
//                 earlier observations uses a fixed 1.3 until it has them.
//
// Evidence for the flag (15 tickers, 5 years, no lookahead): the own-90th-percentile rule
// separated the next 21 days' volatility best (flagged 1.11 vs 1.01 times the trailing
// 126-day level, gap 0.10) against fixed 1.3 (gap 0.06) and fixed 1.5 (gap 0.01, flags only 4% of days).

export const momentumSkipDays = 21;
export const momentumLookbackDays = 252;
export const elevatedVolatilityQuantile = 0.9;
export const minimumHistoryForOwnThreshold = 250;
export const fixedFallbackThreshold = 1.3;
export const skewTargetDaysToExpiry = 30;
export const skewMinimumDaysToExpiry = 14;
export const skewPutDistanceInStandardDeviations = 0.5;

/** Closes must be in date order and end at (not after) the snapshot date. Null with fewer than 253 closes. */
export function computeMomentum(closes: number[]): number | null {
  if (closes.length < momentumLookbackDays + 1) return null;
  const recent = closes[closes.length - 1 - momentumSkipDays]!;
  const old = closes[closes.length - 1 - momentumLookbackDays]!;
  if (!(recent > 0) || !(old > 0)) return null;
  return Math.log(recent / old);
}

export interface SkewSlice {
  status: SviSliceStatus;
  parameters: RawSviParameters | null;
  kMin: number | null;
  kMax: number | null;
  yearsToExpiry: number;
}

export interface SkewMeasure {
  /** IV at the −0.5 standard-deviation put point minus ATM IV, as annualized volatility (0.05 = 5 volatility points). */
  skew: number;
  daysToExpiry: number;
}

/** The 'ok' slice with at least 14 days left that is closest to 30 days; null if none, or if the put point lies outside its fitted range. */
export function computeSkew(slices: SkewSlice[]): SkewMeasure | null {
  const candidates = slices
    .filter((slice) => slice.status === "ok" && slice.parameters !== null && slice.kMin !== null && slice.kMax !== null && slice.yearsToExpiry * 365 >= skewMinimumDaysToExpiry)
    .sort((first, second) => Math.abs(first.yearsToExpiry * 365 - skewTargetDaysToExpiry) - Math.abs(second.yearsToExpiry * 365 - skewTargetDaysToExpiry));
  const chosen = candidates[0];
  if (!chosen || !chosen.parameters) return null;
  const totalVarianceAtTheMoney = sviTotalVariance(chosen.parameters, 0);
  if (!(totalVarianceAtTheMoney > 0)) return null;
  const putLogMoneyness = -skewPutDistanceInStandardDeviations * Math.sqrt(totalVarianceAtTheMoney);
  if (putLogMoneyness < chosen.kMin! || putLogMoneyness > chosen.kMax!) return null;
  const putTotalVariance = sviTotalVariance(chosen.parameters, putLogMoneyness);
  if (!(putTotalVariance > 0)) return null;
  const years = chosen.yearsToExpiry;
  return { skew: Math.sqrt(putTotalVariance / years) - Math.sqrt(totalVarianceAtTheMoney / years), daysToExpiry: years * 365 };
}

const shortWindowDays = 21;
const longWindowDays = 126;

/** YZ21 / YZ126 at the end of `bars`, or null when either window is unavailable. */
export function volatilityRatio(bars: DailyOhlcvBar[]): number | null {
  const short = computeYangZhangVolatility(bars, shortWindowDays);
  const long = computeYangZhangVolatility(bars, longWindowDays);
  if (!short.available || !long.available || !(long.annualizedVolatility > 0)) return null;
  return short.annualizedVolatility / long.annualizedVolatility;
}

function quantile(values: number[], probability: number): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(probability * sorted.length)]!;
}

export interface ElevatedVolatilityFlag {
  ratio: number;
  threshold: number;
  thresholdSource: "own_p90" | "fixed_fallback";
  elevated: boolean;
}

/** `bars` in date order ending at the snapshot date. Only ratios observed BEFORE the last bar feed the threshold, so it never sees the present. */
export function computeElevatedVolatilityFlag(bars: DailyOhlcvBar[]): ElevatedVolatilityFlag | null {
  const ratio = volatilityRatio(bars);
  if (ratio === null) return null;
  const earlierRatios: number[] = [];
  for (let end = longWindowDays; end < bars.length - 1; end++) {
    const earlier = volatilityRatio(bars.slice(0, end + 1));
    if (earlier !== null) earlierRatios.push(earlier);
  }
  const useOwn = earlierRatios.length >= minimumHistoryForOwnThreshold;
  const threshold = useOwn ? quantile(earlierRatios, elevatedVolatilityQuantile) : fixedFallbackThreshold;
  return { ratio, threshold, thresholdSource: useOwn ? "own_p90" : "fixed_fallback", elevated: ratio >= threshold };
}
