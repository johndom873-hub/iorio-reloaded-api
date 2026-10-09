import { easternInstant } from "./easternIsoDate.js";
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
/** The forecast's own year: Yang-Zhang gives variance per trading session (realizedVolatility.ts annualizes × 252). */
export const tradingSessionsPerYear = 252;
export const fallbackForecastWindowDays = 21;
/** Daily bars needed for any forecast at all: the shorter window plus the prior close. */
export const minimumBarsForAnyForecast = fallbackForecastWindowDays + 1;

export interface RealizedVolatilityForecast {
  /** Annualized, as a decimal (0.45 = 45%). */
  volatility: number;
  windowDays: typeof primaryForecastWindowDays | typeof fallbackForecastWindowDays;
}

export interface RealizedVolatilityForecastSelection {
  forecast: RealizedVolatilityForecast | null;
  /** Set only when no window could be used and the last one tried was blocked by the split guard: the flagged trading date. */
  suspectedSplitDateIso: string | null;
}

/** `bars` must be in date order and end at (not after) the snapshot date, so the forecast never sees the future. */
export function selectRealizedVolatilityForecast(bars: DailyOhlcvBar[]): RealizedVolatilityForecastSelection {
  let suspectedSplitDateIso: string | null = null;
  for (const windowDays of [primaryForecastWindowDays, fallbackForecastWindowDays] as const) {
    const result = computeYangZhangVolatility(bars, windowDays);
    if (result.available && Number.isFinite(result.annualizedVolatility) && result.annualizedVolatility > 0) {
      return { forecast: { volatility: result.annualizedVolatility, windowDays }, suspectedSplitDateIso: null };
    }
    if (!result.available && result.reason === "suspected_split") suspectedSplitDateIso = result.splitDateIso ?? null;
  }
  return { forecast: null, suspectedSplitDateIso };
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

/**
 * The forecast on one option's clock (approved 2026-10-09). The forecast is per trading session × 252; the option's
 * implied volatility is per calendar day × 365 (the fit's convention). Comparing them as they are flatters contracts that
 * span no weekend and penalizes those that do, so the forecast is put on the option's clock first:
 *
 *   forecast on the option's clock = forecast × √( (N ÷ 252) ÷ (D ÷ 365) )
 *
 * N = trading sessions from the scoring date to expiry (weekends and holidays don't count), D ÷ 365 = the option's
 * calendar years (`calendarYearsToExpiry`). SMCI Thu → Fri: 76.6% × √((1/252) ÷ (1/365)) = 92.2%. Edge = IV − this.
 * Null when N is unknown or zero (an expiry-day contract has no fitted slice anyway).
 */
export function forecastOnOptionClock(forecastVolatility: number, tradingSessionsToExpiry: number | undefined, calendarYearsToExpiry: number): number | null {
  if (tradingSessionsToExpiry === undefined || !(tradingSessionsToExpiry > 0) || !(calendarYearsToExpiry > 0)) return null;
  return forecastVolatility * Math.sqrt(tradingSessionsToExpiry / tradingSessionsPerYear / calendarYearsToExpiry);
}

/** Per expiry, the open days in `openSessionDatesIso` after `scoringDateIso`, up to and including the expiry. */
export function tradingSessionsByExpiry(expiries: string[], openSessionDatesIso: string[], scoringDateIso: string): Map<string, number> {
  const sessions = openSessionDatesIso.filter((dateIso) => dateIso > scoringDateIso).sort();
  const result = new Map<string, number>();
  for (const expiry of expiries) {
    let count = 0;
    while (count < sessions.length && sessions[count]! <= expiry) count++;
    result.set(expiry, count);
  }
  return result;
}

/** Null (unscored) unless the slice is 'ok' and a forecast exists; flagged slices are never used silently. */
export function computeVolatilityEdge(slice: EdgeSlice, strike: number, forecast: RealizedVolatilityForecast | null, tradingSessionsToExpiry: number): VolatilityEdge | null {
  if (forecast === null || slice.status !== "ok" || slice.parameters === null || slice.kMin === null || slice.kMax === null) return null;
  if (!(strike > 0) || !(slice.forwardPrice > 0) || !(slice.yearsToExpiry > 0)) return null;
  const logMoneyness = Math.log(strike / slice.forwardPrice);
  const totalVariance = sviTotalVariance(slice.parameters, logMoneyness);
  if (!(totalVariance > 0)) return null;
  const impliedVolatility = Math.sqrt(totalVariance / slice.yearsToExpiry);
  const contractForecast = forecastOnOptionClock(forecast.volatility, tradingSessionsToExpiry, slice.yearsToExpiry);
  if (contractForecast === null) return null;
  return {
    impliedVolatility,
    forecastVolatility: contractForecast,
    forecastWindowDays: forecast.windowDays,
    edge: impliedVolatility - contractForecast,
    insideFittedRange: logMoneyness >= slice.kMin && logMoneyness <= slice.kMax,
  };
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
