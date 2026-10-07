import { db } from "../db/connection.js";
import type { SessionHours } from "../ibkr/fetchLiquidHours.js";
import { easternIsoDate } from "./easternIsoDate.js";

// The session close (half days included) from IBKR's liquid hours for SPY, stored in market_calendar.close_time. Read
// every trading morning by the option-chain structure job in every environment (Marcelo 2026-10-05: staging and
// production know about half days the same way); the screens, order cancellation labels and Pluto read the stored value.

/**
 * Reads SPY's liquid hours from IBKR and stores each day's close in market_calendar. is_open stays
 * MarketData.app's (a day IBKR lists as CLOSED is left alone); only days with hours are written.
 */
export async function recordSessionCloseFromIbkr(fetchHours: () => Promise<SessionHours[]>, now: Date = new Date()): Promise<{ todayCloseTimeEt: string | null; datesWritten: string[] }> {
  const days = await fetchHours();
  const readAt = now.toISOString();
  const datesWritten: string[] = [];
  for (const day of days) {
    if (day.closed || day.closeHhmm === null) continue;
    await db("market_calendar")
      .insert({ calendar_date: day.dateIso, is_open: true, close_time: `${day.closeHhmm}:00`, close_time_source: "ibkr_liquid_hours", close_time_read_at: readAt })
      .onConflict("calendar_date")
      .merge(["close_time", "close_time_source", "close_time_read_at"]);
    datesWritten.push(day.dateIso);
  }
  const todayIso = easternIsoDate(now);
  const today = days.find((day) => day.dateIso === todayIso);
  return { todayCloseTimeEt: today && !today.closed ? today.closeHhmm : null, datesWritten };
}
