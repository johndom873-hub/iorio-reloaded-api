import { afterEach, describe, expect, it, vi } from "vitest";
import { easternInstant, easternIsoDate, easternMinutesOfDay, formatEasternDateTime, formatEasternTime, formatDateWithWeekday } from "./easternIsoDate.js";

// Audit F (2026-10-07): easternDateIso (marketSessionStatus.ts) was removed and its callers moved to easternIsoDate.
// These pin the replacement to the removed implementation, and pin the moved easternInstant / new easternMinutesOfDay.

// The removed implementations, verbatim apart from the name (a per-call formatter is fine in a test).
function removedEasternDateIso(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
function removedPassRunnerEasternMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}
function removedTodayInEasternIso(at: Date): string {
  return at.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

const utc = (iso: string) => new Date(iso);

afterEach(() => {
  vi.useRealTimers();
});

describe("easternIsoDate equals the removed easternDateIso", () => {
  it("for every 20 minutes of 2026 (both DST transitions included)", () => {
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2027, 0, 2);
    for (let at = start; at < end; at += 20 * 60_000) {
      const instant = new Date(at);
      const expected = removedEasternDateIso(instant);
      const actual = easternIsoDate(instant);
      if (actual !== expected) throw new Error(`${instant.toISOString()}: ${actual} != ${expected}`);
      if (actual !== removedTodayInEasternIso(instant)) throw new Error(`${instant.toISOString()}: ${actual} != toLocaleDateString`);
    }
  });

  it("always has the YYYY-MM-DD shape the SQL `trading_date` comparisons and string `<` comparisons rely on", () => {
    for (const iso of ["2026-01-01T04:59:59.999Z", "2026-01-01T05:00:00Z", "2026-12-31T23:30:00Z", "2030-06-15T12:00:00Z", "2001-09-09T01:46:40Z"]) {
      expect(easternIsoDate(utc(iso))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("flips the date at Eastern midnight, not UTC midnight, in EST and in EDT", () => {
    // EST (UTC-5): 00:00 ET = 05:00Z
    expect(easternIsoDate(utc("2026-01-05T04:59:59.999Z"))).toBe("2026-01-04");
    expect(easternIsoDate(utc("2026-01-05T05:00:00Z"))).toBe("2026-01-05");
    // EDT (UTC-4): 00:00 ET = 04:00Z
    expect(easternIsoDate(utc("2026-07-06T03:59:59.999Z"))).toBe("2026-07-05");
    expect(easternIsoDate(utc("2026-07-06T04:00:00Z"))).toBe("2026-07-06");
    // 20:00 ET is already the next UTC day
    expect(easternIsoDate(utc("2026-10-08T00:30:00Z"))).toBe("2026-10-07");
  });

  it("around both 2026 DST transitions", () => {
    // Spring forward 2026-03-08 02:00 EST -> 03:00 EDT (07:00Z)
    expect(easternIsoDate(utc("2026-03-08T04:59:59Z"))).toBe("2026-03-07");
    expect(easternIsoDate(utc("2026-03-08T05:00:00Z"))).toBe("2026-03-08");
    expect(easternIsoDate(utc("2026-03-09T03:59:59Z"))).toBe("2026-03-08");
    expect(easternIsoDate(utc("2026-03-09T04:00:00Z"))).toBe("2026-03-09");
    // Fall back 2026-11-01 02:00 EDT -> 01:00 EST (06:00Z)
    expect(easternIsoDate(utc("2026-11-01T03:59:59Z"))).toBe("2026-10-31");
    expect(easternIsoDate(utc("2026-11-01T04:00:00Z"))).toBe("2026-11-01");
    expect(easternIsoDate(utc("2026-11-02T04:59:59Z"))).toBe("2026-11-01");
    expect(easternIsoDate(utc("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
  });

  it("defaults to the current time (positionSuccessProbability calls it with no argument)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(utc("2026-11-02T04:30:00Z")); // 23:30 EST on 11-01
    expect(easternIsoDate()).toBe("2026-11-01");
    expect(easternIsoDate(undefined)).toBe("2026-11-01");
    vi.setSystemTime(utc("2026-03-09T04:00:00Z")); // 00:00 EDT on 03-09
    expect(easternIsoDate()).toBe("2026-03-09");
  });

  it("rejects an invalid Date the same way the removed helper did", () => {
    expect(() => removedEasternDateIso(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => easternIsoDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("easternMinutesOfDay equals passRunner's removed copy", () => {
  it("for every minute across both DST transition days and an ordinary day", () => {
    for (const day of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-10-31", "2026-11-01", "2026-11-02", "2026-10-07"]) {
      const start = Date.parse(`${day}T00:00:00Z`);
      for (let at = start; at < start + 86_400_000; at += 60_000) {
        const instant = new Date(at);
        const expected = removedPassRunnerEasternMinutesOfDay(instant);
        const actual = easternMinutesOfDay(instant);
        if (actual !== expected) throw new Error(`${instant.toISOString()}: ${actual} != ${expected}`);
      }
    }
  });

  it("is 0 at Eastern midnight (never 1440) and 1439 at 23:59", () => {
    expect(easternMinutesOfDay(utc("2026-10-07T04:00:00Z"))).toBe(0);
    expect(easternMinutesOfDay(utc("2026-01-07T05:00:00Z"))).toBe(0);
    expect(easternMinutesOfDay(utc("2026-10-08T03:59:00Z"))).toBe(1439);
    expect(easternMinutesOfDay(utc("2026-10-07T14:06:00Z"))).toBe(606);
  });

  it("follows the wall clock through the DST jumps", () => {
    expect(easternMinutesOfDay(utc("2026-03-08T06:59:00Z"))).toBe(1 * 60 + 59); // 01:59 EST
    expect(easternMinutesOfDay(utc("2026-03-08T07:00:00Z"))).toBe(3 * 60); // 03:00 EDT
    expect(easternMinutesOfDay(utc("2026-11-01T05:30:00Z"))).toBe(1 * 60 + 30); // 01:30 EDT
    expect(easternMinutesOfDay(utc("2026-11-01T06:30:00Z"))).toBe(1 * 60 + 30); // 01:30 EST, again
  });
});

describe("easternInstant", () => {
  const datesOf2026 = Array.from({ length: 365 }, (_, index) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10));

  it("round-trips through easternIsoDate / easternMinutesOfDay for every 2026 day at every quarter hour from 03:00 to 23:45", () => {
    for (const dateIso of datesOf2026) {
      for (let minutes = 3 * 60; minutes < 24 * 60; minutes += 15) {
        const instant = easternInstant(dateIso, Math.floor(minutes / 60), minutes % 60);
        if (easternIsoDate(instant) !== dateIso || easternMinutesOfDay(instant) !== minutes) {
          throw new Error(`${dateIso} ${minutes}: got ${instant.toISOString()} (${easternIsoDate(instant)} ${easternMinutesOfDay(instant)})`);
        }
      }
    }
  });

  it("places the session times correctly on the Mondays after both transitions", () => {
    expect(easternInstant("2026-03-06", 9, 30).toISOString()).toBe("2026-03-06T14:30:00.000Z");
    expect(easternInstant("2026-03-09", 9, 30).toISOString()).toBe("2026-03-09T13:30:00.000Z");
    expect(easternInstant("2026-10-30", 16, 0).toISOString()).toBe("2026-10-30T20:00:00.000Z");
    expect(easternInstant("2026-11-02", 16, 0).toISOString()).toBe("2026-11-02T21:00:00.000Z");
  });

  // Pre-existing (moved here unchanged today): the offset is taken at 12:00Z of the date, i.e. AFTER the 02:00 ET switch, so
  // wall-clock times before the switch on a transition day get the wrong offset. easternDayStart(now) on those two Sundays is an
  // hour off. Both are Sundays, so no trading code reaches it today; flexCashFlowAssignment / easternDayStart could.
  it("gives Eastern midnight on the spring-forward day (00:00 EST = 05:00Z)", () => {
    expect(easternInstant("2026-03-08", 0, 0).toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });
  it("gives Eastern midnight on the fall-back day (00:00 EDT = 04:00Z)", () => {
    expect(easternInstant("2026-11-01", 0, 0).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("the other cached formatters keep their output", () => {
  it("formatEasternTime / formatEasternDateTime at midnight and across DST", () => {
    expect(formatEasternTime(utc("2026-10-07T04:00:00Z"))).toBe("00:00 ET");
    expect(formatEasternTime(utc("2026-11-01T06:30:00Z"))).toBe("01:30 ET");
    expect(formatEasternDateTime(utc("2026-10-02T22:30:00Z"))).toBe("Fri 10-02 18:30 ET");
    expect(formatEasternDateTime(utc("2026-10-03T00:30:00Z"), "2026-10-02")).toBe("20:30 ET");
    expect(formatEasternDateTime(utc("2026-10-03T00:30:00Z"), "2026-10-03")).toBe("Fri 10-02 20:30 ET");
  });

  it("formatDateWithWeekday is the calendar weekday whatever the process time zone", () => {
    expect(formatDateWithWeekday("2026-10-05")).toBe("Mon 2026-10-05");
    expect(formatDateWithWeekday("2026-03-08")).toBe("Sun 2026-03-08");
    expect(formatDateWithWeekday("2026-11-01")).toBe("Sun 2026-11-01");
  });
});
