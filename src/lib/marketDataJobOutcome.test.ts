import { describe, expect, it } from "vitest";
import { assessDailyBar, buildMarketDataJobOutcome } from "./marketDataJobOutcome.js";

describe("assessDailyBar", () => {
  it("accepts the expected session's bar", () => {
    expect(assessDailyBar("2026-09-30", "2026-09-30")).toBeNull();
  });

  it("flags no bar at all and a prior session's bar", () => {
    expect(assessDailyBar(null, "2026-09-30")).toBe("no daily bar returned");
    expect(assessDailyBar("2026-09-29", "2026-09-30")).toBe("latest bar is 2026-09-29, expected 2026-09-30");
  });
});

describe("buildMarketDataJobOutcome", () => {
  const clean = { tickerCount: 3, failed: [], missingIv: [], attempts: 1, bailedOnBudget: false };

  it("is neither a failure nor completed with errors when every ticker has its bar and IV", () => {
    expect(buildMarketDataJobOutcome(clean)).toEqual({});
  });

  it("fails on an empty ticker set", () => {
    expect(buildMarketDataJobOutcome({ ...clean, tickerCount: 0 })).toEqual({ failureMessage: "no tickers to capture (shortlist and open positions are both empty)" });
  });

  it("completes with errors when some tickers were not captured, listing them with their reason and the retry outcome", () => {
    const outcome = buildMarketDataJobOutcome({ ...clean, failed: [{ symbol: "AAA", problem: "no daily bar returned" }, { symbol: "BBB", problem: "Historical data timeout for BBB" }], attempts: 5, bailedOnBudget: true });
    expect(outcome).toEqual({
      completedWithErrors: { errorCount: 2, message: "2 of 3 tickers not captured after 5 attempt(s) (retries stopped on the time budget), AAA - no daily bar returned, BBB - Historical data timeout for BBB; 1 of 3 tickers complete" },
    });
  });

  it("completes with errors when one ticker of 26 has no IV (staging 2026-10-13, TWST)", () => {
    expect(buildMarketDataJobOutcome({ ...clean, tickerCount: 26, missingIv: [{ symbol: "TWST", problem: "no IV in the snapshot" }] })).toEqual({
      completedWithErrors: { errorCount: 1, message: "no implied volatility for TWST - no IV in the snapshot; 25 of 26 tickers complete" },
    });
  });

  it("fails when no ticker is complete, counting both missing bars and missing IV", () => {
    const outcome = buildMarketDataJobOutcome({ ...clean, tickerCount: 2, failed: [{ symbol: "AAA", problem: "no daily bar returned" }], missingIv: [{ symbol: "BBB", problem: "no IV history bar" }] });
    expect(outcome).toEqual({ failureMessage: "1 of 2 tickers not captured after 1 attempt(s), AAA - no daily bar returned; no implied volatility for BBB - no IV history bar" });
  });

  it("never contains the '): ' sequence that truncates the Telegram alert", () => {
    const outcome = buildMarketDataJobOutcome({ ...clean, failed: [{ symbol: "AAA", problem: "x" }], missingIv: [{ symbol: "B", problem: "y" }] });
    expect(outcome.completedWithErrors?.message).not.toContain("): ");
  });
});
