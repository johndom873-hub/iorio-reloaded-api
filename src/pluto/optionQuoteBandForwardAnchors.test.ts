import { describe, expect, it } from "vitest";
import type { OptionQuoteBandQuote } from "./optionQuoteBandQuotes.js";
import { forwardAnchorsFromBandQuotes } from "./optionQuoteBandForwardAnchors.js";

const clock = { todayIso: "2026-10-27", yearsToTodaysClose: 0.0005, riskFreeRate: 0.04 };
const at = (minute: number) => new Date(`2026-10-27T15:${String(minute).padStart(2, "0")}:00Z`);
const quote = (expiry: string, strike: number, right: "C" | "P", bid: number, ask: number, stockPrice: number, minute = 0, cycleNumber = 1): OptionQuoteBandQuote => ({ expiry, strike, right, bid, ask, stockPrice, errorCode: null, quotedAt: at(minute), cycleNumber });

describe("forwardAnchorsFromBandQuotes", () => {
  it("takes put-call parity where the band has a Call and a Put at a strike near the money", () => {
    // Call mid 3.00, Put mid 2.00 at $100, 24 days: forward = 100 + 1.00 × e^(rT).
    const anchors = forwardAnchorsFromBandQuotes([quote("2026-11-20", 100, "C", 2.95, 3.05, 100.5), quote("2026-11-20", 100, "P", 1.95, 2.05, 100.5)], clock);
    const years = 24 / 365.25;
    expect(anchors.get("2026-11-20")!.forward).toBeCloseTo(100 + 1 * Math.exp(0.04 * years), 2);
    expect(anchors.get("2026-11-20")!.spotPrice).toBe(100.5);
  });

  it("falls back to the stock price grown at the risk-free rate, anchored at the expiry's latest quote", () => {
    const anchors = forwardAnchorsFromBandQuotes([quote("2026-11-20", 110, "C", 0.5, 0.6, 100, 1), quote("2026-11-20", 90, "P", 0.4, 0.5, 101, 5)], clock);
    const anchor = anchors.get("2026-11-20")!;
    expect(anchor.spotPrice).toBe(101);
    expect(anchor.forward).toBeGreaterThan(101);
    expect(anchor.forward).toBeLessThan(101.5);
  });

  it("pairs only the expiry's newest cycle: a Call left from an earlier cycle, the stock elsewhere then, is not paired", () => {
    // Same-day expiry. Cycle 1 (stock 405): the $400 Call at 6.00. Cycle 40 (stock 399.97): the $400 Put at 2.50, the Call
    // no longer quoted. Paired, they would read 400 + 6.00 − 2.50 = 403.50; the newest cycle has no pair, so the forward is
    // the stock grown at the risk-free rate.
    const today = "2026-10-27";
    const anchors = forwardAnchorsFromBandQuotes([quote(today, 400, "C", 5.95, 6.05, 405, 1, 1), quote(today, 400, "P", 2.45, 2.55, 399.97, 30, 40), quote(today, 405, "C", 1.15, 1.25, 399.97, 30, 40)], clock);
    expect(anchors.get(today)!.forward).toBeCloseTo(399.97 * Math.exp(0.04 * 0.0005), 6);

    // Both quoted in the newest cycle: parity on them.
    const paired = forwardAnchorsFromBandQuotes([quote(today, 400, "C", 1.95, 2.05, 399.97, 30, 40), quote(today, 400, "P", 2.0, 2.1, 399.97, 30, 40)], clock);
    expect(paired.get(today)!.forward).toBeCloseTo(400 - 0.05 * Math.exp(0.04 * 0.0005), 6);
  });

  it("ignores expired contracts and quotes without a stock price", () => {
    const anchors = forwardAnchorsFromBandQuotes([quote("2026-10-24", 100, "C", 1, 1.1, 100), { ...quote("2026-11-20", 100, "C", 1, 1.1, 100), stockPrice: null }], clock);
    expect(anchors.size).toBe(0);
  });
});
