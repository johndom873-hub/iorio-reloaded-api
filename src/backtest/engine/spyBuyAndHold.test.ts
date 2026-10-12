import { describe, expect, it } from "vitest";
import { SpyBuyAndHold } from "./spyBuyAndHold.js";

describe("buy and hold of SPY", () => {
  it("buys whole shares at the first 10:00 price, keeps the rest in cash at the session's interest, and marks at 10:00", () => {
    const spy = new SpyBuyAndHold(1_000_000);
    // Day 1: 3,333 shares at 300.00 (999,900), 100 left in cash.
    expect(spy.markDay("2024-03-01", 300, null)).toEqual({ value: 1_000_000, exposureDollars: 999_900, interestDollars: 0 });
    expect(spy.purchase).toEqual({ dateIso: "2024-03-01", shares: 3_333, price: 300 });
    // Friday → Monday at 4%: 100 × 0.04 × 3 ÷ 365 of interest on the cash; the shares at 303.
    const monday = spy.markDay("2024-03-04", 303, { ratePercent: 4, calendarDays: 3 });
    const interest = (100 * 0.04 * 3) / 365;
    expect(monday.interestDollars).toBeCloseTo(interest, 12);
    expect(monday.exposureDollars).toBeCloseTo(3_333 * 303, 8);
    expect(monday.value).toBeCloseTo(100 + interest + 3_333 * 303, 8);
  });

  it("waits in cash until SPY has a price, and marks a day without one at the last price", () => {
    const spy = new SpyBuyAndHold(10_000);
    expect(spy.markDay("2024-03-01", null, null)).toEqual({ value: 10_000, exposureDollars: 0, interestDollars: 0 });
    expect(spy.purchase).toBeNull();
    expect(spy.daysMarkedAtAnEarlierPrice).toBe(0);
    spy.markDay("2024-03-04", 400, { ratePercent: 0, calendarDays: 3 });
    expect(spy.purchase).toEqual({ dateIso: "2024-03-04", shares: 25, price: 400 });
    expect(spy.markDay("2024-03-05", null, { ratePercent: 0, calendarDays: 1 })).toEqual({ value: 10_000, exposureDollars: 10_000, interestDollars: 0 });
    expect(spy.daysMarkedAtAnEarlierPrice).toBe(1);
  });
});
