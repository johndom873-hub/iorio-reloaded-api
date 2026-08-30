import { db } from "../db/connection.js";
import type { AlertStrategyKey } from "./generateTradeAlertCandidates.js";

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
export async function fetchCalendarConflictContext(tickerId: string): Promise<CalendarConflictContext> {
  const tickerRow = await db("tickers").where({ id: tickerId }).first("tradingview_ticker");
  const resolved = !!tickerRow?.tradingview_ticker;

  // Cast to ::text — a bare `date` column round-trips through node-pg's
  // local-timezone Date parsing otherwise, see project_postgres_date_local_timezone_parsing.
  const rows: { eventType: "earnings" | "ex_dividend"; eventDate: string }[] = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId })
    .andWhere("event_date", ">=", db.raw("CURRENT_DATE"))
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
  strategyKey: AlertStrategyKey,
  expiryIso: string,
): CalendarConflict | null {
  for (const event of context.events) {
    if (event.eventDate > expiryIso) continue;
    if (event.eventType === "earnings") return event;
    if (event.eventType === "ex_dividend" && strategyKey === "covered_call") return event;
  }
  return null;
}
