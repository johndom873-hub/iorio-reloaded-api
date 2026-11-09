import { describe, expect, it } from "vitest";
import { nextWeekdayIso, parseSettledCashByDate, settledCashForTradesPlacedOn } from "./fetchSettledCashByDate.js";

// The live account's value as IBKR sent it on 2026-11-09 (probe), after the $1,050,003.70 transfer.
const liveValue = "20261108:1927.12;20261109:216.5;20261110:1050216.5";

describe("settled cash by date (live account, 2026-11-09)", () => {
  it("reads IBKR's dated amounts in date order", () => {
    expect(parseSettledCashByDate(liveValue)).toEqual([
      { dateIso: "2026-11-08", amount: 1927.12 },
      { dateIso: "2026-11-09", amount: 216.5 },
      { dateIso: "2026-11-10", amount: 1050216.5 },
    ]);
    expect(parseSettledCashByDate("")).toEqual([]);
    expect(parseSettledCashByDate("20261109:216.5;junk;2026111:5")).toEqual([{ dateIso: "2026-11-09", amount: 216.5 }]);
  });

  it("the next weekday is the settlement day (T+1)", () => {
    expect(nextWeekdayIso("2026-11-09")).toBe("2026-11-10");
    expect(nextWeekdayIso("2026-11-13")).toBe("2026-11-16");
    expect(nextWeekdayIso("2026-11-14")).toBe("2026-11-16");
  });

  it("today's trades draw on the cash settled on their settlement day", () => {
    expect(settledCashForTradesPlacedOn(parseSettledCashByDate(liveValue), "2026-11-09")).toBe(1050216.5);
  });

  it("with no entry on the settlement day, the latest one before it", () => {
    expect(settledCashForTradesPlacedOn(parseSettledCashByDate("20261108:1927.12;20261109:216.5"), "2026-11-09")).toBe(216.5);
    // Friday: Saturday's and Monday's entries are both on or before Monday; Monday's counts.
    expect(settledCashForTradesPlacedOn(parseSettledCashByDate("20261113:10;20261114:20;20261116:30;20261117:40"), "2026-11-13")).toBe(30);
  });

  it("none dated on or before the settlement day: unknown", () => {
    expect(settledCashForTradesPlacedOn(parseSettledCashByDate("20261111:5"), "2026-11-09")).toBeNull();
    expect(settledCashForTradesPlacedOn([], "2026-11-09")).toBeNull();
  });
});
