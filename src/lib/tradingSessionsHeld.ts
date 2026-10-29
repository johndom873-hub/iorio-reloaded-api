import { easternIsoDate, easternMinutesOfDay } from "./easternIsoDate.js";
import type { TradingSession } from "./marketSessionStatus.js";

// How long a sold option ties up its capital, for every premium yield a year on the platform (Marcelo 2026-10-29): the
// trading sessions from the one it is sold in to its expiry's, both counted in full, a year being 252 of them. A weekend
// or a holiday counts for no expiry: a Friday 0DTE is held 1 session, Thursday for Friday 2, Monday for Friday 5 (4 with
// a holiday that week). Live, an order fills in today's session until its close, else in the next one
// (liveTradingSessions.ts).
//
//   premium yield a year = premium after costs ÷ capital × 252 ÷ sessions held
//
// Example: 0.2% earned on Thursday for Friday is 0.2% × 252 ÷ 2 = 25.2% a year.

/** Trading sessions in a year. */
export const tradingSessionsPerYear = 252;

/** The first index whose date is at or after `value` (`orAfter`) or strictly after it, in ascending ISO dates. */
const firstIndexFrom = (sorted: readonly string[], value: string, orAfter: boolean): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (orAfter ? sorted[middle]! < value : sorted[middle]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
};

/** Pure: the sessions from `saleSessionIso` to `expiryIso`, both included, among `openDays` (ascending ISO dates); at least 1. */
export function sessionsHeldAmong(openDays: readonly string[], saleSessionIso: string, expiryIso: string): number {
  return Math.max(1, firstIndexFrom(openDays, expiryIso, false) - firstIndexFrom(openDays, saleSessionIso, true));
}

/** Pure: the session an order placed at `now` fills in: today's until its close, else the next one (`sessions` from today on). */
export function saleSessionAt(now: Date, sessions: readonly TradingSession[]): string {
  const todayIso = easternIsoDate(now);
  const today = sessions[0]?.dateIso === todayIso ? sessions[0] : null;
  if (today !== null && easternMinutesOfDay(now) < today.closeMinutesEt) return todayIso;
  const next = sessions.find((session) => session.dateIso > todayIso);
  if (!next) throw new Error(`No trading session after ${todayIso} in the market calendar.`);
  return next.dateIso;
}
