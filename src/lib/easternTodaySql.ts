// Kept out of easternIsoDate.ts, which the trading worker also runs, so a change here never redeploys the worker.

/**
 * SQL for today's US/Eastern date. Postgres's CURRENT_DATE is the UTC date, a day ahead from 19:00 ET (20:00 in summer)
 * to midnight ET (Marcelo 2026-11-11: trading dates are ET). Example: at 21:00 ET on Sun 15 Nov it is 2026-11-15, where
 * CURRENT_DATE is already 2026-11-16, a new week.
 */
export const easternTodaySql = "(now() AT TIME ZONE 'America/New_York')::date";
