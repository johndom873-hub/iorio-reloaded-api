import { describe, expect, it } from "vitest";
import { closeGateVerdictFromState } from "./closeGate.js";
import type { CloseLiveState } from "./closeLiveState.js";

const base: CloseLiveState = { live: false, pending: false, blockReason: null, marketOpen: true, legQuotes: {}, cycleTotal: null };

describe("closeGateVerdictFromState", () => {
  it("allows a live state and passes the cycle total through", () => {
    expect(closeGateVerdictFromState({ ...base, live: true, cycleTotal: 123.4 })).toEqual({ blocked: false, reason: null, cycleTotal: 123.4 });
  });
  it("blocks with the derivation's own reason", () => {
    expect(closeGateVerdictFromState({ ...base, blockReason: "The market is closed right now." })).toEqual({ blocked: true, reason: "The market is closed right now.", cycleTotal: null });
  });
  it("still-waiting after the grace is a block, never a pass", () => {
    const verdict = closeGateVerdictFromState({ ...base, pending: true, blockReason: "Waiting for live quotes…" });
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe("Waiting for live quotes…");
  });
  it("never passes a non-live state without a reason", () => {
    expect(closeGateVerdictFromState(base).blocked).toBe(true);
    expect(closeGateVerdictFromState(base).reason).toMatch(/live quotes/);
  });
});
