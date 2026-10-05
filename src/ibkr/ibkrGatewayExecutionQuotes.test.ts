import { describe, expect, it } from "vitest";
import { executionQuoteMaxAgeMs, shouldCaptureExecutionQuote } from "./ibkrGatewayExecutionQuotes.js";

describe("shouldCaptureExecutionQuote", () => {
  const now = new Date("2026-10-05T15:00:00Z");
  it("captures a fresh option or stock fill", () => {
    expect(shouldCaptureExecutionQuote("OPT", new Date(now.getTime() - 2_000), now)).toBe(true);
    expect(shouldCaptureExecutionQuote("STK", new Date(now.getTime() - executionQuoteMaxAgeMs), now)).toBe(true);
  });
  it("skips a replayed execution older than the limit: today's quote says nothing about it", () => {
    expect(shouldCaptureExecutionQuote("OPT", new Date(now.getTime() - executionQuoteMaxAgeMs - 1), now)).toBe(false);
  });
  it("skips a combo's BAG summary and anything without an execution time", () => {
    expect(shouldCaptureExecutionQuote("BAG", now, now)).toBe(false);
    expect(shouldCaptureExecutionQuote(undefined, now, now)).toBe(false);
    expect(shouldCaptureExecutionQuote("OPT", null, now)).toBe(false);
  });
});
