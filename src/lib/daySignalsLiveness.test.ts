import { describe, expect, it } from "vitest";
import { daySignalsHeartbeatStaleAfterMs, evaluateDaySignalsLiveness } from "./daySignalsLiveness.js";

const now = new Date("2026-09-24T15:30:00Z");
const fresh = { updatedAt: new Date(now.getTime() - 60_000), connected: true };

describe("evaluateDaySignalsLiveness", () => {
  it("expects nothing while the market is closed or today's pool is not seeded", () => {
    expect(evaluateDaySignalsLiveness({ now, marketOpen: false, poolSeededToday: true, heartbeat: null })).toBeNull();
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: false, heartbeat: null })).toBeNull();
  });

  it("is fine with a fresh, running heartbeat", () => {
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: fresh })).toBeNull();
  });

  it("reports a missing, stale, or idle heartbeat while the loop should be running", () => {
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: null })).toContain("never reported");
    const stale = { updatedAt: new Date(now.getTime() - daySignalsHeartbeatStaleAfterMs - 60_000), connected: true };
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: stale })).toContain("6 min old");
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: { ...fresh, connected: false } })).toContain("idle");
  });
});
