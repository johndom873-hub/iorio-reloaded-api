import { describe, expect, it } from "vitest";
import { parseMarketStatus } from "./marketStatusParsing.js";

const seconds = (dateIso: string) => Date.parse(`${dateIso}T05:00:00Z`) / 1000;

describe("parseMarketStatus", () => {
  it("splits open, closed and not-yet-published dates", () => {
    const parsed = parseMarketStatus([seconds("2026-09-30"), seconds("2026-10-03"), seconds("2027-09-07")], ["open", "closed", null], "2026-09-30");
    expect(parsed.knownDays).toEqual([
      { calendarDate: "2026-09-30", isOpen: true },
      { calendarDate: "2026-10-03", isOpen: false },
    ]);
    expect(parsed.unknownDates).toEqual(["2027-09-07"]);
  });

  it("rejects any other status instead of storing it as closed", () => {
    expect(() => parseMarketStatus([seconds("2026-09-30"), seconds("2026-10-01")], ["open", "Open"], "2026-09-30")).toThrow('unexpected market status "Open" for 2026-10-01');
  });

  it("rejects a response with mismatched or empty arrays", () => {
    expect(() => parseMarketStatus([seconds("2026-09-30")], [], "2026-09-30")).toThrow("1 dates but 0 statuses");
    expect(() => parseMarketStatus([], [], "2026-09-30")).toThrow("no dates");
  });

  it("requires a definite status for today", () => {
    expect(() => parseMarketStatus([seconds("2026-10-01")], ["open"], "2026-09-30")).toThrow("no open/closed status for today");
    // A null for today is caught by the near-term check even before the "today must be definite" check.
    expect(() => parseMarketStatus([seconds("2026-09-30")], [null], "2026-09-30")).toThrow("only 0 day(s) from today");
  });

  it("rejects a null status for a near-term date instead of deleting that day (a holiday must never become an open weekday)", () => {
    expect(() => parseMarketStatus([seconds("2026-09-30"), seconds("2026-11-26")], ["open", null], "2026-09-30")).toThrow("only 57 day(s) from today");
    expect(() => parseMarketStatus([seconds("2026-09-30"), seconds("2026-12-29")], ["open", null], "2026-09-30")).not.toThrow();
  });
});
