import { describe, expect, it } from "vitest";
import { isWithinChainCaptureClockWindow } from "./optionChainCaptureClock.js";

const at = (isoUtc: string) => new Date(isoUtc);

describe("isWithinChainCaptureClockWindow", () => {
  it("is 14:00–14:30 UTC during daylight time (EDT, 10:00–10:30 ET)", () => {
    expect(isWithinChainCaptureClockWindow(at("2026-09-21T13:59:59Z"))).toBe(false);
    expect(isWithinChainCaptureClockWindow(at("2026-09-21T14:00:00Z"))).toBe(true);
    expect(isWithinChainCaptureClockWindow(at("2026-09-21T14:29:59Z"))).toBe(true);
    expect(isWithinChainCaptureClockWindow(at("2026-09-21T14:30:00Z"))).toBe(false);
  });

  it("is 15:00–15:30 UTC during standard time (EST, 10:00–10:30 ET)", () => {
    expect(isWithinChainCaptureClockWindow(at("2026-12-01T14:59:59Z"))).toBe(false);
    expect(isWithinChainCaptureClockWindow(at("2026-12-01T15:00:00Z"))).toBe(true);
    expect(isWithinChainCaptureClockWindow(at("2026-12-01T15:29:59Z"))).toBe(true);
    expect(isWithinChainCaptureClockWindow(at("2026-12-01T15:30:00Z"))).toBe(false);
  });

  it("rejects the wrong Scheduler slot for the season (14:00 UTC in winter is 9:00 ET; 15:00 UTC in summer is 11:00 ET)", () => {
    expect(isWithinChainCaptureClockWindow(at("2026-12-01T14:00:00Z"))).toBe(false);
    expect(isWithinChainCaptureClockWindow(at("2026-09-21T15:00:00Z"))).toBe(false);
  });

  it("handles the daylight-saving switch days themselves (2026-03-08 spring forward, 2026-11-01 fall back)", () => {
    // Spring forward: the switch happens at 07:00 UTC, before 10:00 ET, so that day's window is already EDT.
    expect(isWithinChainCaptureClockWindow(at("2026-03-08T14:00:00Z"))).toBe(true);
    expect(isWithinChainCaptureClockWindow(at("2026-03-08T15:00:00Z"))).toBe(false);
    // Fall back: the switch happens at 06:00 UTC, before 10:00 ET, so that day's window is already EST.
    expect(isWithinChainCaptureClockWindow(at("2026-11-01T14:00:00Z"))).toBe(false);
    expect(isWithinChainCaptureClockWindow(at("2026-11-01T15:00:00Z"))).toBe(true);
  });

  it("gives exactly one of the two Scheduler slots (14:00 and 15:00 UTC) the real run on every day of 2026 and 2027, even with a 2-minute start delay", () => {
    const startDelayMs = 2 * 60 * 1000;
    const dayMs = 24 * 60 * 60 * 1000;
    const firstDay = Date.UTC(2026, 0, 1);
    for (let dayOffset = 0; dayOffset < 730; dayOffset++) {
      const midnightUtc = firstDay + dayOffset * dayMs;
      const earlySlotRuns = isWithinChainCaptureClockWindow(new Date(midnightUtc + 14 * 3_600_000 + startDelayMs));
      const lateSlotRuns = isWithinChainCaptureClockWindow(new Date(midnightUtc + 15 * 3_600_000 + startDelayMs));
      expect(earlySlotRuns !== lateSlotRuns, `day offset ${dayOffset} (${new Date(midnightUtc).toISOString().slice(0, 10)})`).toBe(true);
    }
  });
});
