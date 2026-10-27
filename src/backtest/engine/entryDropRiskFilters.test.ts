import { describe, expect, it } from "vitest";
import { addCalendarDays } from "../../lib/calendarDays.js";
import { BacktestBarHistory, type StoredDailyBar } from "./backtestBarHistory.js";
import { entryDropRiskBlock, entryDropRiskBlockingLimits, extensionZ, ivRankBefore } from "./entryDropRiskFilters.js";

const closesOf = (values: number[]) => values.map((close) => ({ close }));

/** Daily bars from 2026-01-01, one a day, with these implied volatilities (null: none that day). */
function barsWithImpliedVolatility(values: (number | null)[]): BacktestBarHistory {
  const rows: StoredDailyBar[] = values.map((impliedVolatility, index) => ({ tradingDate: addCalendarDays("2026-01-01", index), open: 10, high: 10, low: 10, close: 10, volume: 1, impliedVolatility }));
  return new BacktestBarHistory(rows);
}

describe("extensionZ", () => {
  it("is (C ÷ A200 − 1) ÷ σ63: 199 closes at 100 and a last one at 121", () => {
    // A200 = (199 × 100 + 121) ÷ 200; of the last 63 log returns, 62 are 0 and one is ln 1.21 (sample deviation × √252).
    const jump = Math.log(1.21);
    const mean = jump / 63;
    const sigma63 = Math.sqrt(((62 * mean ** 2 + (jump - mean) ** 2) / 62) * 252);
    const expected = (121 / ((199 * 100 + 121) / 200) - 1) / sigma63;
    expect(extensionZ(closesOf([...Array(199).fill(100), 121]))).toBeCloseTo(expected, 12);
    expect(expected).toBeCloseTo(0.5475, 4);
  });

  it("reads only the last 200 closes, and is null with fewer or with no volatility", () => {
    const recent = [...Array(199).fill(100), 121];
    expect(extensionZ(closesOf([...Array(100).fill(1_000), ...recent]))).toBeCloseTo(extensionZ(closesOf(recent))!, 12);
    expect(extensionZ(closesOf(recent.slice(1)))).toBeNull();
    expect(extensionZ(closesOf(Array(250).fill(100)))).toBeNull();
  });
});

describe("ivRankBefore", () => {
  it("places the latest IV before the day in the range of the last 252 days that have one", () => {
    const bars = barsWithImpliedVolatility([0.4, 1.4, null, 1.2]);
    // Before 2026-01-05: 0.4, 1.4 and 1.2 (the null day skipped): (1.2 − 0.4) ÷ (1.4 − 0.4) × 100.
    expect(ivRankBefore(bars, "2026-01-05")).toBeCloseTo(80, 10);
    // Before 2026-01-04, 1.4 is the latest; before 2026-01-02 there is one IV only.
    expect(ivRankBefore(bars, "2026-01-04")).toBeCloseTo(100, 10);
    expect(ivRankBefore(bars, "2026-01-02")).toBeNull();
  });

  it("leaves out days beyond the last 252 with an IV", () => {
    // 48 old days at 5.0 (a spike), then 252 days from 0.2 to 0.6 ending at 0.5: only the 252 count.
    const recent = Array.from({ length: 252 }, (_, index) => (index === 0 ? 0.2 : index === 1 ? 0.6 : 0.5));
    const bars = barsWithImpliedVolatility([...Array(48).fill(5), ...recent]);
    expect(ivRankBefore(bars, "2027-01-01")).toBeCloseTo(75, 10);
  });
});

describe("entryDropRiskBlock", () => {
  const off = { entryExtensionFilter: "off", entryMaxExtensionZ: 1, entryIvRankFilter: "off", entryMaxIvRank: 80 } as const;

  it("blocks nothing with both filters off, whatever the measures", () => {
    expect(entryDropRiskBlock(off, { extensionZ: 3, ivRank: 100 })).toBeNull();
  });

  it("blocks at or above each limit that is on, and says why", () => {
    const extension = { ...off, entryExtensionFilter: "on" } as const;
    expect(entryDropRiskBlock(extension, { extensionZ: 0.99, ivRank: 100 })).toBeNull();
    expect(entryDropRiskBlock(extension, { extensionZ: 1, ivRank: null })).toBe("extension z 1.00 ≥ 1");
    const ivRank = { ...off, entryIvRankFilter: "on", entryMaxIvRank: 70 } as const;
    expect(entryDropRiskBlock(ivRank, { extensionZ: 5, ivRank: 69.9 })).toBeNull();
    expect(entryDropRiskBlock(ivRank, { extensionZ: null, ivRank: 70 })).toBe("IV Rank 70 ≥ 70");
    const both = { ...off, entryExtensionFilter: "on", entryIvRankFilter: "on" } as const;
    expect(entryDropRiskBlock(both, { extensionZ: 1.24, ivRank: 85 })).toBe("extension z 1.24 ≥ 1, IV Rank 85 ≥ 80");
    expect(entryDropRiskBlock(both, { extensionZ: 0.5, ivRank: 85 })).toBe("IV Rank 85 ≥ 80");
  });

  it("blocks nothing when a measure cannot be worked out (a short history)", () => {
    const both = { ...off, entryExtensionFilter: "on", entryIvRankFilter: "on" } as const;
    expect(entryDropRiskBlock(both, { extensionZ: null, ivRank: null })).toBeNull();
  });
});

describe("entryDropRiskBlockingLimits", () => {
  it("gives the limit of each filter that blocks, null for one that is off, below its limit or cannot be measured", () => {
    const off = { entryExtensionFilter: "off", entryMaxExtensionZ: 1, entryIvRankFilter: "off", entryMaxIvRank: 80 } as const;
    const both = { ...off, entryExtensionFilter: "on", entryIvRankFilter: "on" } as const;
    expect(entryDropRiskBlockingLimits(both, { extensionZ: 1.24, ivRank: 85 })).toEqual({ extensionZ: 1, ivRank: 80 });
    expect(entryDropRiskBlockingLimits(both, { extensionZ: 0.5, ivRank: 85 })).toEqual({ extensionZ: null, ivRank: 80 });
    expect(entryDropRiskBlockingLimits(both, { extensionZ: null, ivRank: null })).toEqual({ extensionZ: null, ivRank: null });
    expect(entryDropRiskBlockingLimits(off, { extensionZ: 3, ivRank: 100 })).toEqual({ extensionZ: null, ivRank: null });
  });
});
