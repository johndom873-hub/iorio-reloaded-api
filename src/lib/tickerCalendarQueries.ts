import { db } from "../db/connection.js";
import { isRegularDividendCadence } from "./impliedVolatilitySurface.js";

// Per-ticker reads of daily closes and calendar events (moved out of signalsStore.ts 2026-10-27).

export interface PreviousClose {
  close: number;
  dateIso: string;
}

/** The last stored close strictly before today's Eastern session date (decided 2026-09-22: bars, not IBKR's tick 9). */
export async function loadPreviousClose(tickerId: string, todayEasternIso: string): Promise<PreviousClose | null> {
  const row = await db("daily_price_bars")
    .where({ ticker_id: tickerId })
    .whereRaw("trading_date::text < ?", [todayEasternIso])
    .whereNotNull("close_price")
    .orderBy("trading_date", "desc")
    .select(db.raw('trading_date::text as "dateIso"'), "close_price as close")
    .first();
  return row ? { close: Number(row.close), dateIso: row.dateIso } : null;
}

/** The next earnings report still to come: today's counts unless it was before the open (as loadEarningsDatesNotYetReported). */
export async function loadNextEarningsDate(tickerId: string, todayIso: string): Promise<string | null> {
  const row = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId, event_type: "earnings" })
    .where("event_date", ">=", todayIso)
    .whereRaw("not (event_date = ?::date and event_time is not distinct from '-1')", [todayIso])
    .orderBy("event_date")
    .select(db.raw('event_date::text as "eventDate"'))
    .first();
  return row?.eventDate ?? null;
}

/** True when there is an upcoming ex-dividend but no regular cadence could be inferred to project later ones into the forward (Formula: see impliedVolatilitySurface.ts projectDividendSchedule, approved 2026-09-23). */
export async function loadDividendCadenceUnknown(tickerId: string, todayIso: string): Promise<boolean> {
  const [next, past] = await Promise.all([
    db("ticker_calendar_events")
      .where({ ticker_id: tickerId, event_type: "ex_dividend" })
      .where("event_date", ">=", todayIso)
      .orderBy("event_date")
      .select(db.raw('event_date::text as "date"'), "amount")
      .first(),
    db("ticker_calendar_events")
      .where({ ticker_id: tickerId, event_type: "ex_dividend" })
      .where("event_date", "<", todayIso)
      .orderBy("event_date", "desc")
      .select(db.raw('event_date::text as "date"'), "amount")
      .first(),
  ]);
  if (!next) return false;
  return !isRegularDividendCadence({ date: next.date, amount: Number(next.amount) }, past ? { date: past.date, amount: Number(past.amount) } : null);
}

export async function loadEarningsDatesForForecastWindow(tickerId: string): Promise<string[]> {
  // Every stored earnings row (the Shortlist readiness count); the Signals exclusion uses loadEarningsDatesNotYetReported.
  const rows: { eventDate: string }[] = await db("ticker_calendar_events").where({ ticker_id: tickerId, event_type: "earnings" }).select(db.raw('event_date::text as "eventDate"'));
  return rows.map((row) => row.eventDate);
}

/**
 * The earnings dates the Signals exclusion checks: today's only when not reported before the open (TradingView's event_time
 * "-1" = before the open, "1" = after the close, "0" or none = unknown time, which still counts).
 */
export async function loadEarningsDatesNotYetReported(tickerId: string, todayIso: string): Promise<string[]> {
  const rows: { eventDate: string }[] = await db("ticker_calendar_events")
    .where({ ticker_id: tickerId, event_type: "earnings" })
    .where("event_date", ">=", todayIso)
    .whereRaw("not (event_date = ?::date and event_time is not distinct from '-1')", [todayIso])
    .select(db.raw('event_date::text as "eventDate"'));
  return rows.map((row) => row.eventDate);
}
