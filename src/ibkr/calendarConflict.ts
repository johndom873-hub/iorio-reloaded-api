import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import type { SignalStrategyKey } from "../lib/signalCandidates.js";

export interface CalendarConflict {
  eventType: "earnings" | "ex_dividend";
  eventDate: string; // YYYY-MM-DD
}

export interface CalendarConflictContext {
  // False when the ticker has never resolved to a TradingView symbol, so
  // `events` is necessarily empty regardless of what's actually scheduled —
  // callers should treat this as "not checked," not "confirmed clear."
  resolved: boolean;
  events: CalendarConflict[];
}

/**
 * Loads the earnings/ex-dividend rows already captured by
 * run-daily-calendar-capture-job.ts for one ticker, from today forward. One
 * query per ticker — callers fetch this once and reuse it across every
 * candidate expiry for that ticker rather than querying per-candidate.
 */
export async function fetchCalendarConflictContext(tickerId: string, now: Date = new Date()): Promise<CalendarConflictContext> {
  const tickerRow = await db("tickers").where({ id: tickerId }).first("tradingview_ticker");
  const resolved = !!tickerRow?.tradingview_ticker;

  // Cast to ::text — a bare `date` column round-trips through node-pg's
  // local-timezone Date parsing otherwise, see project_postgres_date_local_timezone_parsing.
  // From today in US Eastern time (not the server's UTC date). Today's before-open report has already happened, as in the
  // Signals earnings exclusion (loadEarningsDatesNotYetReported).
  const todayIso = easternIsoDate(now);
  const rows: { eventType: "earnings" | "ex_dividend"; eventDate: string }[] = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId })
    .whereRaw("event_date >= ?::date", [todayIso])
    .whereRaw("not (event_type = 'earnings' and event_date = ?::date and event_time is not distinct from '-1')", [todayIso])
    .select("event_type as eventType", db.raw(`event_date::text as "eventDate"`));

  return { resolved, events: rows };
}

/**
 * A candidate conflicts with a calendar event when the position would still
 * be open on the event date — i.e. the event falls on or before the
 * candidate's expiry (fetchCalendarConflictContext already excludes events
 * before today). Earnings apply to both strategies; ex-dividend only matters
 * for covered calls (early-exercise-for-dividend risk has no short-put
 * analog) per Marcelo's 2026-08-28 requirement.
 */
export function findCalendarConflict(
  context: CalendarConflictContext,
  strategyKey: SignalStrategyKey,
  expiryIso: string,
): CalendarConflict | null {
  for (const event of context.events) {
    if (event.eventDate > expiryIso) continue;
    if (event.eventType === "earnings") return event;
    if (event.eventType === "ex_dividend" && strategyKey === "covered_call") return event;
  }
  return null;
}

export interface MacroEventWarningEvent {
  title: string;
  eventDate: string; // YYYY-MM-DD, Eastern
}

/**
 * Non-blocking macro-event warning for the window between today and an order's
 * expiry — advisory-only per Marcelo's 2026-08-31 decision, unlike
 * earnings/ex-dividend which hard-exclude via findCalendarConflict above. The
 * events are the major US ones (macroEventCalendar.ts) still ahead and before the
 * expiry's 16:00 ET close: the same rule as the Signals flag (expirySpansMacroEvent).
 */
export async function fetchMacroEventWarningEvents(expiryYyyymmdd: string): Promise<MacroEventWarningEvent[]> {
  return db("major_macro_events")
    .whereRaw("event_at > CURRENT_TIMESTAMP")
    .andWhereRaw("event_at < ((to_date(?, 'YYYYMMDD') + time '16:00') AT TIME ZONE 'America/New_York')", [expiryYyyymmdd])
    .orderBy("event_at", "asc")
    .select("title", db.raw(`(event_at AT TIME ZONE 'America/New_York')::date::text AS "eventDate"`));
}

export function formatMacroEventWarning(events: MacroEventWarningEvent[]): string | null {
  if (events.length === 0) return null;
  const list = events.map((event) => `${event.title} (${event.eventDate})`).join("; ");
  return `${events.length} economic event${events.length === 1 ? "" : "s"} before expiry: ${list}`;
}
