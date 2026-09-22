import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";
import { sviTotalVariance, type RawSviParameters, type SviSliceStatus } from "./impliedVolatilitySurface.js";

// Volatility edge for the IORIO Signal Engine (Formula 3, approved 2026-09-22):
//
//   Edge(K,T) = IV_SVI(K,T) − RV_forecast          IV_SVI = √(w(k) / T)
//   RV_forecast = trailing 63-day Yang-Zhang volatility (the same number for every
//                 strike and expiry of a ticker); if unavailable, the 21-day one;
//                 if that too, no forecast and therefore no Edge.
//
// Evidence (back-test on AAOI, SMCI, TLT, HOOD, PLTR, COIN, 5 years, horizons of
// 10/21/42/63 trading days; see PROGRESS.md): the 63-day window was the best or
// within noise of the best forecaster of the next realized volatility at every
// horizon; matching the window to the option's expiry did not help. Expiries that
// span an earnings date are FLAGGED, never adjusted: their IV carries an event
// premium, so a high Edge there is not the same thing as a rich premium.

export const primaryForecastWindowDays = 63;
export const fallbackForecastWindowDays = 21;

export interface RealizedVolatilityForecast {
  /** Annualized, as a decimal (0.45 = 45%). */
  volatility: number;
  windowDays: typeof primaryForecastWindowDays | typeof fallbackForecastWindowDays;
}

/** `bars` must be in date order and end at (not after) the snapshot date, so the forecast never sees the future. */
export function selectRealizedVolatilityForecast(bars: DailyOhlcvBar[]): RealizedVolatilityForecast | null {
  for (const windowDays of [primaryForecastWindowDays, fallbackForecastWindowDays] as const) {
    const result = computeYangZhangVolatility(bars, windowDays);
    if (result.available && Number.isFinite(result.annualizedVolatility) && result.annualizedVolatility > 0) return { volatility: result.annualizedVolatility, windowDays };
  }
  return null;
}

export interface EdgeSlice {
  status: SviSliceStatus;
  parameters: RawSviParameters | null;
  kMin: number | null;
  kMax: number | null;
  yearsToExpiry: number;
  forwardPrice: number;
}

export interface VolatilityEdge {
  /** SVI-fitted implied volatility at the strike, annualized decimal. */
  impliedVolatility: number;
  forecastVolatility: number;
  forecastWindowDays: number;
  /** impliedVolatility − forecastVolatility, in annualized volatility (0.05 = 5 volatility points). */
  edge: number;
  /** False when the strike lies outside the log-moneyness range the slice was fitted on (SVI wings are an extrapolation there). */
  insideFittedRange: boolean;
}

/** Null (unscored) unless the slice is 'ok' and a forecast exists; flagged slices are never used silently. */
export function computeVolatilityEdge(slice: EdgeSlice, strike: number, forecast: RealizedVolatilityForecast | null): VolatilityEdge | null {
  if (forecast === null || slice.status !== "ok" || slice.parameters === null || slice.kMin === null || slice.kMax === null) return null;
  if (!(strike > 0) || !(slice.forwardPrice > 0) || !(slice.yearsToExpiry > 0)) return null;
  const logMoneyness = Math.log(strike / slice.forwardPrice);
  const totalVariance = sviTotalVariance(slice.parameters, logMoneyness);
  if (!(totalVariance > 0)) return null;
  const impliedVolatility = Math.sqrt(totalVariance / slice.yearsToExpiry);
  return {
    impliedVolatility,
    forecastVolatility: forecast.volatility,
    forecastWindowDays: forecast.windowDays,
    edge: impliedVolatility - forecast.volatility,
    insideFittedRange: logMoneyness >= slice.kMin && logMoneyness <= slice.kMax,
  };
}

/** True when an earnings date falls after the snapshot date and on or before the expiry (ISO dates YYYY-MM-DD compare correctly as text). */
export function expirySpansEarnings(snapshotDateIso: string, expiryIso: string, earningsDatesIso: string[]): boolean {
  return earningsDatesIso.some((earningsDate) => earningsDate > snapshotDateIso && earningsDate <= expiryIso);
}
