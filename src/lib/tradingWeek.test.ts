import { describe, expect, it } from "vitest";
import { isLastSessionBeforeWeekend } from "./tradingWeek.js";

describe("isLastSessionBeforeWeekend", () => {
  it("is the last session before a weekend: Fridays, the Thursday before a Friday holiday, a Friday with no next session known", () => {
    expect(isLastSessionBeforeWeekend("2026-10-30", "2026-11-02")).toBe(true); // Friday → Monday
    expect(isLastSessionBeforeWeekend("2026-04-02", "2026-04-06")).toBe(true); // Thursday before Good Friday → Monday
    expect(isLastSessionBeforeWeekend("2026-05-22", "2026-05-26")).toBe(true); // Friday → Tuesday after Memorial Day
    expect(isLastSessionBeforeWeekend("2026-10-28", "2026-10-29")).toBe(false); // Wednesday → Thursday
    expect(isLastSessionBeforeWeekend("2026-11-25", "2026-11-27")).toBe(false); // Wednesday → Friday after Thanksgiving
    expect(isLastSessionBeforeWeekend("2026-10-30", undefined)).toBe(true);
    expect(isLastSessionBeforeWeekend("2026-10-29", null)).toBe(false);
  });
});
