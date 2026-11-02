// Weeks with an expiry day (S3 and F1 for Vol Farmer v4, approved by Marcelo 2026-11-01, on whole weeks only): a week runs
// Monday to Sunday and counts only when it lies wholly inside the stretch measured, so a week cut by a month's or a
// window's edge never reads as a week without an expiry. A week has an expiry when one of its sessions is an expiry day
// (its 10:00 quotes list a Call expiring that day); it belongs to the month and the year of its last session.

const dayMilliseconds = 86_400_000;

export const addCalendarDays = (dateIso: string, days: number) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * dayMilliseconds).toISOString().slice(0, 10);

/** The Monday of the week holding `dateIso`. */
export function mondayOf(dateIso: string): string {
  const weekday = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return addCalendarDays(dateIso, -((weekday + 6) % 7));
}

export interface WholeWeek {
  monday: string;
  /** The week's sessions inside the stretch, ascending. */
  sessions: string[];
  hasExpiryDay: boolean;
}

/** The whole weeks from `fromIso` to `toIso` (both included) that hold at least one of `sessions` (ascending). */
export function wholeWeeksBetween(sessions: readonly string[], expiryDays: ReadonlySet<string>, fromIso: string, toIso: string): WholeWeek[] {
  const weeks = new Map<string, string[]>();
  for (const session of sessions) {
    if (session < fromIso || session > toIso) continue;
    const monday = mondayOf(session);
    (weeks.get(monday) ?? weeks.set(monday, []).get(monday)!).push(session);
  }
  return [...weeks.entries()].filter(([monday]) => monday >= fromIso && addCalendarDays(monday, 6) <= toIso).map(([monday, weekSessions]) => ({ monday, sessions: weekSessions, hasExpiryDay: weekSessions.some((session) => expiryDays.has(session)) }));
}

export interface ExpiryWeekCount {
  wholeWeeks: number;
  weeksWithExpiryDay: number;
}

export const countExpiryWeeks = (weeks: readonly WholeWeek[]): ExpiryWeekCount => ({ wholeWeeks: weeks.length, weeksWithExpiryDay: weeks.filter((week) => week.hasExpiryDay).length });

/** The whole weeks counted by the year (or, with `period` "month", the month) of each week's last session. */
export function expiryWeeksBy(weeks: readonly WholeWeek[], period: "year" | "month"): Map<string, ExpiryWeekCount> {
  const counts = new Map<string, ExpiryWeekCount>();
  for (const week of weeks) {
    const key = week.sessions.at(-1)!.slice(0, period === "year" ? 4 : 7);
    const count = counts.get(key) ?? counts.set(key, { wholeWeeks: 0, weeksWithExpiryDay: 0 }).get(key)!;
    count.wholeWeeks += 1;
    if (week.hasExpiryDay) count.weeksWithExpiryDay += 1;
  }
  return new Map([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** S3's and F1's pass mark: an expiry day in at least 90% of the whole weeks. */
export const steadyWeekShare = 0.9;

/**
 * F1: the month ("2020-01") steady weeklies start in: the first month from which every month has an expiry day in at least
 * 90% of its whole weeks, that month included; null when no month has. Months without a whole week are not counted.
 */
export function steadyWeekliesStartMonth(weeks: readonly WholeWeek[]): string | null {
  const months = [...expiryWeeksBy(weeks, "month").entries()];
  const passes = months.map(([, count]) => count.weeksWithExpiryDay / count.wholeWeeks >= steadyWeekShare);
  for (let index = 0; index < months.length; index++) if (passes.slice(index).every(Boolean)) return months[index]![0];
  return null;
}
