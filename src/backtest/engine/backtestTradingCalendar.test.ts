import { describe, expect, it } from "vitest";
import { varianceSessionsToExpiry } from "../../lib/varianceClock.js";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { BacktestTradingCalendar, nyseEarlyCloseDatesIso2016To2026 } from "./backtestTradingCalendar.js";

// The file's days around Thanksgiving 2024: Thursday the 28th is a holiday (no data), Friday the 29th closes at 13:00.
const calendar = new BacktestTradingCalendar(
  [
    { tradingDate: "2024-11-25", status: "complete" },
    { tradingDate: "2024-11-26", status: "complete" },
    { tradingDate: "2024-11-27", status: "complete" },
    { tradingDate: "2024-11-28", status: "no_data" },
    { tradingDate: "2024-11-29", status: "complete" },
  ],
  [
    { dateIso: "2024-12-02", isOpen: true, closeTime: null },
    { dateIso: "2024-12-25", isOpen: false, closeTime: null },
  ],
);

describe("BacktestTradingCalendar", () => {
  it("reads sessions and half days from the file, and weekdays or the market calendar after it", () => {
    expect(calendar.sessionsBetween("2024-11-27", "2024-12-03")).toEqual([
      { dateIso: "2024-11-27", closeMinutesEt: 960 },
      { dateIso: "2024-11-29", closeMinutesEt: 780 },
      { dateIso: "2024-12-02", closeMinutesEt: 960 },
      { dateIso: "2024-12-03", closeMinutesEt: 960 },
    ]);
    expect(calendar.openDaysBetween("2024-12-23", "2024-12-27")).toEqual(["2024-12-23", "2024-12-24", "2024-12-26", "2024-12-27"]);
    expect(calendar.sessionsBetween("2024-12-24", "2024-12-24")).toEqual([{ dateIso: "2024-12-24", closeMinutesEt: 780 }]);
  });

  it("tells a session from a closed day, and finds the session before a closed day (where its expiries settle)", () => {
    expect(calendar.isSession("2024-11-27")).toBe(true);
    expect(calendar.isSession("2024-11-28")).toBe(false);
    expect(calendar.sessionBefore("2024-11-28")).toBe("2024-11-27");
    // Over a weekend, and after the file: the market calendar's closed Christmas, then the Monday before it.
    expect(calendar.sessionBefore("2024-12-02")).toBe("2024-11-29");
    expect(calendar.isSession("2024-12-25")).toBe(false);
    expect(calendar.sessionBefore("2024-12-25")).toBe("2024-12-24");
  });

  it("puts the variance clock on those sessions: from Wednesday 10:00 to the Friday half day", () => {
    const tau = varianceSessionsToExpiry(easternInstant("2024-11-27", 10, 0).getTime(), "2024-11-29", calendar.sessionsBetween("2024-11-27", "2024-11-29"));
    // rest of Wednesday 0.309 + a half day 0.704 (Thursday is no session)
    expect(tau).toBeCloseTo(0.309 + 0.412 + 0.496 * 0.588, 6);
  });

  it("lists only weekday early closes, none on an observed holiday", () => {
    for (const dateIso of nyseEarlyCloseDatesIso2016To2026) {
      const weekday = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
      expect(weekday >= 1 && weekday <= 5).toBe(true);
    }
    expect(nyseEarlyCloseDatesIso2016To2026).not.toContain("2020-07-03");
    expect(nyseEarlyCloseDatesIso2016To2026).not.toContain("2021-12-24");
  });
});
