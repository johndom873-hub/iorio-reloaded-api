import { resolveIsOpenDay } from "./marketSessionStatus.js";
import { easternIsoDate } from "./easternIsoDate.js";

/**
 * Whether the US market is closed on the Eastern calendar day `now` falls on (weekend or market_calendar holiday).
 * Scheduled jobs gate on this before doing any work.
 *
 * The day is the Eastern one, not the UTC one: between 00:00 UTC and ~04:00 UTC (08:00-12:00 SGT) the UTC date is
 * already the next day while it is still the previous evening in New York, so a late or manual rerun there would be
 * judged against the wrong day. At the Scheduler slots themselves (09:00-23:30 UTC, i.e. 04:00-19:30 ET) the two
 * dates are the same, so scheduled runs are unaffected.
 *
 * market_calendar decides when it has a row for the day; otherwise it is a plain weekday check (see resolveIsOpenDay),
 * which matches a weekend correctly and never wrongly skips a real trading day.
 */
export async function isMarketClosedToday(now: Date = new Date()): Promise<boolean> {
  return !(await resolveIsOpenDay(easternIsoDate(now)));
}
