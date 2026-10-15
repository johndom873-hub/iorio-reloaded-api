import { describe, expect, it } from "vitest";
import { effectiveAllocationPctBySymbol, validatePlutoTickerSettingsInput } from "./tickerSettingsStore.js";

describe("effectiveAllocationPctBySymbol", () => {
  it("splits the budget equally when no allocation is set", () => {
    const allocations = effectiveAllocationPctBySymbol([{ symbol: "A", allocationPct: null }, { symbol: "B", allocationPct: null }, { symbol: "C", allocationPct: null }, { symbol: "D", allocationPct: null }]);
    expect([...allocations.values()]).toEqual([25, 25, 25, 25]);
  });

  it("gives the tickers without an allocation an equal share of what the set ones leave (4 tickers, one at 40%)", () => {
    const allocations = effectiveAllocationPctBySymbol([{ symbol: "A", allocationPct: 40 }, { symbol: "B", allocationPct: null }, { symbol: "C", allocationPct: null }, { symbol: "D", allocationPct: null }]);
    expect(Object.fromEntries(allocations)).toEqual({ A: 40, B: 20, C: 20, D: 20 });
  });

  it("leaves 0% to the tickers without one when the set allocations take everything", () => {
    const allocations = effectiveAllocationPctBySymbol([{ symbol: "A", allocationPct: 60 }, { symbol: "B", allocationPct: 40 }, { symbol: "C", allocationPct: null }]);
    expect(allocations.get("C")).toBe(0);
  });

  it("leaves the rest of the budget unallocated when every ticker has an allocation", () => {
    const allocations = effectiveAllocationPctBySymbol([{ symbol: "A", allocationPct: 30 }, { symbol: "B", allocationPct: 20 }]);
    expect(Object.fromEntries(allocations)).toEqual({ A: 30, B: 20 });
  });

  it("returns nothing for no enabled tickers", () => {
    expect(effectiveAllocationPctBySymbol([]).size).toBe(0);
  });
});

describe("validatePlutoTickerSettingsInput", () => {
  it("accepts values in range and null (back to the default)", () => {
    expect(validatePlutoTickerSettingsInput({ allocationPct: 100, ladderSharesPct: 30, ladderShockOverridePct: null })).toBeNull();
  });

  it("refuses an unknown field, a non-number and values out of range", () => {
    expect(validatePlutoTickerSettingsInput({ maxAbsDelta: 0.3 })).toMatch(/not a ticker setting/);
    expect(validatePlutoTickerSettingsInput({ allocationPct: "20" })).toMatch(/must be a number/);
    expect(validatePlutoTickerSettingsInput({ allocationPct: 0 })).toMatch(/above 0/);
    expect(validatePlutoTickerSettingsInput({ allocationPct: 100.5 })).toMatch(/at most 100/);
    expect(validatePlutoTickerSettingsInput({ ladderSharesPct: 100 })).toMatch(/at most 99/);
    expect(validatePlutoTickerSettingsInput({ ladderShockOverridePct: Number.NaN })).toMatch(/must be a number/);
  });
});
