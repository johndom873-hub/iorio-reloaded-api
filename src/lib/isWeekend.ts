import { db } from "../db/connection.js";

/**
 * Scheduled jobs all key off US market activity, which is closed
 * Saturday/Sunday regardless of timezone — Heroku Scheduler times are UTC,
 * and the US market weekend lines up with the UTC calendar weekend, so no
 * timezone conversion is needed here.
 *
 * Weekday-only, deliberately: this has no market_calendar awareness, so it
 * still fires (wrongly) on a US market holiday like Labor Day. Every job
 * that gates on "is today a trading day" should call isMarketClosedToday()
 * below instead — this stays exported only as that function's fallback and
 * for any caller that genuinely wants a pure weekday check.
 */
export function isWeekend(date: Date = new Date()): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The holiday-aware version of isWeekend(), backed by market_calendar (see
 * strategyPeriodPnl.ts's day_start CTE for the same table used the same
 * way). Found 2026-09-08: every scheduled job gated on isWeekend() alone
 * still ran on Labor Day 2026-09-07 (a Monday, so not caught by a weekday
 * check) even though market_calendar already correctly had it marked
 * is_open=false — daily_pnl_snapshot's run that day burned an IBKR round
 * trip and wrote a snapshot with 0/4 positions priced (market closed, no
 * live quotes), harmless that time only because it degraded gracefully.
 *
 * Falls back to the plain weekday check if market_calendar has no row for
 * today (not synced far enough ahead, per sync-market-calendar.ts's own
 * "no scheduled job for it" comment) — matches a weekend correctly either
 * way and never wrongly skips a real trading day, at the cost of still
 * missing an un-synced holiday until someone re-runs the sync script.
 */
export async function isMarketClosedToday(): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await db("market_calendar").where({ calendar_date: today }).first();
  if (row) return !row.is_open;
  return isWeekend();
}
