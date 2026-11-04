import { describe, expect, it } from "vitest";
import { portfolioWarningsOf, worstFallWithin, type WarningTickerInput } from "./portfolioWarnings.js";

const ticker = (overrides: Partial<WarningTickerInput>): WarningTickerInput => ({ symbol: "XLE", verdict: "suits", potDollars: 120_000, priceAsTraded: 90, ownHistoryYears: 26, backtestWorstSpyFall: -0.25, ...overrides });

describe("portfolioWarningsOf (W1–W6)", () => {
  it("raises nothing for a book with none of the mistakes", () => {
    expect(portfolioWarningsOf({ tickers: [ticker({})], groups: [], allocationTotalPct: 100 })).toEqual([]);
  });

  it("W1: a ticker v4 doesn't suit", () => {
    expect(portfolioWarningsOf({ tickers: [ticker({ symbol: "PFE", verdict: "doesnt_suit" })], groups: [], allocationTotalPct: 100 })[0]).toMatchObject({ code: "doesnt_suit", symbols: ["PFE"] });
  });

  it("W2: one lot over 80% of the pot", () => {
    // NVDA at $190: a lot of $19,000.50 is 83% of a $22,857 pot.
    const [warning] = portfolioWarningsOf({ tickers: [ticker({ symbol: "NVDA", priceAsTraded: 190, potDollars: 22_857 })], groups: [], allocationTotalPct: 100 });
    expect(warning).toMatchObject({ code: "lot_too_large", symbols: ["NVDA"] });
    expect(warning?.text).toContain("83%");
  });

  it("W3: a group over 30% of the book; a single ticker is no group", () => {
    const warnings = portfolioWarningsOf({ tickers: [], groups: [{ symbols: ["NVDA", "SMH", "AMD"], share: 0.31 }, { symbols: ["XLE"], share: 0.5 }], allocationTotalPct: 100 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "group_too_large", symbols: ["NVDA", "SMH", "AMD"] });
  });

  it("W4 and W5: under 5 years of history, and a backtest with no 20% SPY fall", () => {
    const warnings = portfolioWarningsOf({ tickers: [ticker({ symbol: "HOOD", ownHistoryYears: 4.9, backtestWorstSpyFall: -0.19 })], groups: [], allocationTotalPct: 100 });
    expect(warnings.map((warning) => warning.code)).toEqual(["short_history", "no_bear_market_in_backtest"]);
  });

  it("W6: allocations not adding up to 100%", () => {
    expect(portfolioWarningsOf({ tickers: [], groups: [], allocationTotalPct: 95 })[0]).toMatchObject({ code: "allocations_not_100" });
    // Within half a point of 100%: rounding of allocations typed to 2 decimals, not flagged.
    expect(portfolioWarningsOf({ tickers: [], groups: [], allocationTotalPct: 99.99 })).toEqual([]);
    expect(portfolioWarningsOf({ tickers: [], groups: [], allocationTotalPct: 100.49 })).toEqual([]);
    expect(portfolioWarningsOf({ tickers: [], groups: [], allocationTotalPct: 99.5 })[0]).toMatchObject({ code: "allocations_not_100", text: "The allocations add up to 99.50%, not 100%" });
  });
});

describe("worstFallWithin", () => {
  it("measures the worst fall from a peak inside the dates only", () => {
    const closes = [
      { tradingDate: "2021-12-31", close: 200 },
      { tradingDate: "2022-01-03", close: 100 },
      { tradingDate: "2022-06-01", close: 80 },
      { tradingDate: "2022-07-01", close: 90 },
    ];
    expect(worstFallWithin(closes, "2022-01-01", "2022-12-31")).toBeCloseTo(-0.2, 10);
  });
});
