import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";

// The realized-volatility forecast the valuation model and the Volatility screen's FV columns use.

/** The forecast's own year: Yang-Zhang gives variance per trading session (realizedVolatility.ts annualizes × 252). */
export const tradingSessionsPerYear = 252;

/** The valuation model's forecast (model review P3, approved by Marcelo 2026-10-10): Yang-Zhang over the last 21 sessions. */
export const modelForecastWindowDays = 21;
/** The Volatility screen's FV 63d (Marcelo 2026-10-20, display only): Yang-Zhang over the last 63 sessions, no fallback. */
export const longForecastWindowDays = 63;

export interface ModelVolatilityForecast {
  /** Variance per trading session (what the variance clock multiplies). */
  perSessionVariance: number;
  /** √(252 × per-session variance): the same forecast annualized on sessions. */
  annualizedVolatility: number;
  /** modelForecastWindowDays live; a backtest session may use another window (30 for IBKR's 30-day implied volatility). */
  windowDays: number;
}

/** What the retired rules backtests forecast with, kept for their stored settings. */
export type ModelForecastMethod = "yang_zhang_21" | "yang_zhang_21_without_earnings" | "implied_volatility_30_day";

/** `bars` in date order, ending before the scoring day (never a partial session). Null without windowDays + 1 valid bars. */
export function selectModelVolatilityForecast(bars: DailyOhlcvBar[], windowDays: number = modelForecastWindowDays): ModelVolatilityForecast | null {
  const result = computeYangZhangVolatility(bars, windowDays);
  if (!result.available || !Number.isFinite(result.annualizedVolatility) || !(result.annualizedVolatility > 0)) return null;
  return { perSessionVariance: result.annualizedVolatility ** 2 / tradingSessionsPerYear, annualizedVolatility: result.annualizedVolatility, windowDays };
}
