import { describe, expect, it } from "vitest";
import { optionsStartBeforeStockPrices } from "./refreshFileStockBars.js";

describe("optionsStartBeforeStockPrices", () => {
  it("flags a file whose options start more than 14 days before IBKR's first daily bar", () => {
    // SPCX: the old ETF's options from 2021, SpaceX's stock prices from 12 June 2026.
    expect(optionsStartBeforeStockPrices("SPCX", "2021-01-12", "2026-06-12")).toMatch(/options start 2021-01-12 but IBKR's SPCX stock prices start 2026-06-12.*download it from 2026-06-12/);
    expect(optionsStartBeforeStockPrices("NEW", "2026-05-28", "2026-06-12")).not.toBeNull();
  });

  it("accepts options listed after the stock, a few days' gap in IBKR's history, and a stock older than its options", () => {
    // SpaceX's own options from 16 June, four days after its first bar.
    expect(optionsStartBeforeStockPrices("SPCX", "2026-06-16", "2026-06-12")).toBeNull();
    expect(optionsStartBeforeStockPrices("NEW", "2026-05-29", "2026-06-12")).toBeNull();
    expect(optionsStartBeforeStockPrices("HOOD", "2021-08-04", "2021-07-29")).toBeNull();
    expect(optionsStartBeforeStockPrices("AAPL", "2020-01-02", "2006-10-19")).toBeNull();
  });
});
