import { describe, expect, it } from "vitest";
import { buildCalendarCaptureFailureMessage, selectAlertWorthyUnresolved } from "./calendarCaptureOutcome.js";

describe("buildCalendarCaptureFailureMessage", () => {
  it("is undefined when everything worked", () => {
    expect(buildCalendarCaptureFailureMessage({ tickerCount: 5, fetchFailures: [], unresolvedSymbols: [] })).toBeUndefined();
  });

  it("reports an empty ticker set", () => {
    expect(buildCalendarCaptureFailureMessage({ tickerCount: 0, fetchFailures: [], unresolvedSymbols: [] })).toContain("no tickers to capture");
  });

  it("reports each failed fetch and the unresolved tickers", () => {
    const message = buildCalendarCaptureFailureMessage({
      tickerCount: 5,
      fetchFailures: [
        { source: "earnings", message: "TradingView responded 429\nstack" },
        { source: "economic calendar", message: "timeout" },
      ],
      unresolvedSymbols: ["TLT", "DRAM"],
    });
    expect(message).toBe(
      "earnings fetch failed, existing rows are aging - TradingView responded 429; economic calendar fetch failed, existing rows are aging - timeout; no TradingView match or lookup error, so no earnings or dividend data for TLT, DRAM",
    );
  });

  it("never contains the '): ' sequence that truncates the Telegram alert", () => {
    expect(buildCalendarCaptureFailureMessage({ tickerCount: 1, fetchFailures: [{ source: "earnings", message: "x" }], unresolvedSymbols: ["A"] })).not.toContain("): ");
  });
});

describe("selectAlertWorthyUnresolved", () => {
  it("ignores an ETF with no TradingView match (normal), but not a stock or any failed lookup", () => {
    expect(
      selectAlertWorthyUnresolved([
        { symbol: "TLT", sector: "ETF", reason: "no_match" },
        { symbol: "SPY", sector: "ETF", reason: "lookup_error" },
        { symbol: "NEWCO", sector: "Technology", reason: "no_match" },
        { symbol: "UNKNOWN", sector: null, reason: "no_match" },
      ]),
    ).toEqual(["SPY", "NEWCO", "UNKNOWN"]);
  });
});
