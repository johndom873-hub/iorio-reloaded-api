import { describe, expect, it } from "vitest";
import { heldValuesOf } from "./portfolioDayProjection.js";

describe("a buy and hold on a path", () => {
  it("holds each weight in shares from today's price, the rest in cash at the T-bill", () => {
    // $100,000: 60% in a $50 stock that closes at $55 then $44, 40% in cash at 2.52% (0.01% a day).
    const values = heldValuesOf([{ weight: 0.6, todaysPrice: 50, close: Float64Array.from([55, 44]), dividendYield: 0 }], 100_000, 2.52);
    expect(values[0]).toBe(100_000);
    expect(values[1]).toBeCloseTo(66_000 + 40_000 * 1.0001, 6);
    expect(values[2]).toBeCloseTo(52_800 + 40_000 * 1.0001 ** 2, 6);
  });

  it("credits the dividend yield ÷ 252 a day in cash on the shares' value at the previous close", () => {
    // 100% in a $100 stock yielding 2.52%: day 1 pays 0.01% of $100,000, day 2 0.01% of the $110,000 it closed day 1 at.
    const values = heldValuesOf([{ weight: 1, todaysPrice: 100, close: Float64Array.from([110, 110]), dividendYield: 0.0252 }], 100_000, 0);
    expect(values[1]).toBeCloseTo(110_000 + 10, 6);
    expect(values[2]).toBeCloseTo(110_000 + 10 + 11, 6);
  });
});
