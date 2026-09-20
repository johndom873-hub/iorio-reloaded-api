import { describe, expect, it } from "vitest";
import { lastCompletedSessionDate } from "./marketSessionStatus.js";

// A stand-in for the market_calendar table: weekdays are open except the listed holidays.
function calendarWithHolidays(holidays: string[]) {
  return async (dateIso: string) => {
    const weekday = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5 && !holidays.includes(dateIso);
  };
}

describe("lastCompletedSessionDate", () => {
  const isOpenDay = calendarWithHolidays(["2026-09-07"]); // Labor Day

  it("after the 16:00 ET close, today's session is complete (EDT: 16:00 ET = 20:00Z)", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-09-18T20:00:00Z"), isOpenDay)).toBe("2026-09-18"); // exactly at the close
    expect(await lastCompletedSessionDate(new Date("2026-09-18T21:30:00Z"), isOpenDay)).toBe("2026-09-18");
  });

  it("before the close, today's bar is still partial, so the previous session is the newest complete one", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-09-18T19:59:00Z"), isOpenDay)).toBe("2026-09-17");
    expect(await lastCompletedSessionDate(new Date("2026-09-18T13:31:00Z"), isOpenDay)).toBe("2026-09-17"); // just after the open
  });

  it("on a weekend it is Friday's session", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-09-19T15:00:00Z"), isOpenDay)).toBe("2026-09-18"); // Saturday
    expect(await lastCompletedSessionDate(new Date("2026-09-20T23:00:00Z"), isOpenDay)).toBe("2026-09-18"); // Sunday evening
  });

  it("walks back over a market holiday and the weekend before it", async () => {
    // Tuesday morning after Labor Day Monday: Monday is closed, so Friday 09-04.
    expect(await lastCompletedSessionDate(new Date("2026-09-08T12:00:00Z"), isOpenDay)).toBe("2026-09-04");
    // Monday (the holiday) itself, even after 16:00 ET.
    expect(await lastCompletedSessionDate(new Date("2026-09-07T21:00:00Z"), isOpenDay)).toBe("2026-09-04");
  });

  it("uses the right offset across the DST change (EST: 16:00 ET = 21:00Z)", async () => {
    // 2026-11-02 is a Monday after DST ended on Sunday 11-01.
    expect(await lastCompletedSessionDate(new Date("2026-11-02T20:30:00Z"), isOpenDay)).toBe("2026-10-30"); // 15:30 EST: before the close
    expect(await lastCompletedSessionDate(new Date("2026-11-02T21:00:00Z"), isOpenDay)).toBe("2026-11-02"); // 16:00 EST: closed
  });

  it("does not loop forever if the calendar says everything is closed", async () => {
    const result = await lastCompletedSessionDate(new Date("2026-09-18T21:00:00Z"), async () => false);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
