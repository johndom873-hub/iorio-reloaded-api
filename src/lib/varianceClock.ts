import { easternIsoDate, easternMinutesOfDay } from "./easternIsoDate.js";
import type { TradingSession } from "./marketSessionStatus.js";

// The variance clock (model review P1, approved by Marcelo 2026-10-10; docs/signal-engine-model-review/REPORT.md).
// Time to expiry is counted in trading sessions of variance, not calendar days:
//
//   τ(now → expiry close) = r(now) + Σ c_s over the sessions after today up to and including the expiry
//
//   r(now) = share of a session's close-to-close variance still ahead today: 1 before the open (the overnight gap and the
//            whole session are ahead), then the measured intraday curve below, 0 after the close.
//   c_s    = 1 for every full session (sessions after a weekend or holiday measured 1.00–1.08: counted as 1),
//            ≈ 0.70 for a half day (the overnight gap plus half the intraday variance), 0 for a holiday (not a session).
//
// The curve: 2,289 earnings-free ticker-days of hourly bars (31 tickers, 2026-06..10), variance of ln(close ÷ price at t)
// over the variance of the whole close-to-close day, per ticker then pooled. The options market prices the same clock
// (weekend weight 1.08 [0.96, 1.15]; the first-expiry test fits best with the rest-of-day term).

export const regularOpenMinutesEt = 9 * 60 + 30;
export const regularCloseMinutesEt = 16 * 60;

/** (minutes after midnight ET, share of the session's variance still ahead), regular session; linear in between. */
export type RemainingSessionVarianceCurve = readonly (readonly [number, number])[];

/** Live's curve, measured on 2026-06..10 (see above). */
export const remainingSessionVarianceCurve: RemainingSessionVarianceCurve = [
  [regularOpenMinutesEt, 0.551],
  [10 * 60, 0.309],
  [11 * 60, 0.193],
  [12 * 60, 0.143],
  [13 * 60, 0.113],
  [14 * 60, 0.082],
  [15 * 60, 0.061],
  [regularCloseMinutesEt, 0],
];

/**
 * The same measure on 2020-01..2026-10 (Edge Margin audit 2026-10-22, tmp/edge-margin-audit/rest_of_day_share.py): the
 * backtest files' IBKR 30-minute bars, 30 tickers, 45,208 earnings-free ticker-days. Each full year 2020–2025 read
 * 0.42–0.50 at 10:00 and 2026 0.37; the method gives 0.334 on live's 2026-06..10 window. A backtest session may use it.
 */
export const remainingSessionVarianceCurveMeasured2020To2026: RemainingSessionVarianceCurve = [
  [regularOpenMinutesEt, 0.635],
  [10 * 60, 0.438],
  [10 * 60 + 30, 0.357],
  [11 * 60, 0.31],
  [11 * 60 + 30, 0.267],
  [12 * 60, 0.232],
  [12 * 60 + 30, 0.203],
  [13 * 60, 0.175],
  [13 * 60 + 30, 0.145],
  [14 * 60, 0.122],
  [14 * 60 + 30, 0.099],
  [15 * 60, 0.074],
  [15 * 60 + 30, 0.045],
  [regularCloseMinutesEt, 0],
];

/** Share of a session's variance in the overnight gap (prior close → open). */
export const overnightVarianceShare = 0.412;
/** A half day's intraday variance relative to a full day's (measured 0.496 on the early-close days in 5 years of bars). */
export const earlyCloseIntradayVarianceFactor = 0.496;
/** A whole half-day session: its overnight gap plus its smaller intraday part (≈ 0.704). */
export const earlyCloseSessionWeight = overnightVarianceShare + earlyCloseIntradayVarianceFactor * (1 - overnightVarianceShare);

function interpolateCurve(minutesEt: number, curve: RemainingSessionVarianceCurve): number {
  if (minutesEt <= curve[0]![0]) return curve[0]![1];
  for (let index = 1; index < curve.length; index++) {
    const [rightMinutes, rightShare] = curve[index]!;
    if (minutesEt <= rightMinutes) {
      const [leftMinutes, leftShare] = curve[index - 1]!;
      return leftShare + ((minutesEt - leftMinutes) * (rightShare - leftShare)) / (rightMinutes - leftMinutes);
    }
  }
  return 0;
}

/** r(t): the share of today's session variance still ahead at `minutesEt`, for a session closing at `closeMinutesEt`. */
export function remainingSessionVariance(minutesEt: number, closeMinutesEt: number = regularCloseMinutesEt, curve: RemainingSessionVarianceCurve = remainingSessionVarianceCurve): number {
  const halfDay = closeMinutesEt < regularCloseMinutesEt;
  if (minutesEt < regularOpenMinutesEt) return halfDay ? earlyCloseSessionWeight : 1;
  if (minutesEt >= closeMinutesEt) return 0;
  if (!halfDay) return interpolateCurve(minutesEt, curve);
  // A half day: the regular curve compressed onto 09:30–close, scaled by the half day's smaller intraday variance.
  const mappedMinutes = regularOpenMinutesEt + ((minutesEt - regularOpenMinutesEt) * (regularCloseMinutesEt - regularOpenMinutesEt)) / (closeMinutesEt - regularOpenMinutesEt);
  return earlyCloseIntradayVarianceFactor * interpolateCurve(mappedMinutes, curve);
}

/** c_s: the variance weight of a whole future session. */
export function sessionVarianceWeight(session: TradingSession): number {
  return session.closeMinutesEt < regularCloseMinutesEt ? earlyCloseSessionWeight : 1;
}

/**
 * τ from the instant `atMs` to the expiry's close, in sessions of variance. `sessions` must hold every open session from
 * the instant's Eastern date (when it is one) through the expiry; sessions outside that range are ignored. 0 once the
 * expiry's session has closed. `curve`: live's unless a backtest session chose another.
 */
export function varianceSessionsToExpiry(atMs: number, expiryIso: string, sessions: readonly TradingSession[], curve: RemainingSessionVarianceCurve = remainingSessionVarianceCurve): number {
  const at = new Date(atMs);
  const todayIso = easternIsoDate(at);
  const minutesEt = easternMinutesOfDay(at);
  let total = 0;
  for (const session of sessions) {
    if (session.dateIso < todayIso || session.dateIso > expiryIso) continue;
    total += session.dateIso === todayIso ? remainingSessionVariance(minutesEt, session.closeMinutesEt, curve) : sessionVarianceWeight(session);
  }
  return total;
}
