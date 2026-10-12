import { describe, expect, it } from "vitest";
import { estimateLlmSession, measuredSecondsPerClaudeCall } from "./estimateLlmSession.js";

describe("the LLM-mode estimate shown before a session starts", () => {
  it("one year of 12 looks a day: about 3,100 to 6,300 calls and 4 to 8 hours of model time", () => {
    const estimate = estimateLlmSession("2024-01-01", "2024-12-31", 12);
    expect(estimate.tradingDays).toBe(262);
    expect(estimate.callsLow).toBe(3144);
    expect(estimate.callsHigh).toBe(6288);
    expect(measuredSecondsPerClaudeCall).toBe(4.8);
    expect(estimate.modelHoursLow).toBe(4.2);
    expect(estimate.modelHoursHigh).toBe(8.4);
  });

  it("a single day is one look's worth per look", () => {
    expect(estimateLlmSession("2026-10-09", "2026-10-09", 12)).toEqual({ tradingDays: 1, callsLow: 12, callsHigh: 24, modelHoursLow: 0, modelHoursHigh: 0 });
  });
});
