const easternDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** Calendar date (YYYY-MM-DD) in America/New_York -- the US trading date an instant belongs to. */
export function easternIsoDate(at: Date = new Date()): string {
  return easternDateFormatter.format(at);
}
