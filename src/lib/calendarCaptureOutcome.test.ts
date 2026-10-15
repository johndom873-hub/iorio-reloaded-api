import { describe, expect, it } from "vitest";
import { buildCalendarCaptureJobOutcome, selectAlertWorthyUnresolved } from "./calendarCaptureOutcome.js";

describe("buildCalendarCaptureJobOutcome", () => {
  it("is empty when everything worked", () => {
    expect(buildCalendarCaptureJobOutcome({ tickerCount: 5, fetchFailures: [], unresolvedSymbols: [] })).toEqual({});
  });

  it("fails on an empty ticker set", () => {
    expect(buildCalendarCaptureJobOutcome({ tickerCount: 0, fetchFailures: [], unresolvedSymbols: [] }).failureMessage).toContain("no tickers to capture");
  });

  it("fails when the earnings fetch failed, reporting every failed fetch and the unresolved tickers", () => {
    expect(
      buildCalendarCaptureJobOutcome({
        tickerCount: 5,
        fetchFailures: [
          { source: "earnings", message: "TradingView responded 429\nstack" },
          { source: "economic calendar", message: "timeout" },
        ],
        unresolvedSymbols: ["TLT", "DRAM"],
      }),
    ).toEqual({
      failureMessage:
        "earnings fetch failed, existing rows are aging - TradingView responded 429; economic calendar fetch failed, existing rows are aging - timeout; no TradingView match or lookup error, so no earnings or dividend data for TLT, DRAM",
    });
  });

  it("completes with errors when only the dividends or a macro source failed, or tickers did not resolve", () => {
    expect(buildCalendarCaptureJobOutcome({ tickerCount: 5, fetchFailures: [{ source: "dividends", message: "timeout" }], unresolvedSymbols: ["DRAM"] })).toEqual({
      completedWithErrors: { errorCount: 2, message: "dividends fetch failed, existing rows are aging - timeout; no TradingView match or lookup error, so no earnings or dividend data for DRAM" },
    });
    expect(buildCalendarCaptureJobOutcome({ tickerCount: 5, fetchFailures: [], unresolvedSymbols: ["DRAM"] }).completedWithErrors!.errorCount).toBe(1);
  });

  it("never contains the '): ' sequence that truncates the Telegram alert", () => {
    expect(buildCalendarCaptureJobOutcome({ tickerCount: 1, fetchFailures: [{ source: "earnings", message: "x" }], unresolvedSymbols: ["A"] }).failureMessage).not.toContain("): ");
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
