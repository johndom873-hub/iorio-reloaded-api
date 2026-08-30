import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const calendarEventsRouter = Router();
calendarEventsRouter.use(requireAuth);

// Upcoming-only by default (today forward) -- matches how this page is
// actually used, checking what's coming up rather than auditing history.
// Both tables are captured nightly by job:daily-calendar-capture, scoped to
// shortlisted + open-position tickers for ticker_calendar_events (see
// run-daily-calendar-capture-job.ts); economic_calendar_events is a
// standalone US macro feed, not ticker-scoped.
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
    WHERE tce.event_date >= CURRENT_DATE
    ORDER BY tce.event_date ASC, t.symbol ASC
  `);

  // Excludes Low (0) and Unrated (-1) importance -- TradingView's economic
  // calendar is dominated by low-signal noise (bill auctions, minor
  // regional indices); only Medium (1) and High (2) are worth surfacing
  // here (approved 2026-08-31).
  const economicEvents = await db.raw(`
    SELECT
      id,
      title,
      country,
      category,
      importance,
      actual,
      forecast,
      previous,
      event_at AS "eventAt"
    FROM economic_calendar_events
    WHERE event_at >= CURRENT_DATE
      AND importance >= 1
    ORDER BY event_at ASC
  `);

  response.json({
    tickerEvents: tickerEvents.rows,
    economicEvents: economicEvents.rows,
  });
});
