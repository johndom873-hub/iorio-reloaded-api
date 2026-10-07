const easternDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** Calendar date (YYYY-MM-DD) in America/New_York -- the US trading date an instant belongs to. */
export function easternIsoDate(at: Date = new Date()): string {
  return easternDateFormatter.format(at);
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

function easternParts(at: Date): { weekday: string; month: string; day: string; hour: string; minute: string } {
  const parts = Object.fromEntries(easternPartsFormatter.formatToParts(at).map((part) => [part.type, part.value]));
  return { weekday: parts.weekday!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
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

export function formatDateWithWeekday(dateIso: string): string {
  const weekday = utcWeekdayFormatter.format(new Date(`${dateIso}T12:00:00Z`));
  return `${weekday} ${dateIso}`;
}
