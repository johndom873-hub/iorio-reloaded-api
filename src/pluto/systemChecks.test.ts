import { describe, expect, it } from "vitest";
import { dailyLossPercent, isInsideTradingWindow } from "./systemChecks.js";

describe("isInsideTradingWindow", () => {
  const today = "2026-09-28"; // EDT, UTC-4
  it("is inside between start (inclusive) and end (exclusive) on Eastern clock time", () => {
    expect(isInsideTradingWindow(new Date("2026-09-28T14:44:59Z"), today, "10:45", "15:30")).toBe(false); // 10:44:59 ET
    expect(isInsideTradingWindow(new Date("2026-09-28T14:45:00Z"), today, "10:45", "15:30")).toBe(true); // 10:45 ET
    expect(isInsideTradingWindow(new Date("2026-09-28T19:29:59Z"), today, "10:45", "15:30")).toBe(true); // 15:29:59 ET
    expect(isInsideTradingWindow(new Date("2026-09-28T19:30:00Z"), today, "10:45", "15:30")).toBe(false); // 15:30 ET
  });
  it("follows the Eastern offset in winter", () => {
    expect(isInsideTradingWindow(new Date("2026-12-15T15:45:00Z"), "2026-12-15", "10:45", "15:30")).toBe(true); // 10:45 EST
    expect(isInsideTradingWindow(new Date("2026-12-15T14:45:00Z"), "2026-12-15", "10:45", "15:30")).toBe(false); // 09:45 EST
  });
});

describe("dailyLossPercent", () => {
  it("is today's NLV move against the previous snapshot, null when either side is missing", () => {
    expect(dailyLossPercent(980_000, 1_000_000)).toBeCloseTo(-2, 10);
    expect(dailyLossPercent(1_010_000, 1_000_000)).toBeCloseTo(1, 10);
    expect(dailyLossPercent(null, 1_000_000)).toBeNull();
    expect(dailyLossPercent(980_000, null)).toBeNull();
    expect(dailyLossPercent(980_000, 0)).toBeNull();
  });
});
