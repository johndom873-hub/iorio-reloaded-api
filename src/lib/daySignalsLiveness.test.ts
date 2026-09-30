import { describe, expect, it } from "vitest";
import { daySignalsHeartbeatStaleAfterMs, daySignalsQuotesStaleAfterMs, evaluateDaySignalsLiveness } from "./daySignalsLiveness.js";

const now = new Date("2026-09-24T15:30:00Z");
const fresh = { updatedAt: new Date(now.getTime() - 60_000), connected: true, uptimeMs: 3 * 60_000 };
const quoteAgoMs = (ms: number) => new Date(now.getTime() - ms);

describe("evaluateDaySignalsLiveness", () => {
  it("expects nothing while the market is closed or today's pool is not seeded", () => {
    expect(evaluateDaySignalsLiveness({ now, marketOpen: false, poolSeededToday: true, heartbeat: null, latestQuoteAt: null })).toBeNull();
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: false, heartbeat: null, latestQuoteAt: null })).toBeNull();
  });

  it("is fine with a fresh, running heartbeat", () => {
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: fresh, latestQuoteAt: null })).toBeNull();
  });

  it("reports a missing, stale, or idle heartbeat while the loop should be running", () => {
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: null, latestQuoteAt: null })).toContain("never reported");
    const stale = { updatedAt: new Date(now.getTime() - daySignalsHeartbeatStaleAfterMs - 60_000), connected: true, uptimeMs: 3 * 60_000 };
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: stale, latestQuoteAt: null })).toContain("over 5 min old");
    expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: { ...fresh, connected: false }, latestQuoteAt: null })).toContain("idle");
  });

  describe("stale quotes while the heartbeat still beats", () => {
    const running = { updatedAt: new Date(now.getTime() - 30_000), connected: true, uptimeMs: 2 * 60 * 60_000 };

    it("is fine with a recent quote, and does not judge a loop that has only just started running", () => {
      expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: running, latestQuoteAt: quoteAgoMs(4 * 60_000) })).toBeNull();
      expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: { ...running, uptimeMs: 10 * 60_000 }, latestQuoteAt: null })).toBeNull();
    });

    it("reports a hung cycle: newest quote older than the limit, exactly at the limit is fine", () => {
      expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: running, latestQuoteAt: quoteAgoMs(daySignalsQuotesStaleAfterMs) })).toBeNull();
      expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: running, latestQuoteAt: quoteAgoMs(daySignalsQuotesStaleAfterMs + 60_000) })).toContain("over 15 min old");
    });

    it("reports a loop that has run a long time and saved nothing", () => {
      expect(evaluateDaySignalsLiveness({ now, marketOpen: true, poolSeededToday: true, heartbeat: running, latestQuoteAt: null })).toContain("saved no quote today");
    });
  });
});
