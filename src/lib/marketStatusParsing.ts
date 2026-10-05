// Parsing of MarketData.app's market-status response for market_calendar (scripts/sync-market-calendar.ts).
// Every job's market-closed guard trusts market_calendar, so a misread status silently skips a real
// trading day for every job and the watchdog. The API returns exactly "open", "closed", or null
// (null = not published yet: dates more than about a year out, verified 2026-09-30). Anything else
// is a format change and must fail the sync loudly, not be stored as "closed".

export interface CalendarDay {
  calendarDate: string;
  isOpen: boolean;
}

export interface ParsedMarketStatus {
  knownDays: CalendarDay[];
  /** Dates the API has no status for yet; their stored rows are removed so the weekday fallback applies. */
  unknownDates: string[];
}

/** A null status is normal only far ahead (the exchange calendar is published about a year out); a null this close to today means the API answered badly. */
export const nullStatusMinimumDaysAhead = 90;

export function parseMarketStatus(dateSeconds: number[], statuses: (string | null)[], todayIso: string): ParsedMarketStatus {
  if (dateSeconds.length === 0) throw new Error("MarketData.app returned no dates for the requested range");
  if (statuses.length !== dateSeconds.length) throw new Error(`MarketData.app returned ${dateSeconds.length} dates but ${statuses.length} statuses`);

  const knownDays: CalendarDay[] = [];
  const unknownDates: string[] = [];
  dateSeconds.forEach((seconds, index) => {
    const calendarDate = new Date(seconds * 1000).toISOString().slice(0, 10);
    const status = statuses[index];
    if (status === "open") knownDays.push({ calendarDate, isOpen: true });
    else if (status === "closed") knownDays.push({ calendarDate, isOpen: false });
    else if (status === null || status === undefined) {
      const daysAhead = Math.round((Date.parse(`${calendarDate}T12:00:00Z`) - Date.parse(`${todayIso}T12:00:00Z`)) / 86_400_000);
      if (daysAhead < nullStatusMinimumDaysAhead) throw new Error(`MarketData.app returned no market status for ${calendarDate}, only ${daysAhead} day(s) from today (a null is expected only ${nullStatusMinimumDaysAhead}+ days out)`);
      unknownDates.push(calendarDate);
    }
    else throw new Error(`MarketData.app returned an unexpected market status "${status}" for ${calendarDate} (expected open, closed or null)`);
  });

  if (!knownDays.some((day) => day.calendarDate === todayIso)) throw new Error(`MarketData.app has no open/closed status for today (${todayIso})`);
  return { knownDays, unknownDates };
}
