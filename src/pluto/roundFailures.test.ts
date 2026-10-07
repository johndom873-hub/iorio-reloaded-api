import { describe, expect, it } from "vitest";
import { recordRoundOutcome, shouldRetryForcedRound, type RoundFailureState } from "./roundFailures.js";

const fresh: RoundFailureState = { consecutiveFailures: 0, alerted: false };

describe("recordRoundOutcome", () => {
  it("alerts once on the 3rd consecutive failure, not again on the 4th, and recovers once", () => {
    let state = fresh;
    const sends: (string | null)[] = [];
    for (const completed of [false, false, false, false, true, true]) {
      const next = recordRoundOutcome(state, completed);
      state = next.state;
      sends.push(next.send);
    }
    expect(sends).toEqual([null, null, "alert", null, "recovery", null]);
  });

  it("a completed round in between resets the count without a recovery message", () => {
    let state = recordRoundOutcome(recordRoundOutcome(fresh, false).state, false).state;
    const reset = recordRoundOutcome(state, true);
    expect(reset.send).toBeNull();
    state = reset.state;
    expect(recordRoundOutcome(recordRoundOutcome(state, false).state, false).send).toBeNull();
  });
});

describe("shouldRetryForcedRound", () => {
  it("retries a forced round once, never the opening look (housekeeping retries that)", () => {
    expect(shouldRetryForcedRound({ trigger: "settings_changed" })).toBe(true);
    expect(shouldRetryForcedRound({ trigger: "settings_changed", retried: true })).toBe(false);
    expect(shouldRetryForcedRound({ trigger: "opening_analysis" })).toBe(false);
  });
});
