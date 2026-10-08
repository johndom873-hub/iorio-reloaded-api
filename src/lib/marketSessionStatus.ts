import { db } from "../db/connection.js";
import { easternInstant, easternIsoDate } from "./easternIsoDate.js";

export { easternInstant };

// US equities session schedule (Eastern Time) — approved 2026-09-14.
// NASDAQ and NYSE share this exact schedule, which is why one computation
// serves every exchange currently seen in the book (see
// computeMarketSessionStatus's caller in routes/systemHealth.ts). Would need
// a per-exchange schedule only if a non-standard-hours listing (e.g. a
// foreign ADR's primary exchange) ever enters the book.
const PRE_MARKET_START = { hour: 4, minute: 0 };
const REGULAR_OPEN = { hour: 9, minute: 30 };
const REGULAR_CLOSE = { hour: 16, minute: 0 };
const AFTER_HOURS_END = { hour: 20, minute: 0 };

export type MarketSessionState = "pre-market" | "open" | "after-hours" | "closed";

export interface MarketSessionStatus {
  state: MarketSessionState;
  label: string;
  /** ISO instant the countdown in `label` runs to, so a client can keep ticking it down between polls. */
  nextChangeAt: string;
}

/** 00:00 ET of the Eastern calendar day `at` falls on: "today" for jobs that must have run since the US day began. */
export function easternDayStart(at: Date): Date {
  return easternInstant(easternIsoDate(at), 0, 0);
}

function isWeekday(dateIso: string): boolean {
  const day = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

// market_calendar (synced from MarketData.app, see scripts/sync-market-calendar.ts)
// covers ~400 days forward as of its last sync — falls back to a plain
// weekday check for any date outside that coverage rather than failing.
export async function resolveIsOpenDay(dateIso: string): Promise<boolean> {
  const row = await db("market_calendar").where({ calendar_date: dateIso }).first();
  if (row) return row.is_open;
  return isWeekday(dateIso);
}

/** Pure: the open days from `fromIso` to `toIso` inclusive, sorted; a day with a calendar row follows it, any other is a plain weekday check (as resolveIsOpenDay). */
export function openDaysFromCalendarRows(fromIso: string, toIso: string, rows: { dateIso: string; isOpen: boolean }[]): string[] {
  const isOpenByDate = new Map(rows.map((row) => [row.dateIso, row.isOpen]));
  const openDays: string[] = [];
  for (let at = Date.parse(`${fromIso}T12:00:00Z`); at <= Date.parse(`${toIso}T12:00:00Z`); at += 86_400_000) {
    const dateIso = new Date(at).toISOString().slice(0, 10);
    if (isOpenByDate.get(dateIso) ?? isWeekday(dateIso)) openDays.push(dateIso);
  }
  return openDays;
}

/** The open days from `fromIso` to `toIso` inclusive in one query (resolveIsOpenDay per day would be one query each). */
export async function loadOpenDaysBetween(fromIso: string, toIso: string): Promise<string[]> {
  const rows: { dateIso: string; isOpen: boolean }[] = await db("market_calendar")
    .whereBetween("calendar_date", [fromIso, toIso])
    .select(db.raw(`calendar_date::text as "dateIso"`), "is_open as isOpen");
  return openDaysFromCalendarRows(fromIso, toIso, rows);
}

export type SessionCloseSource = "ibkr_liquid_hours" | "regular";

/** One day's schedule: open or not, and when the regular session closes (16:00 ET unless the calendar knows better). */
export interface SessionSchedule {
  dateIso: string;
  isOpen: boolean;
  closeTimeEt: string;
  closeSource: SessionCloseSource;
  closeReadAt: string | null;
}

export function hhmmParts(hhmm: string): { hour: number; minute: number } {
  const [hour, minute] = hhmm.split(":").map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

export const regularCloseEt = `${String(REGULAR_CLOSE.hour).padStart(2, "0")}:${String(REGULAR_CLOSE.minute).padStart(2, "0")}`;

// market_calendar.close_time (a Postgres time, "13:00:00") is written from IBKR's liquid hours every trading
// morning (lib/sessionCloseFromIbkr.ts, from the option-chain structure job); NULL means the regular close.
export async function resolveSessionSchedule(dateIso: string): Promise<SessionSchedule> {
  const row = await db("market_calendar").where({ calendar_date: dateIso }).first();
  const closeTime = row?.close_time ? String(row.close_time).slice(0, 5) : null;
  return {
    dateIso,
    isOpen: row ? Boolean(row.is_open) : isWeekday(dateIso),
    closeTimeEt: closeTime ?? regularCloseEt,
    closeSource: closeTime ? "ibkr_liquid_hours" : "regular",
    closeReadAt: row?.close_time_read_at ? new Date(row.close_time_read_at).toISOString() : null,
  };
}

async function nextOpenDateAfter(dateIso: string): Promise<string> {
  let cursor = new Date(`${dateIso}T12:00:00Z`);
  for (let i = 0; i < 14; i++) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    const candidate = cursor.toISOString().slice(0, 10);
    if (await resolveIsOpenDay(candidate)) return candidate;
  }
  // Shouldn't happen with a synced calendar (a 14-trading-day-closed streak
  // would be extraordinary) — never hang the endpoint waiting for one.
  return dateIso;
}

function formatCountdown(ms: number, prefix: string): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `${prefix} ${duration}`;
}

