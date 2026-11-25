import { describe, expect, it } from "vitest";
import { liveQuoteRetrySymbols, recordRoundOutcome, shouldRetryForcedRound, type RoundFailureState } from "./roundFailures.js";

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

describe("liveQuoteRetrySymbols", () => {
  it("retries a completed forced round's quote-blocked tickers once, the opening look's too, sorted and once each", () => {
    expect(liveQuoteRetrySymbols({ trigger: "settings_changed" }, "completed", ["RKLB"])).toEqual(["RKLB"]);
    expect(liveQuoteRetrySymbols({ trigger: "opening_analysis" }, "completed", ["SLV", "BE", "SLV"])).toEqual(["BE", "SLV"]);
  });

  it("never retries a retry, a round that held nothing back, or one that did not complete", () => {
    expect(liveQuoteRetrySymbols({ trigger: "live_quote_retry", retried: true }, "completed", ["RKLB"])).toEqual([]);
    expect(liveQuoteRetrySymbols({ trigger: "settings_changed", retried: true }, "completed", ["RKLB"])).toEqual([]);
    expect(liveQuoteRetrySymbols({ trigger: "settings_changed" }, "completed", [])).toEqual([]);
    expect(liveQuoteRetrySymbols({ trigger: "settings_changed" }, "failed", ["RKLB"])).toEqual([]);
    expect(liveQuoteRetrySymbols({ trigger: "settings_changed" }, "skipped_on_system_checks", ["RKLB"])).toEqual([]);
  });
});
