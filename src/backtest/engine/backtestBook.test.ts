import { describe, expect, it } from "vitest";
import { computeInterestDollars, computeParityStockPrice, computeSaleFillPrice, type ParityQuote } from "./backtestBook.js";

describe("computeParityStockPrice", () => {
  // C − P = S − K·e^(−rT) at every strike, so each pair gives S back exactly.
  const stock = 100;
  const rate = 0.04;
  const years = 7 / 365;
  const pair = (expiry: string, strike: number, callMid: number, spread = 0.1): ParityQuote[] => {
    const putMid = callMid - stock + strike * Math.exp(-rate * years);
    return [
      { expiry, strike, right: "C", bid: callMid - spread / 2, ask: callMid + spread / 2 },
      { expiry, strike, right: "P", bid: putMid - spread / 2, ask: putMid + spread / 2 },
    ];
  };

  it("takes the median over the three strikes with the smallest call−put gap of the nearest expiry at least a day out", () => {
    const quotes = [...pair("2026-03-09", 100, 3), ...pair("2026-03-09", 95, 6), ...pair("2026-03-09", 105, 1), ...pair("2026-03-09", 80, 20.2), ...[{ expiry: "2026-03-02", strike: 100, right: "C" as const, bid: 50, ask: 51 }]];
    const result = computeParityStockPrice(quotes, "2026-03-02", rate, null)!;
    expect(result.expiry).toBe("2026-03-09");
    expect(result.strikes).toEqual([95, 100, 105]);
    expect(result.price).toBeCloseTo(stock, 8);
  });

  it("skips an expiry with fewer than three two-sided pairs when a later one has them", () => {
    const thinNearest: ParityQuote[] = [...pair("2026-03-06", 100, 2), { expiry: "2026-03-06", strike: 95, right: "C", bid: 0, ask: 5 }];
    const result = computeParityStockPrice([...thinNearest, ...pair("2026-03-09", 100, 3), ...pair("2026-03-09", 95, 6), ...pair("2026-03-09", 105, 1)], "2026-03-02", rate, null)!;
    expect(result.expiry).toBe("2026-03-09");
  });

  it("with a spread limit, ignores quotes wider than that share of their mid (the 10:00 price uses the fit's 50%)", () => {
    // The 100 strike is quoted 2.5 wide around a call mid of 3 (83% of the mid): without the limit it is one of the three.
    const quotes = [...pair("2026-03-09", 100, 3, 2.5), ...pair("2026-03-09", 95, 6), ...pair("2026-03-09", 105, 1), ...pair("2026-03-09", 110, 0.4, 0.1)];
    expect(computeParityStockPrice(quotes, "2026-03-02", rate, null)!.strikes).toEqual([95, 100, 105]);
    const limited = computeParityStockPrice(quotes, "2026-03-02", rate, 0.5)!;
    expect(limited.strikes).toEqual([95, 105, 110]);
    expect(limited.price).toBeCloseTo(stock, 8);
    expect(computeParityStockPrice(pair("2026-03-09", 100, 3, 2.5), "2026-03-02", rate, 0.5)).toBeNull();
  });

  it("is null without any two-sided call and put at one strike", () => {
    expect(computeParityStockPrice([{ expiry: "2026-03-09", strike: 100, right: "C", bid: 1, ask: 1.2 }], "2026-03-02", rate, null)).toBeNull();
  });
});

describe("fill and interest", () => {
  it("sells at the mid less the spread cost share of the half-spread", () => {
    // mid 1.10, half-spread 0.10, λ 0.5 → 1.05
    expect(computeSaleFillPrice(1.0, 1.2, 0.5)).toBeCloseTo(1.05, 12);
    expect(computeSaleFillPrice(1.0, 1.2, 0)).toBeCloseTo(1.1, 12);
  });

  it("credits interest on calendar days (FORMULAS.md example: $600,000 at 4.2% over a weekend = $207.12)", () => {
    expect(computeInterestDollars(600_000, 4.2, 3)).toBeCloseTo(207.12, 2);
  });
});
