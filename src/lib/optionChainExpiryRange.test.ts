import { describe, expect, it } from "vitest";
import { calendarDaysUntilExpiry } from "./optionChainExpiryRange.js";

describe("calendarDaysUntilExpiry", () => {
  it("is 0 for today, counts across a DST change, and is negative for the past", () => {
    expect(calendarDaysUntilExpiry("2026-09-21", "20260921")).toBe(0);
    expect(calendarDaysUntilExpiry("2026-09-21", "20260925")).toBe(4);
    expect(calendarDaysUntilExpiry("2026-10-30", "20261106")).toBe(7);
    expect(calendarDaysUntilExpiry("2026-09-21", "20261220")).toBe(90);
    expect(calendarDaysUntilExpiry("2026-09-21", "20260918")).toBe(-3);
  });
});
