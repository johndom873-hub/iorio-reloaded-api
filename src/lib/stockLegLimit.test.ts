import { describe, expect, it } from "vitest";
import { stockLegLimitPrice } from "./stockLegLimit.js";

describe("stockLegLimitPrice", () => {
  it("uses the mid of a two-sided quote", () => {
    expect(stockLegLimitPrice({ bid: 193.5, ask: 193.7 }, 193.9)).toEqual({ price: 193.6, basis: "mid" });
  });
  it("accepts a locked market (bid equals ask)", () => {
    expect(stockLegLimitPrice({ bid: 100, ask: 100 }, 99)).toEqual({ price: 100, basis: "mid" });
  });
  it("falls back to the last price without a real two-sided quote", () => {
    expect(stockLegLimitPrice(null, 50)).toEqual({ price: 50, basis: "last" });
    expect(stockLegLimitPrice({ bid: null, ask: 51 }, 50)).toEqual({ price: 50, basis: "last" });
    expect(stockLegLimitPrice({ bid: 0, ask: 51 }, 50)).toEqual({ price: 50, basis: "last" });
    expect(stockLegLimitPrice({ bid: 52, ask: 51 }, 50)).toEqual({ price: 50, basis: "last" });
  });
});
