import { db } from "../db/connection.js";

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
}

export function easternDateIso(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    instant,
  );
}

// The Eastern/UTC offset varies by date (EST vs EDT) but not within a single
// calendar date, so deriving it from a fixed UTC-noon instant on that date —
// always the same ET calendar day regardless of the offset — and applying it
// to any wall-clock time on that date is exact, with no manual DST table.
function easternOffsetMinutes(dateIso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(
    new Date(`${dateIso}T12:00:00Z`),
  );
  const offsetText = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
  const match = offsetText.match(/GMT([+-]\d+)/);
  return match ? Number(match[1]) * 60 : -300;
}

function easternInstant(dateIso: string, hour: number, minute: number): Date {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  const utcMinutesSinceMidnight = hour * 60 + minute - easternOffsetMinutes(dateIso);
  return new Date(Date.UTC(year, month - 1, day, 0, utcMinutesSinceMidnight));
}

function isWeekday(dateIso: string): boolean {
  const day = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

// market_calendar (synced from MarketData.app, see scripts/sync-market-calendar.ts)
// covers ~400 days forward as of its last sync — falls back to a plain
// weekday check for any date outside that coverage rather than failing.
async function resolveIsOpenDay(dateIso: string): Promise<boolean> {
  const row = await db("market_calendar").where({ calendar_date: dateIso }).first();
  if (row) return row.is_open;
  return isWeekday(dateIso);
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
  const dateIso = easternDateIso(now);
  const todayIsOpen = await resolveIsOpenDay(dateIso);

  const preMarketStart = easternInstant(dateIso, PRE_MARKET_START.hour, PRE_MARKET_START.minute);
  const regularOpen = easternInstant(dateIso, REGULAR_OPEN.hour, REGULAR_OPEN.minute);
  const regularClose = easternInstant(dateIso, REGULAR_CLOSE.hour, REGULAR_CLOSE.minute);
  const afterHoursEnd = easternInstant(dateIso, AFTER_HOURS_END.hour, AFTER_HOURS_END.minute);

  if (todayIsOpen && now >= preMarketStart && now < regularOpen) {
    return { state: "pre-market", label: formatCountdown(regularOpen.getTime() - now.getTime(), "opens in") };
  }
  if (todayIsOpen && now >= regularOpen && now < regularClose) {
    return { state: "open", label: formatCountdown(regularClose.getTime() - now.getTime(), "closes in") };
  }
  if (todayIsOpen && now >= regularClose && now < afterHoursEnd) {
    return { state: "after-hours", label: formatCountdown(afterHoursEnd.getTime() - now.getTime(), "closes in") };
  }
  if (todayIsOpen && now < preMarketStart) {
    return { state: "closed", label: formatCountdown(regularOpen.getTime() - now.getTime(), "opens in") };
  }

  const nextDateIso = await nextOpenDateAfter(dateIso);
  const nextOpen = easternInstant(nextDateIso, REGULAR_OPEN.hour, REGULAR_OPEN.minute);
  return { state: "closed", label: formatCountdown(nextOpen.getTime() - now.getTime(), "opens in") };
}
