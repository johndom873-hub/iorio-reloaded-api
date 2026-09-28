import { describe, expect, it } from "vitest";
import { earlyCloseDatesIso, effectiveWindowEndEt } from "./sessionSchedule.js";

describe("effectiveWindowEndEt", () => {
  it("keeps the configured end on a full day and pulls it to 30 min before an early close", () => {
    expect(effectiveWindowEndEt("15:30", "16:00")).toBe("15:30");
    expect(effectiveWindowEndEt("15:00", "16:00")).toBe("15:00");
    expect(effectiveWindowEndEt("15:30", "13:00")).toBe("12:30");
    expect(effectiveWindowEndEt("12:00", "13:00")).toBe("12:00");
  });
});

describe("early-close fallback list", () => {
  it("knows the day after Thanksgiving and Christmas Eve", () => {
    expect(earlyCloseDatesIso.has("2026-11-27")).toBe(true);
    expect(earlyCloseDatesIso.has("2026-12-24")).toBe(true);
    expect(earlyCloseDatesIso.has("2026-09-28")).toBe(false);
  });
});
