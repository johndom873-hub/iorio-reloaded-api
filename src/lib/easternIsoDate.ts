import { formatDayMonth } from "./optionContractLabel.js";

const easternDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** Reading ICU is slow next to the arithmetic around it: recent answers are kept, up to this many each (then started afresh). */
const easternCacheLimit = 20_000;

/** The Eastern date changes at local midnight, a whole UTC hour (the offset is whole hours), so one reading serves its UTC hour. */
const easternIsoDateByUtcHour = new Map<number, string>();

/** Calendar date (YYYY-MM-DD) in America/New_York -- the US trading date an instant belongs to. */
export function easternIsoDate(at: Date = new Date()): string {
  const utcHour = Math.floor(at.getTime() / 3_600_000);
  const cached = easternIsoDateByUtcHour.get(utcHour);
  if (cached !== undefined) return cached;
  const dateIso = easternDateFormatter.format(at);
  if (easternIsoDateByUtcHour.size >= easternCacheLimit) easternIsoDateByUtcHour.clear();
  easternIsoDateByUtcHour.set(utcHour, dateIso);
  return dateIso;
}

// The Eastern/UTC offset (EST vs EDT), read from ICU at an instant, so no manual DST table.
const easternOffsetFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" });

/** New York's offset changes only on whole UTC hours (02:00 local, EST or EDT), so one reading serves its UTC hour. */
const easternOffsetMinutesByUtcHour = new Map<number, number>();

function easternOffsetMinutesAt(at: Date): number {
  const utcHour = Math.floor(at.getTime() / 3_600_000);
  const cached = easternOffsetMinutesByUtcHour.get(utcHour);
  if (cached !== undefined) return cached;
  const parts = easternOffsetFormatter.formatToParts(at);
  const offsetText = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
  const match = offsetText.match(/GMT([+-]\d+)/);
  const offsetMinutes = match ? Number(match[1]) * 60 : -300;
  if (easternOffsetMinutesByUtcHour.size >= easternCacheLimit) easternOffsetMinutesByUtcHour.clear();
  easternOffsetMinutesByUtcHour.set(utcHour, offsetMinutes);
  return offsetMinutes;
}

/**
 * The instant `hour:minute` on the America/New_York clock on `dateIso`. The offset is read at the target instant (a first
 * guess from that date's noon offset, then corrected once): on the two DST-change Sundays the offset differs before and
 * after 02:00 ET.
 */
export function easternInstant(dateIso: string, hour: number, minute: number): Date {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hour, minute);
  const guessMs = wallClockAsUtcMs - easternOffsetMinutesAt(new Date(`${dateIso}T12:00:00Z`)) * 60_000;
  return new Date(wallClockAsUtcMs - easternOffsetMinutesAt(new Date(guessMs)) * 60_000);
}

const easternPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

type EasternParts = { weekday: string; month: string; day: string; hour: string; minute: string };

/** The fields have no seconds and the offset changes only on whole UTC hours, so one reading serves its UTC minute. */
const easternPartsByUtcMinute = new Map<number, EasternParts>();

function easternParts(at: Date): EasternParts {
  const utcMinute = Math.floor(at.getTime() / 60_000);
  const cached = easternPartsByUtcMinute.get(utcMinute);
  if (cached) return { ...cached };
  const parts = Object.fromEntries(easternPartsFormatter.formatToParts(at).map((part) => [part.type, part.value]));
  const read: EasternParts = { weekday: parts.weekday!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
  if (easternPartsByUtcMinute.size >= easternCacheLimit) easternPartsByUtcMinute.clear();
  easternPartsByUtcMinute.set(utcMinute, read);
  return { ...read };
}

/** Minutes since midnight on the America/New_York clock, e.g. 10:06 ET = 606. */
export function easternMinutesOfDay(at: Date): number {
  const { hour, minute } = easternParts(at);
  return Number(hour) * 60 + Number(minute);
}

/** Clock time in America/New_York for alerts and digests, e.g. "10:06 ET". */
export function formatEasternTime(at: Date): string {
  const { hour, minute } = easternParts(at);
  return `${hour}:${minute} ET`;
}

/**
 * Weekday, date and clock time in America/New_York, e.g. "Fri 10-02 18:30 ET". When `omitDateOnEasternDay` is the
 * instant's own Eastern date, only the clock time is shown ("18:30 ET"): a digest's "today" lines need no date.
 */
export function formatEasternDateTime(at: Date, omitDateOnEasternDay?: string): string {
  if (omitDateOnEasternDay !== undefined && easternIsoDate(at) === omitDateOnEasternDay) return formatEasternTime(at);
  const { weekday, month, day, hour, minute } = easternParts(at);
  return `${weekday} ${month}-${day} ${hour}:${minute} ET`;
}

/** A calendar date with its weekday, e.g. "Mon 2026-10-05". The date is a plain calendar date, so no time zone applies. */
const utcWeekdayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
const weekdayOfDate = (dateIso: string): string => utcWeekdayFormatter.format(new Date(`${dateIso}T12:00:00Z`));

export function formatDateWithWeekday(dateIso: string): string {
  return `${weekdayOfDate(dateIso)} ${dateIso}`;
}

/** The same date as weekday, day and month (formatDayMonth), e.g. "Mon 2 Nov": a session named in an alert. */
export function formatWeekdayDayMonth(dateIso: string): string {
  return `${weekdayOfDate(dateIso)} ${formatDayMonth(dateIso)}`;
}

/** Weekdays after `fromIso` up to and including `toIso` (holidays not excluded), e.g. Wed 2026-10-07 → Fri 2026-10-09 = 2. */
export function weekdaysAfterUntil(fromIso: string, toIso: string): number {
  let weekdays = 0;
  const day = new Date(`${fromIso}T12:00:00Z`);
  const end = new Date(`${toIso}T12:00:00Z`);
  while (day < end) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) weekdays += 1;
  }
  return weekdays;
}

/** Calendar days from `fromIso` to `toIso` (YYYY-MM-DD), e.g. 2026-08-12 → 2027-02-16 = 188; negative when `toIso` is earlier. */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}
