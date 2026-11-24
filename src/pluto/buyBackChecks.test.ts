import { describe, expect, it } from "vitest";
import { symbolsDueForBuyBackCheck, volFarmerV4BuysBackToday } from "./buyBackChecks.js";

describe("symbolsDueForBuyBackCheck", () => {
  const nowMs = 1_000_000;
  const prices = new Map<string, number | null>([["TQQQ", 49.51], ["SLV", 39.4], ["IBIT", null]]);
  const due = (overrides: Partial<Parameters<typeof symbolsDueForBuyBackCheck>[0]> = {}) =>
    symbolsDueForBuyBackCheck({
      nowMs,
      calls: [{ symbol: "TQQQ", strike: 49.5 }, { symbol: "SLV", strike: 39.5 }, { symbol: "IBIT", strike: 36 }],
      stockPriceOf: (symbol) => prices.get(symbol) ?? null,
      lastCheckedAtMs: new Map(),
      symbolsWithWorkingOrders: new Set(),
      intervalMs: 5_000,
      ...overrides,
    });

  it("is due when the stock is at or above a Call's strike: TQQQ at 49.51 over its $49.50 Call, not SLV at 39.40 under $39.50, not IBIT with no price", () => {
    expect(due()).toEqual(["TQQQ"]);
    expect(due({ stockPriceOf: () => 49.5, calls: [{ symbol: "TQQQ", strike: 49.5 }] })).toEqual(["TQQQ"]);
  });

  it("waits the interval after a check, and skips a ticker with an order working", () => {
    expect(due({ lastCheckedAtMs: new Map([["TQQQ", nowMs - 3_000]]) })).toEqual([]);
    expect(due({ lastCheckedAtMs: new Map([["TQQQ", nowMs - 5_000]]) })).toEqual(["TQQQ"]);
    expect(due({ symbolsWithWorkingOrders: new Set(["TQQQ"]) })).toEqual([]);
  });

  it("names a ticker once with two Calls in the money", () => {
    expect(due({ calls: [{ symbol: "TQQQ", strike: 49 }, { symbol: "TQQQ", strike: 49.5 }] })).toEqual(["TQQQ"]);
  });
});

describe("volFarmerV4BuysBackToday", () => {
  it("every day under \"bought back\", before a weekend only under \"before weekends only\", never under \"assigned\"", () => {
    // Monday 23 Nov 2026, Tuesday the next session; Friday 27 Nov, Monday 30 Nov the next.
    expect(volFarmerV4BuysBackToday("bought_back", "2026-11-23", "2026-11-24")).toBe(true);
    expect(volFarmerV4BuysBackToday("bought_back_before_weekends", "2026-11-23", "2026-11-24")).toBe(false);
    expect(volFarmerV4BuysBackToday("bought_back_before_weekends", "2026-11-27", "2026-11-30")).toBe(true);
    expect(volFarmerV4BuysBackToday("assigned", "2026-11-27", "2026-11-30")).toBe(false);
  });
});
