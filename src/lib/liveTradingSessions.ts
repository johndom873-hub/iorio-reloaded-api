import { addCalendarDays } from "./calendarDays.js";
import { easternIsoDate } from "./easternIsoDate.js";
import { loadTradingSessionsBetween, type TradingSession } from "./marketSessionStatus.js";
import { saleSessionAt, sessionsHeldAmong } from "./tradingSessionsHeld.js";

// The sessions a sold option is held, live (tradingSessionsHeld.ts): from the session an order placed now fills in to the
// expiry's, from the market calendar (its synced days, then weekdays).

/** How far ahead the count reaches, in calendar days: past the longest LEAPS listed. */
const countCalendarDays = 1_100;

export interface LiveTradingSessions {
  /** The session an order placed now would fill in. */
  saleSessionIso: string;
  /** Every session from it on, about three years ahead. */
  openDays: readonly string[];
  sessionsHeldTo(expiryIso: string): number;
}

let sessionsOfDay: { todayIso: string; sessions: TradingSession[] } | null = null;

/** The count at `now`; the market calendar is read once a day. */
export async function loadLiveTradingSessions(now: Date = new Date()): Promise<LiveTradingSessions> {
  const todayIso = easternIsoDate(now);
  if (sessionsOfDay?.todayIso !== todayIso) sessionsOfDay = { todayIso, sessions: await loadTradingSessionsBetween(todayIso, addCalendarDays(todayIso, countCalendarDays)) };
  const saleSessionIso = saleSessionAt(now, sessionsOfDay.sessions);
  const openDays = sessionsOfDay.sessions.map((session) => session.dateIso).filter((dateIso) => dateIso >= saleSessionIso);
  return { saleSessionIso, openDays, sessionsHeldTo: (expiryIso) => sessionsHeldAmong(openDays, saleSessionIso, expiryIso) };
}
