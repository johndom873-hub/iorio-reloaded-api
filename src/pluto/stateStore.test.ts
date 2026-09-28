import { describe, expect, it } from "vitest";
import { describePlutoBlock, type PlutoState } from "./stateStore.js";

const base: PlutoState = { mode: "on", paused: false, pauseReason: null, pausedByUserId: null, pausedByDisplayName: null, pausedAt: null, lastSeenRelease: null, breakers: {}, lastPassAt: null, updatedAt: "2026-09-28T00:00:00.000Z" };

describe("describePlutoBlock", () => {
  it("allows only on + unpaused + no breakers", () => {
    expect(describePlutoBlock(base)).toBeNull();
  });
  it("off outranks everything", () => {
    expect(describePlutoBlock({ ...base, mode: "off", paused: true })).toBe("Pluto is off.");
  });
  it("a tripped breaker outranks a plain pause and names itself", () => {
    const state = { ...base, paused: true, pauseReason: "breaker:daily_loss", breakers: { daily_loss: { trippedAt: "2026-09-28T15:00:00Z", detail: "-2.3% on the day" } } };
    expect(describePlutoBlock(state)).toBe("Circuit breaker tripped: daily_loss (-2.3% on the day). Needs a human reset.");
  });
  it("a manual pause names who paused", () => {
    expect(describePlutoBlock({ ...base, paused: true, pauseReason: "manual", pausedByDisplayName: "Juan" })).toBe("Pluto is paused (manual by Juan).");
    expect(describePlutoBlock({ ...base, paused: true, pauseReason: "deploy" })).toBe("Pluto is paused (deploy).");
  });
});
