import { easternInstant } from "./easternIsoDate.js";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";

// Realized-volatility forecasts and the calendar checks the Signal Engine scores with.

/** The forecast's own year: Yang-Zhang gives variance per trading session (realizedVolatility.ts annualizes × 252). */
export const tradingSessionsPerYear = 252;

/** The valuation model's forecast (model review P3, approved by Marcelo 2026-10-10): Yang-Zhang over the last 21 sessions. */
export const modelForecastWindowDays = 21;
/** The Signals screen's FV 63d (Marcelo 2026-10-20, display only): Yang-Zhang over the last 63 sessions, no fallback. */
export const longForecastWindowDays = 63;

export interface ModelVolatilityForecast {
  /** Variance per trading session (what the variance clock multiplies). */
  perSessionVariance: number;
  /** √(252 × per-session variance): the same forecast annualized on sessions. */
  annualizedVolatility: number;
  /** modelForecastWindowDays live; a backtest session may use another window. */
  windowDays: number;
}

/** `bars` in date order, ending before the scoring day (never a partial session). Null without windowDays + 1 valid bars. */
export function selectModelVolatilityForecast(bars: DailyOhlcvBar[], windowDays: number = modelForecastWindowDays): ModelVolatilityForecast | null {
  const result = computeYangZhangVolatility(bars, windowDays);
  if (!result.available || !Number.isFinite(result.annualizedVolatility) || !(result.annualizedVolatility > 0)) return null;
  return { perSessionVariance: result.annualizedVolatility ** 2 / tradingSessionsPerYear, annualizedVolatility: result.annualizedVolatility, windowDays };
}

/**
 * Earnings from today through the expiry (hard exclusion in Signals; ISO dates YYYY-MM-DD compare correctly as text).
 * Today counts: a report after today's close, or at an unknown time, is still ahead. A report before today's open has
 * already happened, and loadEarningsDatesNotYetReported leaves it out.
 */
export function expirySpansEarnings(todayIso: string, expiryIso: string, earningsDatesIso: string[]): boolean {
  return earningsDatesIso.some((eventDate) => eventDate >= todayIso && eventDate <= expiryIso);
}

/** The option settles at the expiry date's regular close (half days close at 13:00 ET, but no major macro event falls between 13:00 and 16:00). */
const expiryCloseEasternTime = { hour: 16, minute: 0 };

/**
 * A macro event still ahead of the scoring moment and before the expiry's 16:00 ET close (approved 2026-10-07): a 14:00
 * release today counts at 10:00, not at 14:05; an 08:30 release on the expiry date counts; a 19:00 ET election on the
 * expiry date does not, because the option has already settled.
 */
export function expirySpansMacroEvent(scoredAtMs: number, expiryIso: string, events: { eventAtMs: number }[]): boolean {
  const expiryCloseMs = easternInstant(expiryIso, expiryCloseEasternTime.hour, expiryCloseEasternTime.minute).getTime();
  return events.some((event) => event.eventAtMs > scoredAtMs && event.eventAtMs < expiryCloseMs);
}
