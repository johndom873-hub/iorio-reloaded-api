import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { addCalendarDays } from "../../lib/calendarDays.js";
import { earlyCloseDatesIso, openDaysFromCalendarRows, tradingSessionsFromCalendarRows, type TradingSession } from "../../lib/marketSessionStatus.js";
import { sessionsHeldAmong } from "../../lib/tradingSessionsHeld.js";
import type { SymbolFileDay } from "./backtestSymbolFile.js";

// The sessions a backtest day is valued over (variance clock, sessions to expiry). Inside the symbol file's range its days
// say it: a complete day is a session, a no-data weekday is an exchange holiday. After the file's last day (expiries up to
// 45 days later) the local market_calendar decides where it has rows, else a plain weekday. Closes: 13:00 ET on the NYSE
// early-close days below, else the stored close, else 16:00 (the live rule, marketSessionStatus.ts).

/**
 * NYSE early closes (13:00 ET) 2016–2026, from the NYSE holiday and trading-hours schedule (nyse.com/markets/hours-calendars):
 * the day before Independence Day when it is a weekday session, the day after Thanksgiving, and Christmas Eve when it is a
 * weekday session. No early close when 3 July or 24 December falls on a weekend or is itself the observed holiday
 * (2020-07-03, 2021-12-24, 2026-07-03 were closed), nor on 2 July 2021 / 2026 or 23 December 2016 / 2022.
 */
export const nyseEarlyCloseDatesIso2016To2026: readonly string[] = [
  "2016-11-25",
  "2017-07-03", "2017-11-24",
  "2018-07-03", "2018-11-23", "2018-12-24",
  "2019-07-03", "2019-11-29", "2019-12-24",
  "2020-11-27", "2020-12-24",
  "2021-11-26",
  "2022-11-25",
  "2023-07-03", "2023-11-24",
  "2024-07-03", "2024-11-29", "2024-12-24",
  "2025-07-03", "2025-11-28", "2025-12-24",
  "2026-11-27", "2026-12-24",
];

const backtestEarlyCloseDatesIso = new Set([...nyseEarlyCloseDatesIso2016To2026, ...earlyCloseDatesIso]);
const earlyCloseTime = "13:00:00";

export interface MarketCalendarRow {
  dateIso: string;
  isOpen: boolean;
  closeTime: string | null;
}

export class BacktestTradingCalendar {
  private readonly rowsByDate = new Map<string, MarketCalendarRow>();

  /** `fileDays` ascending; `marketCalendarRows` are used only after the file's last day. */
  constructor(fileDays: readonly SymbolFileDay[], marketCalendarRows: readonly MarketCalendarRow[]) {
    const fileLastDate = fileDays.at(-1)?.tradingDate ?? "";
    for (const day of fileDays) this.rowsByDate.set(day.tradingDate, { dateIso: day.tradingDate, isOpen: day.status === "complete", closeTime: backtestEarlyCloseDatesIso.has(day.tradingDate) ? earlyCloseTime : null });
    for (const row of marketCalendarRows) {
      if (row.dateIso <= fileLastDate) continue;
      this.rowsByDate.set(row.dateIso, { ...row, closeTime: row.closeTime ?? (backtestEarlyCloseDatesIso.has(row.dateIso) ? earlyCloseTime : null) });
    }
    // A weekday with no row at all is a session (the live fallback); give the known early closes their 13:00 there too.
    for (const dateIso of backtestEarlyCloseDatesIso) if (!this.rowsByDate.has(dateIso)) this.rowsByDate.set(dateIso, { dateIso, isOpen: true, closeTime: earlyCloseTime });
  }

  private rowsBetween(fromIso: string, toIso: string): MarketCalendarRow[] {
    const rows: MarketCalendarRow[] = [];
    for (let dateIso = fromIso; dateIso <= toIso; dateIso = addCalendarDays(dateIso, 1)) {
      const row = this.rowsByDate.get(dateIso);
      if (row) rows.push(row);
    }
    return rows;
  }

  /** Every session from `fromIso` to `toIso` inclusive, with its close. */
  sessionsBetween(fromIso: string, toIso: string): TradingSession[] {
    if (toIso < fromIso) return [];
    return tradingSessionsFromCalendarRows(fromIso, toIso, this.rowsBetween(fromIso, toIso));
  }

  /** The session dates from `fromIso` to `toIso` inclusive. */
  openDaysBetween(fromIso: string, toIso: string): string[] {
    if (toIso < fromIso) return [];
    return openDaysFromCalendarRows(fromIso, toIso, this.rowsBetween(fromIso, toIso));
  }

  /** Whether `dateIso` is a session. */
  isSession(dateIso: string): boolean {
    return this.openDaysBetween(dateIso, dateIso).length === 1;
  }

  private sessionsHeldDays: { fromIso: string; toIso: string; openDays: string[] } | null = null;

  /**
   * The sessions from `fromIso` to `toIso`, both included, at least one: what a premium yield is annualized over
   * (tradingSessionsHeld.ts). The session dates are listed once, from the calendar's first day to about three years past
   * its last, and listed again only for a date outside them.
   */
  sessionsHeld(fromIso: string, toIso: string): number {
    const listed = this.sessionsHeldDays;
    if (listed === null || fromIso < listed.fromIso || toIso > listed.toIso) {
      const dates = [...this.rowsByDate.keys()].sort();
      const first = dates[0] !== undefined && dates[0] < fromIso ? dates[0] : fromIso;
      const pastLast = dates.length > 0 ? addCalendarDays(dates.at(-1)!, 1_100) : toIso;
      const last = pastLast > toIso ? pastLast : toIso;
      this.sessionsHeldDays = { fromIso: first, toIso: last, openDays: this.openDaysBetween(first, last) };
    }
    return sessionsHeldAmong(this.sessionsHeldDays!.openDays, fromIso, toIso);
  }

  /** The last session before `dateIso`, within two weeks; null when none. */
  sessionBefore(dateIso: string): string | null {
    return this.openDaysBetween(addCalendarDays(dateIso, -14), addCalendarDays(dateIso, -1)).at(-1) ?? null;
  }
}

/** The local market_calendar rows from `fromIso` on (the sessions after the data file ends). */
export async function loadMarketCalendarRowsFrom(fromIso: string, connection: Knex = db): Promise<MarketCalendarRow[]> {
  const rows: { dateIso: string; isOpen: boolean; closeTime: string | null }[] = await connection("market_calendar")
    .where("calendar_date", ">=", fromIso)
    .select(connection.raw(`calendar_date::text as "dateIso"`), "is_open as isOpen", connection.raw(`close_time::text as "closeTime"`));
  return rows;
}
