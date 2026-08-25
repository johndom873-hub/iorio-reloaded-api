/**
 * Scheduled jobs all key off US market activity, which is closed
 * Saturday/Sunday regardless of timezone — Heroku Scheduler times are UTC,
 * and the US market weekend lines up with the UTC calendar weekend, so no
 * timezone conversion is needed here.
 */
export function isWeekend(date: Date = new Date()): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}
