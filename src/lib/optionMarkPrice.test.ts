import { describe, expect, it } from "vitest";
import { optionMarkPrice } from "./optionMarkPrice.js";

describe("optionMarkPrice", () => {
  it("is the bid/ask mid when both sides are positive, whatever the last trade", () => {
    expect(optionMarkPrice({ bid: 1.1, ask: 1.3, last: 0.9 })).toBeCloseTo(1.2, 10);
    expect(optionMarkPrice({ bid: 1.1, ask: 1.3, last: null })).toBeCloseTo(1.2, 10);
  });

  it("falls back to the last trade when a side is missing, zero or negative", () => {
    expect(optionMarkPrice({ bid: null, ask: 0.05, last: 0.03 })).toBe(0.03);
    expect(optionMarkPrice({ bid: 0, ask: 0.05, last: 0.03 })).toBe(0.03);
    expect(optionMarkPrice({ bid: 0.4, ask: -1, last: 0.45 })).toBe(0.45);
    expect(optionMarkPrice({ last: 2.5 })).toBe(2.5);
  });

  it("is null with neither a two-sided quote nor a last trade, so the caller keeps its stored fallback", () => {
    expect(optionMarkPrice({ bid: 0, ask: 0.05, last: null })).toBeNull();
    expect(optionMarkPrice({})).toBeNull();
  });
});
