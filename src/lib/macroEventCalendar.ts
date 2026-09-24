import { db } from "../db/connection.js";

// Major US macro releases for the Signals "macro_event_before_expiry" flag
// (Formula 3i, approved 2026-09-24). Why a curated list and not the stored
// importance field: TradingView's importance never exceeds 1 in practice
// (~40 such events over two months, including bill auctions and regional
// indices), so "importance >= 1" would flag nearly every candidate with more
// than a couple of days to expiry. Only the releases that move single names
// enough to put an event premium into short-dated IV are listed. A flag,
// never an exclusion: earnings stay a hard exclusion, this is a reading aid.
export const majorMacroEventTitlePatterns: readonly RegExp[] = [
  /^Fed Interest Rate Decision$/i,
  /^Fed Press Conference$/i,
  /^FOMC Economic Projections$/i,
  /^FOMC Minutes$/i, // added 2026-09-24 (Marcelo)
  /^(Core )?Inflation Rate (MoM|YoY)/i, // CPI
  /^Non Farm Payrolls$/i,
  /^Unemployment Rate$/i, // same release as NFP
  /^Core PCE Price Index/i,
  /^GDP Growth Rate QoQ/i, // Adv / 2nd Est / Final
  /^(Core )?PPI (MoM|YoY)/i, // added 2026-09-24 (Marcelo)
];

export function isMajorMacroEvent(title: string): boolean {
  return majorMacroEventTitlePatterns.some((pattern) => pattern.test(title.trim()));
}

export interface MacroEvent {
  dateIso: string; // YYYY-MM-DD (Eastern date of the release)
  title: string;
}

/** Major US releases from today forward, in date order (US-only feed, not ticker-scoped). */
export async function loadUpcomingMajorMacroEvents(): Promise<MacroEvent[]> {
  const rows: { dateIso: string; title: string }[] = await db("economic_calendar_events")
    .where("country", "US")
    .whereRaw("(event_at AT TIME ZONE 'America/New_York')::date >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date")
    .orderBy("event_at", "asc")
    .select(db.raw(`(event_at AT TIME ZONE 'America/New_York')::date::text AS "dateIso"`), "title");
  return rows.filter((row) => isMajorMacroEvent(row.title));
}
