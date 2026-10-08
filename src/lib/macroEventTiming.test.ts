import { describe, expect, it } from "vitest";
import { easternInstant } from "./easternIsoDate.js";
import { eventStressNormalDaysByWeight, heaviestMacroEventBeforeExpiry, macroEventWeight, reactionSessionIso } from "./macroEventTiming.js";
import { openDaysFromCalendarRows } from "./marketSessionStatus.js";

const at = (dateIso: string, hour: number, minute = 0) => easternInstant(dateIso, hour, minute).toISOString();

// The calendar of the proposal (Thu 2026-10-08): CPI Wed 10-14 08:30, Fed Wed 10-28 14:00, GDP Thu 10-29 08:30, midterms Tue 11-03 19:00.
const events = [
  { title: "CPI", eventAtIso: at("2026-10-14", 8, 30) },
  { title: "Fed rate decision", eventAtIso: at("2026-10-28", 14) },
  { title: "GDP", eventAtIso: at("2026-10-29", 8, 30) },
  { title: "US midterm elections", eventAtIso: at("2026-11-03", 19) },
];
const openDaysIso = openDaysFromCalendarRows("2026-10-08", "2026-11-20", []);
const nowMs = Date.parse(at("2026-10-08", 10, 30));
const describeFor = (expiryIso: string, overrides: Partial<Parameters<typeof heaviestMacroEventBeforeExpiry>[0]> = {}) =>
  heaviestMacroEventBeforeExpiry({ events, nowMs, todayIso: "2026-10-08", expiryIso, openDaysIso, ...overrides });

describe("macro event weights", () => {
  it("heavy the Fed, CPI and the presidential election; medium the midterms; light GDP; an unknown title is heavy", () => {
    expect(["Fed rate decision", "CPI", "US presidential election", "US midterm elections", "GDP", "Something new"].map(macroEventWeight)).toEqual(["heavy", "heavy", "heavy", "medium", "light", "heavy"]);
    expect(eventStressNormalDaysByWeight).toEqual({ heavy: 2, medium: 1, light: 0.5 });
  });
});

describe("reactionSessionIso", () => {
  it("a release before the close moves prices that day; one after the close, the next open day", () => {
    expect(reactionSessionIso(Date.parse(at("2026-10-14", 8, 30)), openDaysIso)).toBe("2026-10-14");
    expect(reactionSessionIso(Date.parse(at("2026-11-03", 19)), openDaysIso)).toBe("2026-11-04");
    // Friday after the close → Monday.
    expect(reactionSessionIso(Date.parse(at("2026-10-09", 16, 30)), openDaysIso)).toBe("2026-10-12");
  });
  it("skips a holiday the calendar marks closed", () => {
    const withHoliday = openDaysFromCalendarRows("2026-10-08", "2026-10-20", [{ dateIso: "2026-10-12", isOpen: false }]);
    expect(withHoliday).not.toContain("2026-10-12");
    expect(reactionSessionIso(Date.parse(at("2026-10-09", 18)), withHoliday)).toBe("2026-10-13");
  });
});

describe("heaviestMacroEventBeforeExpiry (F1)", () => {
  it("the proposal's first example: a Fri 10-16 put has CPI 4 sessions away and 3 sessions after it", () => {
    expect(describeFor("2026-10-16")).toEqual({ title: "CPI", weight: "heavy", dateIso: "2026-10-14", sessionIso: "2026-10-14", sessionsUntil: 4, sessionsAfter: 3 });
  });
  it("the proposal's second example: a Fri 10-30 put spans CPI, the Fed and GDP; the Fed wins the heavy tie on fewer sessions after", () => {
    expect(describeFor("2026-10-30")).toMatchObject({ title: "Fed rate decision", sessionsUntil: 14, sessionsAfter: 3 });
  });
  it("nothing before expiry, or the release already out, is null", () => {
    expect(describeFor("2026-10-13")).toBeNull();
    expect(describeFor("2026-10-16", { nowMs: Date.parse(at("2026-10-14", 9)) })).toBeNull();
  });
  it("a release still ahead today is 0 sessions away; the expiry day counts after it", () => {
    expect(describeFor("2026-10-14", { nowMs: Date.parse(at("2026-10-14", 7)), todayIso: "2026-10-14" })).toMatchObject({ title: "CPI", sessionsUntil: 0, sessionsAfter: 1 });
  });
  it("an after-close release on the expiry date is not in the contract's life; the day before, it reacts on expiry day", () => {
    expect(describeFor("2026-11-03")?.title).not.toBe("US midterm elections");
    expect(describeFor("2026-11-04", { events: [events[3]!] })).toMatchObject({ title: "US midterm elections", weight: "medium", sessionIso: "2026-11-04", sessionsAfter: 1 });
  });
  it("a heavier release beats a lighter one with fewer sessions after it", () => {
    expect(describeFor("2026-10-29", { events: [events[0]!, events[2]!] })).toMatchObject({ title: "CPI" });
  });
});