export async function computeMarketSessionStatus(now: Date = new Date()): Promise<MarketSessionStatus> {
  const dateIso = easternIsoDate(now);
  const schedule = await resolveSessionSchedule(dateIso);
  const todayIsOpen = schedule.isOpen;
  const close = hhmmParts(schedule.closeTimeEt);

  const preMarketStart = easternInstant(dateIso, PRE_MARKET_START.hour, PRE_MARKET_START.minute);
  const regularOpen = easternInstant(dateIso, REGULAR_OPEN.hour, REGULAR_OPEN.minute);
  const regularClose = easternInstant(dateIso, close.hour, close.minute);
  const afterHoursEnd = easternInstant(dateIso, AFTER_HOURS_END.hour, AFTER_HOURS_END.minute);

  if (todayIsOpen && now >= preMarketStart && now < regularOpen) {
    return { state: "pre-market", label: formatCountdown(regularOpen.getTime() - now.getTime(), "opens in"), nextChangeAt: regularOpen.toISOString() };
  }
  if (todayIsOpen && now >= regularOpen && now < regularClose) {
    return { state: "open", label: formatCountdown(regularClose.getTime() - now.getTime(), "closes in"), nextChangeAt: regularClose.toISOString() };
  }
  if (todayIsOpen && now >= regularClose && now < afterHoursEnd) {
    return { state: "after-hours", label: formatCountdown(afterHoursEnd.getTime() - now.getTime(), "closes in"), nextChangeAt: afterHoursEnd.toISOString() };
  }
  if (todayIsOpen && now < preMarketStart) {
    return { state: "closed", label: formatCountdown(regularOpen.getTime() - now.getTime(), "opens in"), nextChangeAt: regularOpen.toISOString() };
  }

  const nextDateIso = await nextOpenDateAfter(dateIso);
  const nextOpen = easternInstant(nextDateIso, REGULAR_OPEN.hour, REGULAR_OPEN.minute);
  return { state: "closed", label: formatCountdown(nextOpen.getTime() - now.getTime(), "opens in"), nextChangeAt: nextOpen.toISOString() };
}

function previousCalendarDate(dateIso: string): string {
  return new Date(new Date(`${dateIso}T12:00:00Z`).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The open trading day immediately before `dateIso` (holiday- and
 * weekend-aware through market_calendar). The nightly account snapshot's
 * daily_pnl is a delta against the previous snapshot ROW; only when that row
 * is this date is it a one-session figure — see dashboard.ts's Day card.
 */
export async function previousOpenSessionDate(dateIso: string, isOpenDay: (dateIso: string) => Promise<boolean> = resolveIsOpenDay): Promise<string> {
  let candidate = previousCalendarDate(dateIso);
  for (let attempt = 0; attempt < 14; attempt++) {
    if (await isOpenDay(candidate)) return candidate;
    candidate = previousCalendarDate(candidate);
  }
  return candidate;
}

/**
 * The most recent trading session whose regular close (16:00 ET) has passed at
 * `now` — i.e. the newest date a COMPLETED daily bar can exist for. Holiday- and
 * weekend-aware through market_calendar. Before today's close (or when today is
 * not a trading day) it walks back to the previous open day. `isOpenDay` is
 * injectable so the walk-back logic can be tested without a database.
 */
/**
 * The session a live price belongs to: today from the regular open (09:30 ET) on an open day, else the last completed
 * session (before the open a live price is still the previous session's last trade). Price Performance measures every
 * live change back from it (Marcelo, 2026-10-07).
 */
export async function liveSessionDate(now: Date = new Date(), isOpenDay: (dateIso: string) => Promise<boolean> = resolveIsOpenDay): Promise<string> {
  const todayIso = easternIsoDate(now);
  if (now >= easternInstant(todayIso, REGULAR_OPEN.hour, REGULAR_OPEN.minute) && (await isOpenDay(todayIso))) return todayIso;
  return lastCompletedSessionDate(now, isOpenDay);
}

export async function lastCompletedSessionDate(
  now: Date = new Date(),
  isOpenDay: (dateIso: string) => Promise<boolean> = resolveIsOpenDay,
): Promise<string> {
  let candidate = easternIsoDate(now);
  if (now < easternInstant(candidate, REGULAR_CLOSE.hour, REGULAR_CLOSE.minute)) candidate = previousCalendarDate(candidate);
  for (let attempt = 0; attempt < 14; attempt++) {
    if (await isOpenDay(candidate)) return candidate;
    candidate = previousCalendarDate(candidate);
  }
  // A 14-day closed streak would be extraordinary; never hang a request on it.
  return candidate;
}
