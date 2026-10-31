import { describe, expect, it } from "vitest";
import { calendarDaysBetween, easternInstant, easternIsoDate, easternMinutesOfDay, formatDateWithWeekday, formatEasternDateTime, formatEasternTime, formatWeekdayDayMonth, weekdaysAfterUntil } from "./easternIsoDate.js";

describe("Eastern time formatting", () => {
  it("shows summer clock time (EDT, UTC-4)", () => {
    expect(formatEasternTime(new Date("2026-10-05T14:06:00Z"))).toBe("10:06 ET");
  });

  it("shows winter clock time (EST, UTC-5)", () => {
    expect(formatEasternTime(new Date("2026-11-02T15:00:00Z"))).toBe("10:00 ET");
  });

  it("never renders hour 24 at Eastern midnight", () => {
    expect(formatEasternTime(new Date("2026-10-06T04:00:00Z"))).toBe("00:00 ET");
  });

  it("adds weekday and date, using the Eastern calendar day rather than the UTC one", () => {
    // 2026-10-03 02:30 UTC is still Friday 22:30 in New York.
    expect(formatEasternDateTime(new Date("2026-10-03T02:30:00Z"))).toBe("Fri 10-02 22:30 ET");
  });

  it("omits the date for an instant on the given Eastern day only", () => {
    expect(formatEasternDateTime(new Date("2026-10-05T14:06:00Z"), "2026-10-05")).toBe("10:06 ET");
    expect(formatEasternDateTime(new Date("2026-10-03T02:30:00Z"), "2026-10-05")).toBe("Fri 10-02 22:30 ET");
  });

  it("puts the weekday on a plain calendar date", () => {
    expect(formatDateWithWeekday("2026-10-05")).toBe("Mon 2026-10-05");
    expect(formatWeekdayDayMonth("2026-11-02")).toBe("Mon 2 Nov");
  });
});

describe("weekdaysAfterUntil", () => {
  it("counts the weekdays after the first date up to and including the second", () => {
    expect(weekdaysAfterUntil("2026-10-07", "2026-10-09")).toBe(2); // Wed → Fri
    expect(weekdaysAfterUntil("2026-10-09", "2026-10-12")).toBe(1); // Fri → Mon
    expect(weekdaysAfterUntil("2026-10-07", "2026-10-07")).toBe(0);
    expect(weekdaysAfterUntil("2026-10-07", "2026-11-06")).toBe(22);
  });
});

describe("the kept ICU readings answer as ICU does", () => {
  // Offsets, dates and clock fields are kept per UTC hour or minute: across both 2024 clock changes, every answer must
  // be what a fresh ICU reading gives.
  const zone = { timeZone: "America/New_York" } as const;
  const freshDate = new Intl.DateTimeFormat("en-CA", zone);
  const freshClock = new Intl.DateTimeFormat("en-US", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const freshOffsetMinutes = (at: Date) => Number(new Intl.DateTimeFormat("en-US", { ...zone, timeZoneName: "shortOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")!.value.match(/GMT([+-]\d+)/)![1]) * 60;
  const freshInstant = (dateIso: string, hour: number, minute: number) => {
    const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
    const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hour, minute);
    const guessMs = wallClockAsUtcMs - freshOffsetMinutes(new Date(`${dateIso}T12:00:00Z`)) * 60_000;
    return new Date(wallClockAsUtcMs - freshOffsetMinutes(new Date(guessMs)) * 60_000).getTime();
  };

  it.each([["2024-03-09T00:00:00Z"], ["2024-11-02T00:00:00Z"]])("every 7 minutes for three days from %s", (startIso) => {
    for (let at = Date.parse(startIso); at < Date.parse(startIso) + 3 * 86_400_000; at += 7 * 60_000) {
      const instant = new Date(at);
      expect(easternIsoDate(instant)).toBe(freshDate.format(instant));
      expect(formatEasternTime(instant)).toBe(`${freshClock.format(instant)} ET`);
      expect(easternMinutesOfDay(instant)).toBe(Number(freshClock.format(instant).slice(0, 2)) * 60 + Number(freshClock.format(instant).slice(3)));
    }
    for (const dateIso of ["2024-03-09", "2024-03-10", "2024-03-11", "2024-11-02", "2024-11-03", "2024-11-04"]) {
      for (let minutes = 0; minutes < 24 * 60; minutes += 30) expect(easternInstant(dateIso, Math.floor(minutes / 60), minutes % 60).getTime()).toBe(freshInstant(dateIso, Math.floor(minutes / 60), minutes % 60));
    }
  });
});

describe("calendarDaysBetween", () => {
  it("counts calendar days across a DST change and a year end, negative backwards", () => {
    expect(calendarDaysBetween("2026-08-12", "2027-02-16")).toBe(188);
    expect(calendarDaysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(calendarDaysBetween("2026-10-27", "2026-10-27")).toBe(0);
    expect(calendarDaysBetween("2026-10-27", "2026-10-26")).toBe(-1);
  });
});
