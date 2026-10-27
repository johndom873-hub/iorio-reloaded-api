import { describe, expect, it } from "vitest";
import { evaluateMarketQuoteLoopLiveness, marketQuoteLoopHeartbeatStaleAfterMs } from "./marketQuoteLoopLiveness.js";

const now = new Date("2026-10-27T15:00:00Z");

describe("evaluateMarketQuoteLoopLiveness", () => {
  it("is quiet while the market is shut or the loop is disabled in this environment", () => {
    expect(evaluateMarketQuoteLoopLiveness({ now, marketOpen: false, loopEnabled: true, heartbeatUpdatedAt: null })).toBeNull();
    expect(evaluateMarketQuoteLoopLiveness({ now, marketOpen: true, loopEnabled: false, heartbeatUpdatedAt: null })).toBeNull();
  });

  it("reports a missing or stale heartbeat, and nothing for a fresh one", () => {
    expect(evaluateMarketQuoteLoopLiveness({ now, marketOpen: true, loopEnabled: true, heartbeatUpdatedAt: null })).toMatch(/never reported/);
    expect(evaluateMarketQuoteLoopLiveness({ now, marketOpen: true, loopEnabled: true, heartbeatUpdatedAt: new Date(now.getTime() - marketQuoteLoopHeartbeatStaleAfterMs - 1) })).toMatch(/not running/);
    expect(evaluateMarketQuoteLoopLiveness({ now, marketOpen: true, loopEnabled: true, heartbeatUpdatedAt: new Date(now.getTime() - 60_000) })).toBeNull();
  });
});
