import { describe, expect, it } from "vitest";
import { assessDailyBar, buildMarketDataFailureMessage } from "./marketDataJobOutcome.js";

describe("assessDailyBar", () => {
  it("accepts the expected session's bar", () => {
    expect(assessDailyBar("2026-09-30", "2026-09-30")).toBeNull();
  });

  it("flags no bar at all and a prior session's bar", () => {
    expect(assessDailyBar(null, "2026-09-30")).toBe("no daily bar returned");
    expect(assessDailyBar("2026-09-29", "2026-09-30")).toBe("latest bar is 2026-09-29, expected 2026-09-30");
  });
});

describe("buildMarketDataFailureMessage", () => {
  const clean = { tickerCount: 3, failed: [], missingIv: [], attempts: 1, bailedOnBudget: false };

  it("is undefined when every ticker has its bar and IV", () => {
    expect(buildMarketDataFailureMessage(clean)).toBeUndefined();
  });

  it("reports an empty ticker set", () => {
    expect(buildMarketDataFailureMessage({ ...clean, tickerCount: 0 })).toBe("no tickers to capture (shortlist and open positions are both empty)");
  });

  it("lists failed tickers with their reason and the retry outcome", () => {
    const message = buildMarketDataFailureMessage({ ...clean, failed: [{ symbol: "AAA", problem: "no daily bar returned" }, { symbol: "BBB", problem: "Historical data timeout for BBB" }], attempts: 5, bailedOnBudget: true });
    expect(message).toBe("2 of 3 tickers not captured after 5 attempt(s) (retries stopped on the time budget), AAA - no daily bar returned, BBB - Historical data timeout for BBB");
  });

  it("reports tickers with no IV even when every bar arrived", () => {
    expect(buildMarketDataFailureMessage({ ...clean, missingIv: [{ symbol: "NEW", problem: "no IV history bar" }] })).toBe("no implied volatility for NEW - no IV history bar");
  });

  it("never contains the '): ' sequence that truncates the Telegram alert", () => {
    expect(buildMarketDataFailureMessage({ ...clean, failed: [{ symbol: "AAA", problem: "x" }], missingIv: [{ symbol: "B", problem: "y" }] })).not.toContain("): ");
  });
});
