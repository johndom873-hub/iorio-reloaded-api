import { easternIsoDate } from "../lib/easternIsoDate.js";
import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { captureTickerCalendarEvents } from "../lib/tradingviewCalendarService.js";
import { loadUpcomingMajorMacroEvents } from "../lib/macroEventCalendar.js";

export const calendarEventsRouter = Router();
calendarEventsRouter.use(requireAuth);

// Upcoming-only by default (today forward) -- matches how this page is
// actually used, checking what's coming up rather than auditing history.
// Both tables are captured nightly by job:daily-calendar-capture, scoped to
// shortlisted + open-position tickers for ticker_calendar_events (see
// run-daily-calendar-capture-job.ts); the major US macro events are not
// ticker-scoped, and are the same list the Signals flag and Pluto read.
calendarEventsRouter.get("/", async (_request, response) => {
  const tickerEvents = await db.raw(`
    SELECT
      tce.id,
      t.symbol,
      tce.event_type AS "eventType",
      to_char(tce.event_date, 'YYYY-MM-DD') AS "eventDate",
      tce.event_time AS "eventTime",
      tce.amount
    FROM ticker_calendar_events tce
    JOIN tickers t ON t.id = tce.ticker_id
    WHERE tce.event_date >= ?::date
    ORDER BY tce.event_date ASC, t.symbol ASC
  `, [easternIsoDate(new Date())]);

  const macroEvents = await loadUpcomingMajorMacroEvents();

  response.json({
    tickerEvents: tickerEvents.rows,
    macroEvents,
  });
});

async function loadNextEvents(tickerId: string) {
  const rows = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId })
    .whereRaw("event_date >= ?::date", [easternIsoDate(new Date())])
    .orderBy("event_date", "asc")
    .select(db.raw(`event_type AS "eventType"`), db.raw(`to_char(event_date, 'YYYY-MM-DD') AS "eventDate"`));

  return {
    nextEarningsDate: rows.find((row) => row.eventType === "earnings")?.eventDate ?? null,
    nextExDividendDate: rows.find((row) => row.eventType === "ex_dividend")?.eventDate ?? null,
  };
}

// Signals ticker modal's price bar can be opened for any ticker, not just
// shortlisted/open-position ones the nightly job:daily-calendar-capture
// covers -- so a ticker with no captured rows yet is fetched from
// TradingView on the spot (same call the shortlist-add flow uses) rather
// than showing a permanent blank.
calendarEventsRouter.get("/next/:symbol", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();
  const ticker = await db("tickers").where({ symbol }).first("id");
  if (!ticker) {
    response.status(404).json({ error: `Unknown ticker ${symbol}` });
    return;
  }

  let result = await loadNextEvents(ticker.id);
  if (result.nextEarningsDate === null && result.nextExDividendDate === null) {
    try {
      await captureTickerCalendarEvents(ticker.id, symbol);
      result = await loadNextEvents(ticker.id);
    } catch (error) {
      console.error(`GET /calendar-events/next: on-demand capture failed for ${symbol}`, error);
    }
  }

  response.json(result);
});
