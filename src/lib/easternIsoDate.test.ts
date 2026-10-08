import { describe, expect, it } from "vitest";
import { formatDateWithWeekday, formatEasternDateTime, formatEasternTime, weekdaysAfterUntil } from "./easternIsoDate.js";

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
